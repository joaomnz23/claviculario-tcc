// A API roda no mesmo computador que serve esta página (porta 5000).
const API = `${location.protocol}//${location.hostname}:5000`;
const $ = selector => document.querySelector(selector);

let token = readToken();
let state = null;            // última resposta de /api/totem/session
let selected = new Set();    // carrinho
let returning = new Set();   // chaves que estavam com a pessoa durante a devolução
let rendered = '';
let version = 0;             // descarta respostas de consultas antigas
let busy = false;
let lastActivity = 0;
let messageTimer;

function readToken() {
    try { return localStorage.getItem('claviculario-terminal') || ''; } catch { return ''; }
}
function saveToken(value) {
    token = value;
    try { localStorage.setItem('claviculario-terminal', value); } catch { /* vale só até recarregar */ }
}
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function time(value) {
    return new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function api(path, body) {
    const response = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Terminal-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `Erro ${response.status}`), { status: response.status });
    return result;
}

function showMessage(text) {
    const box = $('#message');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

function apply(next) {
    // Sessão encerrada ou trocada: recarrega para não sobrar nada da pessoa anterior.
    if (state?.active && (!next.active || next.session.id !== state.session.id)) return location.reload();
    state = next;
    render();
}

async function refresh() {
    if (!token) return renderSetup();
    if (busy) return;
    const mine = ++version;
    try {
        const next = await api('/api/totem/session');
        if (mine !== version) return;
        $('#offline').hidden = true;
        apply(next);
    } catch (error) {
        if (mine !== version) return;
        if (error.status === 401) { saveToken(''); renderSetup('Token recusado pelo servidor.'); }
        else $('#offline').hidden = false;
    }
}

async function send(path, data = {}) {
    if (busy || !state?.active) return;
    busy = true;
    version++;
    try {
        const next = await api(path, { ...data, session_id: state.session.id });
        if (path === '/api/totem/end') return location.reload();
        apply(next);
    } catch (error) {
        showMessage(error.status ? error.message : 'Sem conexão com o servidor.');
    } finally {
        busy = false;
    }
}

function renderSetup(error = '') {
    if ($('#setup')) return;
    rendered = '';
    $('#screen').innerHTML = `<div class="center"><h1>Configurar totem</h1><p>${esc(error || 'Digite o token do terminal (TERMINAL_TOKEN).')}</p><form id="setup"><input id="tokenInput" type="password" required autocomplete="off" aria-label="Token do terminal"><button class="primary">Salvar</button></form></div>`;
}

function reservationText(key) {
    const r = key.reservation;
    if (!r) return '';
    const who = r.user_id === state.session.user.id ? 'você' : r.user_name;
    return `Reservada por ${who}: ${time(r.starts_at)} a ${time(r.ends_at)}`;
}

function keyCard(key, { tag = 'div', cls = '', status, tone = '', attrs = '' }) {
    return `<${tag} class="key ${cls}" ${attrs}><b>${esc(key.code)}</b><span>${esc(key.name)}</span><span>${esc(reservationText(key))}</span><em class="${tone}">${esc(status)}</em></${tag}>`;
}

function withdrawCard(key) {
    const chosen = selected.has(key.id);
    let status = 'Disponível', tone = 'ok';
    if (!key.available) {
        status = key.holder ? `Com ${key.holder.name} desde ${time(key.holder.since)}` : 'Fora do claviculário';
        tone = 'bad';
    } else if (key.reserved_by_other) { status = 'Reservada por outra pessoa'; tone = 'warn'; }
    else if (key.my_reservation_now) status = 'Sua reserva';
    if (chosen) status = '✓ Selecionada';
    return keyCard(key, {
        tag: 'button', cls: chosen ? 'selected' : '', status, tone,
        attrs: `data-key="${key.id}" aria-pressed="${chosen}" ${key.available ? '' : 'disabled'}`
    });
}

const head = (title, text) => `<div class="head"><h1>${title}</h1><p>${text}</p></div>`;
const END = '<button data-action="end">Encerrar</button>';

function view() {
    const { session, keys } = state;
    const me = session.user.id;

    if (!session.mode) {
        return `<div class="center"><h1>O que você quer fazer?</h1><div class="choices"><button class="primary" data-mode="withdraw">Retirar<small>Pegar chaves</small></button><button data-mode="return">Devolver<small>Guardar chaves</small></button></div></div><div class="actions">${END}</div>`;
    }

    if (session.mode === 'return') {
        keys.filter(k => k.holder?.user_id === me).forEach(k => returning.add(k.id));
        const cards = keys.filter(k => returning.has(k.id)).map(k => keyCard(k, k.present
            ? { cls: 'done', status: '✓ Devolvida', tone: 'ok' }
            : { status: 'Coloque no claviculário', tone: 'warn' }));
        return head('Porta aberta: devolva suas chaves', cards.length ? 'Coloque cada chave no lugar.' : 'Não há chaves registradas no seu nome. Se estiver com alguma, coloque no lugar.')
            + `<div class="grid">${cards.join('')}</div><div class="actions"><button data-mode="withdraw">Retirar chaves</button>${END}</div>`;
    }

    if (session.door === 'open') {
        const wanted = session.selected_key_ids;
        const cards = keys.filter(k => wanted.includes(k.id) || k.holder?.user_id === me).map(k => {
            const asked = wanted.includes(k.id);
            if (!k.present) return keyCard(k, { cls: asked ? 'done' : '', status: asked ? '✓ Retirada' : 'Retirada (não estava selecionada)', tone: asked ? 'ok' : 'warn' });
            return keyCard(k, asked ? { cls: 'selected', status: 'Pegue esta chave', tone: 'warn' } : { status: 'No claviculário' });
        });
        return head('Porta aberta: pegue suas chaves', 'Ao terminar, toque em Encerrar ou passe o cartão.')
            + `<div class="grid">${cards.join('')}</div><div class="actions"><button data-mode="withdraw">Escolher outras</button><button data-mode="return">Devolver</button>${END}</div>`;
    }

    // Remove do carrinho o que deixou de estar disponível.
    selected = new Set([...selected].filter(id => keys.some(k => k.id === id && k.available)));
    const count = selected.size;
    return head('Escolha as chaves', 'Toque para selecionar uma ou mais.')
        + `<div class="grid">${keys.map(withdrawCard).join('') || '<p>Nenhuma chave cadastrada.</p>'}</div><div class="actions"><button data-mode="return">Devolver</button>${END}<button class="primary" data-action="take" ${count ? '' : 'disabled'}>Pegar${count ? ` (${count})` : ''}</button></div>`;
}

function render() {
    const active = state.active;
    document.body.classList.toggle('idle', !active);
    $('#user').textContent = active ? state.session.user.name : '';
    const left = active ? state.session.seconds_left : 99;
    $('#countdown').hidden = left > 15;
    if (left <= 15) $('#countdown').innerHTML = `<span>Sessão encerrando em</span><b>${left}</b><span>Toque para continuar</span>`;
    const html = active ? view() : '<div class="center"><div class="pulse"></div><h1>Aproxime seu cartão</h1><p>Aguardando leitura</p></div>';
    // Só redesenha quando algo muda, para não perder a rolagem nem toques.
    if (html !== rendered) { $('#screen').innerHTML = html; rendered = html; }
}

function activity() {
    if (!state?.active || busy || Date.now() - lastActivity < 3000) return;
    lastActivity = Date.now();
    api('/api/totem/activity', { session_id: state.session.id }).catch(() => { });
}

document.addEventListener('pointerdown', activity);
document.addEventListener('scroll', activity, true);
$('#countdown').addEventListener('click', () => { $('#countdown').hidden = true; lastActivity = 0; activity(); });
document.addEventListener('submit', event => {
    event.preventDefault();
    saveToken($('#tokenInput').value.trim());
    $('#screen').innerHTML = '';
    refresh();
});
document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !state?.active) return;
    const { mode, action, key } = button.dataset;
    if (key) {
        const id = Number(key);
        if (!selected.delete(id)) selected.add(id);
        render();
    } else if (mode) {
        selected.clear();
        send('/api/totem/mode', { mode });
    } else if (action === 'take') send('/api/totem/take', { key_ids: [...selected] });
    else if (action === 'end') send('/api/totem/end');
});
document.addEventListener('contextmenu', event => event.preventDefault());

(async function loop() {
    await refresh();
    setTimeout(loop, 1000);
})();