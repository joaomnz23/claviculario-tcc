"""Sessão física (cartão no totem), reeds, porta, LEDs e estado das chaves."""
import os
from datetime import timedelta
from functools import wraps

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required
from sqlalchemy.exc import IntegrityError

from .auth import admin_required
from .extensions import db
from .models import AccessEvent, Key, KeyLoan, Reservation, User, utc_now
from .utils import fail, parse_datetime

bp = Blueprint("hardware", __name__)

SENSORS = ("1", "2", "3", "4")  # Key.sensor_id ligado a cada reed/LED
SOON = timedelta(minutes=60)    # reserva que "já vale" para o LED


class PhysicalSession(db.Model):
    __tablename__ = "physical_sessions"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    start_event_id = db.Column(db.String(100), nullable=False, unique=True)
    end_event_id = db.Column(db.String(100), unique=True)
    started_at = db.Column(db.DateTime, nullable=False)  # horário do ESP32
    ended_at = db.Column(db.DateTime, index=True)
    end_reason = db.Column(db.String(20))  # card, totem, timeout
    last_activity_at = db.Column(db.DateTime, nullable=False, default=utc_now)  # relógio do servidor
    mode = db.Column(db.String(10))  # withdraw, return
    selected_keys = db.Column(db.String(200), nullable=False, default="")
    door_open = db.Column(db.Boolean, nullable=False, default=False)
    user = db.relationship(User)

    def selected(self):
        return [int(item) for item in self.selected_keys.split(",") if item]


class ReedEvent(db.Model):
    __tablename__ = "reed_events"
    id = db.Column(db.Integer, primary_key=True)
    device_event_id = db.Column(db.String(100), nullable=False, unique=True)
    key_id = db.Column(db.Integer, db.ForeignKey("keys.id"), nullable=False, index=True)
    present = db.Column(db.Boolean, nullable=False)
    occurred_at = db.Column(db.DateTime, nullable=False)
    received_at = db.Column(db.DateTime, nullable=False, default=utc_now)
    session_id = db.Column(db.Integer, db.ForeignKey("physical_sessions.id"))
    unauthorized = db.Column(db.Boolean, nullable=False, default=False)
    key = db.relationship(Key)
    session = db.relationship(PhysicalSession)


# ---------- apoio ----------

def token_required(env_name, header):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            token = os.getenv(env_name)
            if not token or request.headers.get(header) != token:
                return fail("Não autorizado.", 401)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


device_required = token_required("DEVICE_TOKEN", "X-Device-Token")
terminal_required = token_required("TERMINAL_TOKEN", "X-Terminal-Token")


def iso(value):
    return value.isoformat() + "Z" if value else None


def timeout_seconds():
    return int(os.getenv("SESSION_TIMEOUT_SECONDS", "60"))


def finish(session, reason, when=None):
    session.ended_at = when or utc_now()
    session.end_reason = reason
    session.door_open = False


def active_session():
    """Devolve a sessão aberta, encerrando antes a que expirou."""
    session = (PhysicalSession.query.filter_by(ended_at=None)
               .order_by(PhysicalSession.id.desc()).first())
    if session:
        limit = session.last_activity_at + timedelta(seconds=timeout_seconds())
        if utc_now() >= limit:
            finish(session, "timeout", limit)
            db.session.commit()
            return None
    return session


def session_json(session):
    left = session.last_activity_at + timedelta(seconds=timeout_seconds()) - utc_now()
    return {"id": session.id, "user": {"id": session.user.id, "name": session.user.name},
            "started_at": iso(session.started_at), "mode": session.mode,
            "selected_key_ids": session.selected(),
            "door": "open" if session.door_open else "closed",
            "seconds_left": max(0, int(left.total_seconds()))}


def key_states(user_id=None):
    """Estado de cada chave ativa: presença, posse e reservas."""
    now = utc_now()
    result = []
    for key in Key.query.filter_by(active=True).order_by(Key.code).all():
        loan = KeyLoan.query.filter_by(key_id=key.id, returned_at=None).first()
        last = ReedEvent.query.filter_by(key_id=key.id).order_by(ReedEvent.id.desc()).first()
        # Sem leitura de reed ainda, a presença é deduzida do empréstimo.
        present = last.present if last else loan is None
        upcoming = (Reservation.query.filter(Reservation.key_id == key.id,
                                             Reservation.status == "confirmed",
                                             Reservation.ends_at > now)
                    .order_by(Reservation.starts_at).all())
        current = next((r for r in upcoming if r.starts_at <= now + SOON), None)
        mine = next((r for r in upcoming if r.user_id == user_id), None)
        shown = current or (upcoming[0] if upcoming else None)
        holder = None
        if loan:
            holder = {"user_id": loan.user_id, "name": loan.user.name, "since": iso(loan.checked_out_at)}
        result.append({
            "id": key.id, "code": key.code, "name": key.name, "sensor_id": key.sensor_id,
            "present": present, "holder": holder,
            "unauthorized": bool(not present and not loan and last and last.unauthorized),
            "available": present and not loan,
            "reservation": None if not shown else {
                "user_id": shown.user_id, "user_name": shown.user.name,
                "starts_at": iso(shown.starts_at), "ends_at": iso(shown.ends_at),
                "now": current is not None},
            "reserved_for_me": mine is not None,
            "my_reservation_now": current is not None and current.user_id == user_id,
            "reserved_by_other": current is not None and current.user_id != user_id,
        })
    return result


def leds(session):
    states = {s["sensor_id"]: s for s in key_states(session.user_id if session else None)}
    selected = session.selected() if session else []
    output = []
    for sensor in SENSORS:
        state = states.get(sensor)
        color, blink = "off", False
        if state:
            if not state["present"]:
                color = "red"
            elif state["reserved_by_other"]:
                color = "yellow"
            else:
                color = "green"
            blink = state["id"] in selected or state["my_reservation_now"]
        output.append({"sensor_id": sensor, "color": color, "blink": blink})
    return output


def read_device_event():
    """Valida event_id e occurred_at comuns às mensagens do ESP32."""
    data = request.get_json(silent=True) or {}
    event_id = str(data.get("event_id") or "")
    if not event_id or len(event_id) > 90:
        raise ValueError("Informe event_id (até 90 caracteres).")
    raw = data.get("occurred_at")
    if raw is not None and not isinstance(raw, str):
        raise ValueError("occurred_at deve ser texto ISO 8601.")
    return data, event_id, parse_datetime(raw) if raw else utc_now()


# ---------- ESP32 ----------

@bp.post("/api/device/card")
@device_required
def card():
    try:
        data, event_id, occurred = read_device_event()
    except ValueError as exc:
        return fail(str(exc))
    session = active_session()
    if PhysicalSession.query.filter((PhysicalSession.start_event_id == event_id) |
                                    (PhysicalSession.end_event_id == event_id)).first():
        return jsonify(duplicate=True, active=session is not None)
    uid = str(data.get("rfid_uid") or "").strip().upper()
    user = User.query.filter_by(rfid_uid=uid, active=True).first() if uid else None
    if not user:
        return fail("Cartão não cadastrado ou usuário inativo.", 404)
    if session:
        if session.user_id != user.id:
            return fail("Há uma sessão aberta com outro cartão.", 409)
        session.end_event_id = event_id
        finish(session, "card", occurred)
        db.session.commit()
        return jsonify(result="closed", active=False, door="closed")
    session = PhysicalSession(user_id=user.id, start_event_id=event_id, started_at=occurred)
    db.session.add(session)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify(duplicate=True, active=active_session() is not None)
    return jsonify(result="opened", active=True, door="closed", user_name=user.name), 201


@bp.get("/api/device/poll")
@device_required
def poll():
    session = active_session()
    return jsonify(active=session is not None,
                   door="open" if session and session.door_open else "closed",
                   leds=leds(session))


@bp.post("/api/device/reeds")
@device_required
def reeds():
    try:
        data, event_id, occurred = read_device_event()
    except ValueError as exc:
        return fail(str(exc))
    present = data.get("present")
    if not isinstance(present, bool):
        return fail("present deve ser true ou false.")
    if ReedEvent.query.filter_by(device_event_id=event_id).first():
        return jsonify(duplicate=True)
    key = Key.query.filter_by(sensor_id=str(data.get("sensor_id")), active=True).first()
    if not key:
        return fail("Nenhuma chave ativa com esse sensor_id.", 404)
    session = active_session()
    last = ReedEvent.query.filter_by(key_id=key.id).order_by(ReedEvent.id.desc()).first()
    if last and last.present == present:
        return jsonify(changed=False)
    loan = KeyLoan.query.filter_by(key_id=key.id, returned_at=None).with_for_update().first()
    event = ReedEvent(device_event_id=event_id, key_id=key.id, present=present,
                      occurred_at=occurred, session_id=session.id if session else None,
                      unauthorized=not present and not session and not loan)
    db.session.add(event)
    try:
        access = None
        # Com sessão: gera o evento de acesso e liga o empréstimo a quem está logado.
        if session and (not present or loan):
            session.last_activity_at = utc_now()
            access = AccessEvent(device_event_id=f"reed:{event_id}", user_id=session.user_id,
                                 action="return" if present else "withdraw", occurred_at=occurred)
            db.session.add(access)
            db.session.flush()
        elif session:
            session.last_activity_at = utc_now()
        if loan and (present or session):
            # Retirada com empréstimo ainda aberto: encerra o antigo e abre outro.
            loan.returned_at = occurred
            loan.return_event_id = access.id if access else None
        if not present and session:
            db.session.add(KeyLoan(key_id=key.id, user_id=session.user_id,
                                   checkout_event_id=access.id, checked_out_at=occurred))
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        if ReedEvent.query.filter_by(device_event_id=event_id).first():
            return jsonify(duplicate=True)
        return fail("Não foi possível registrar o evento.", 500)
    return jsonify(changed=True, key_id=key.id, present=present,
                   session_id=event.session_id, unauthorized=event.unauthorized), 201


# ---------- Totem ----------

def totem_payload(session):
    if not session:
        return jsonify(active=False)
    keys = key_states(session.user_id)
    keys.sort(key=lambda k: (not k["reserved_for_me"], k["code"]))
    return jsonify(active=True, session=session_json(session), keys=keys)


def with_session(fn):
    @wraps(fn)
    @terminal_required
    def wrapper():
        session = active_session()
        if not session:
            return fail("Nenhuma sessão ativa.", 409)
        data = request.get_json(silent=True) or {}
        # session_id opcional impede que uma tela antiga aja na sessão de outra pessoa.
        if data.get("session_id") not in (None, session.id):
            return fail("A sessão mudou.", 409)
        return fn(session, data)
    return wrapper


@bp.get("/api/totem/session")
@terminal_required
def totem_session():
    # Consultar não renova a sessão.
    return totem_payload(active_session())


@bp.post("/api/totem/mode")
@with_session
def totem_mode(session, data):
    mode = data.get("mode")
    if mode not in ("withdraw", "return"):
        return fail("mode deve ser 'withdraw' ou 'return'.")
    session.mode = mode
    session.selected_keys = ""
    # Devolver abre a porta na hora; retirar só abre no "pegar".
    session.door_open = mode == "return"
    session.last_activity_at = utc_now()
    db.session.commit()
    return totem_payload(session)


@bp.post("/api/totem/take")
@with_session
def totem_take(session, data):
    ids = data.get("key_ids")
    if not isinstance(ids, list) or not ids or not all(type(i) is int for i in ids):
        return fail("key_ids deve ser uma lista de números.")
    available = {k["id"] for k in key_states(session.user_id) if k["available"]}
    if not set(ids) <= available:
        return fail("Há chave inexistente ou que não está no claviculário.", 409)
    session.mode = "withdraw"
    session.selected_keys = ",".join(str(i) for i in sorted(set(ids)))
    session.door_open = True
    session.last_activity_at = utc_now()
    db.session.commit()
    return totem_payload(session)


@bp.post("/api/totem/activity")
@with_session
def totem_activity(session, data):
    session.last_activity_at = utc_now()
    db.session.commit()
    return jsonify(session=session_json(session))


@bp.post("/api/totem/end")
@with_session
def totem_end(session, data):
    finish(session, "totem")
    db.session.commit()
    return jsonify(active=False)


# ---------- Site / dashboard ----------

@bp.get("/api/keys/status")
@jwt_required()
def keys_status():
    return jsonify(keys=key_states(int(get_jwt_identity())))


@bp.get("/api/reed-events")
@admin_required
def reed_history():
    limit = min(max(request.args.get("limit", 100, type=int), 1), 500)
    events = ReedEvent.query.order_by(ReedEvent.id.desc()).limit(limit).all()
    return jsonify(events=[{
        "id": e.id, "key_id": e.key_id, "key_code": e.key.code, "present": e.present,
        "occurred_at": iso(e.occurred_at), "unauthorized": e.unauthorized,
        "session_id": e.session_id,
        "user_name": e.session.user.name if e.session else None} for e in events])