const API_BASE = (window.API_BASE_URL || '').trim().replace(/\/$/, '');
const $ = selector => document.querySelector(selector);
const token = sessionStorage.getItem('claviculario-token');
let currentUser;
try { currentUser = JSON.parse(sessionStorage.getItem('claviculario-user') || 'null'); } catch { currentUser = null; }
if (!token || !currentUser) window.location.replace('login.html');

let keys = [];
let keyStates = [];
let reedEvents = [];
let allLoans = [];
let lastSnapshot = '';
let refreshing = false;
let reservations = [];
let loans = [];
let users = [];
let usersLoaded = false;
let usersLoading = false;
let usersError = '';
let page = 'available';
if (currentUser && currentUser.role === 'admin' && location.hash === '#painel') page = 'dashboard';
let query = '';
let reserveFilter = 'all';
let dataLoaded = false;
const content = $('#content');

async function api(path, options = {}) {
  if (!API_BASE) throw new Error('Configure a URL pública da API em api-config.js.');
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    const method = options.method || 'GET';
    throw new Error(`Falha na chamada ${method} ${path}. A API pode estar online, mas a rota não foi implantada ou o CORS não permite esse método.`);
  }
  if (response.status === 401) {
    sessionStorage.removeItem('claviculario-token');
    sessionStorage.removeItem('claviculario-user');
    window.location.replace('login.html');
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Erro da API (${response.status}).`);
  return body;
}

async function refreshData(silent = false) {
  if (refreshing) return;
  refreshing = true;
  if (!silent) {
    $('#apiStatus').textContent = 'Sincronizando…';
    $('#apiStatus').dataset.state = 'loading';
  }
  try {
    const adminCalls = currentUser.role === 'admin' ? [api('/api/reed-events?limit=100'), api('/api/loans?active=false')] : [];
    const [keyData, statusData, reservationData, loanData, reedData, allLoanData] = await Promise.all([
      api('/api/keys'),
      api('/api/keys/status'),
      api(`/api/reservations?from=${encodeURIComponent(new Date().toISOString())}`),
      api('/api/loans?active=true'),
      ...adminCalls,
    ]);
    const snapshot = JSON.stringify([keyData, statusData, reservationData, loanData, reedData, allLoanData]);
    const changed = snapshot !== lastSnapshot || !dataLoaded;
    lastSnapshot = snapshot;
    keys = keyData.keys || [];
    keyStates = statusData.keys || [];
    reservations = reservationData.reservations || [];
    loans = loanData.loans || [];
    reedEvents = reedData ? reedData.events || [] : [];
    allLoans = allLoanData ? allLoanData.loans || [] : [];
    dataLoaded = true;
    $('#apiStatus').textContent = 'API conectada';
    $('#apiStatus').dataset.state = 'connected';
    // Na atualização automática só redesenha se algo mudou e se a tela não tem formulário aberto.
    if (!silent || (changed && !['users', 'settings'].includes(page))) render();
  } catch (error) {
    $('#apiStatus').textContent = 'Sem conexão';
    $('#apiStatus').dataset.state = 'offline';
    if (!silent || !dataLoaded) showError(error.message);
  } finally {
    refreshing = false;
  }
}
setInterval(() => { if (!document.hidden && token) refreshData(true); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) refreshData(true); });

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').textContent = theme === 'dark' ? '☾' : '☼';
  $('#themeToggle').setAttribute('aria-label', theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro');
  try { localStorage.setItem('senai-theme', theme); } catch { /* O tema segue ativo nesta página. */ }
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('senai-theme') || 'light'; } catch { /* Usa tema claro. */ }
setTheme(savedTheme);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function keyCode(key) { return key.code || String(key.id).padStart(3, '0'); }
function keyName(key) { return key.name || key.description || 'Local não informado'; }
function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
function localDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function pageHead(title, description, meta = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${meta ? `<span class="head-meta">${meta}</span>` : ''}</div>`;
}
function emptyState(icon, title, message) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${title}</strong><p>${message}</p></div>`;
}
function searchToolbar(placeholder, extra = '') {
  return `<div class="toolbar"><div class="search-wrap"><span class="search-icon">⌕</span><input id="searchInput" class="search-input" value="${esc(query)}" placeholder="${placeholder}" autocomplete="off" aria-label="Pesquisar"></div>${extra}</div>`;
}
function shortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
function keyStateInfo(key) {
  const res = key.reservation;
  const reserved = res ? `${res.user_id === currentUser.id ? 'você' : esc(res.user_name)} · ${shortTime(res.starts_at)} até ${shortTime(res.ends_at)}` : '';
  if (key.holder) {
    const extra = res ? `<br>Reserva: ${reserved}` : '';
    return { label: 'Com alguém', cls: 'taken', info: `Com ${esc(key.holder.name)} desde ${shortTime(key.holder.since)}${extra}` };
  }
  if (key.unauthorized) return { label: 'Retirada sem autorização', cls: 'alert', info: 'Chave fora do claviculário sem registro de retirada.' };
  if (!key.present) return { label: 'Ausente', cls: 'taken', info: res ? `Reserva: ${reserved}` : 'Chave fora do claviculário.' };
  if (res && res.now) return { label: 'Reservada', cls: 'reserved', info: `Reservada por ${reserved}` };
  if (res) return { label: 'Disponível', cls: '', info: `Próxima reserva: ${reserved}` };
  return { label: 'Disponível', cls: '', info: '' };
}
function keyCard(key) {
  const state = keyStateInfo(key);
  return `<article class="key-card"><div class="card-top"><div class="key-icon">⚿</div><span class="status ${state.cls}">${state.label}</span></div><div class="key-number">Chave ${esc(keyCode(key))}</div><div class="key-room">${esc(keyName(key))}</div>${state.info ? `<div class="key-info">${state.info}</div>` : ''}<div class="card-bottom"><span class="card-note">Atualiza sozinho</span><button class="btn btn-primary btn-small" data-action="pick-key" data-id="${key.id}">Reservar</button></div></article>`;
}
function renderAvailable() {
  const list = keyStates.filter(key => `${keyCode(key)} ${keyName(key)}`.toLowerCase().includes(query.toLowerCase()));
  const free = keyStates.filter(isFree).length;
  return `${pageHead('Chaves', 'Estado real de cada chave. Selecione uma para reservar', `${free} disponíveis de ${keyStates.length}`)}${searchToolbar('Buscar por código ou local')}<div class="key-grid">${list.length ? list.map(keyCard).join('') : emptyState('⚿', 'Nenhuma chave encontrada', 'Ajuste a busca ou atualize os dados.')}</div>`;
}
function isFree(key) { return key.available && !(key.reservation && key.reservation.now); }
function renderKeyManagement() {
  const list = keys.filter(key => `${keyCode(key)} ${keyName(key)} ${key.sensor_id || ''}`.toLowerCase().includes(query.toLowerCase()));
  const createButton = '<button class="btn btn-primary" data-action="create-key">＋ Nova chave</button>';
  const cards = list.map(key => {
    const available = key.available;
    return `<article class="key-card"><div class="card-top"><div class="key-icon">⚿</div><span class="status ${available ? '' : 'taken'}">${available ? 'Disponível' : 'Retirada'}</span></div><div class="key-number">Chave ${esc(keyCode(key))}</div><div class="key-room">${esc(keyName(key))}</div><div class="key-room key-sensor">${key.sensor_id ? `Sensor: ${esc(key.sensor_id)}` : 'Sem sensor associado'}</div><div class="card-bottom key-admin-bottom"><span class="card-note">ID ${esc(key.id)}</span><div class="key-admin-actions"><button class="btn btn-secondary btn-small" data-action="edit-key" data-id="${key.id}">Editar</button><button class="btn btn-secondary btn-small" data-action="deactivate-key" data-id="${key.id}">Desativar</button></div></div></article>`;
  });
  return `${pageHead('Gerenciar chaves', 'Inventário cadastrado na API', `${list.length} chaves`)}${searchToolbar('Buscar por código, local ou sensor', createButton)}<div class="key-grid">${cards.length ? cards.join('') : emptyState('⚿', 'Nenhuma chave cadastrada', 'Use “Nova chave” para adicionar a primeira chave.')}</div>`;
}
function renderDashboard() {
  const free = keyStates.filter(isFree).length;
  const reservedNow = keyStates.filter(key => key.reservation && key.reservation.now && !key.holder).length;
  const taken = keyStates.filter(key => key.holder).length;
  const alertKeys = keyStates.filter(key => key.unauthorized);
  const alertEvents = reedEvents.filter(event => event.unauthorized && !event.present).slice(0, 15);
  const stat = (label, value, cls = '') => `<div class="stat-card ${cls}"><span>${label}</span><strong>${value}</strong></div>`;
  const alerts = alertEvents.length ? alertEvents.map(event => {
    const still = alertKeys.some(key => key.id === event.key_id);
    return `<div class="alert-row"><span class="status alert">${still ? 'Ainda fora' : 'Alerta'}</span><div><strong>Chave ${esc(event.key_code)} retirada sem autorização</strong><span>${dateTime(event.occurred_at)}${still ? '' : ' · já devolvida'}</span></div></div>`;
  }).join('') : '<p class="muted-line">Nenhuma retirada sem autorização registrada.</p>';
  const stateRows = keyStates.map(key => {
    const state = keyStateInfo(key);
    return `<tr><td><strong>${esc(keyCode(key))}</strong></td><td>${esc(keyName(key))}</td><td><span class="status ${state.cls}">${state.label}</span></td><td>${state.info || '—'}</td></tr>`;
  }).join('');
  const loanRows = allLoans.slice(0, 50).map(loan => `<tr><td><strong>${esc(loan.key_code)}</strong></td><td>${esc(loan.user_name)}</td><td>${dateTime(loan.checked_out_at)}</td><td>${loan.returned_at ? dateTime(loan.returned_at) : '<span class="status taken">Em uso</span>'}</td></tr>`).join('');
  const reedRows = reedEvents.slice(0, 30).map(event => `<tr><td>${dateTime(event.occurred_at)}</td><td><strong>${esc(event.key_code)}</strong></td><td>${event.present ? 'Chave devolvida' : 'Chave retirada'}</td><td>${event.unauthorized ? '<span class="status alert">Sem autorização</span>' : esc(event.user_name || '—')}</td></tr>`).join('');
  const table = (head, rows, empty) => rows ? `<div class="table-wrap"><table class="data-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted-line">${empty}</p>`;
  return `${pageHead('Painel do administrador', 'Estado em tempo real, histórico e alertas', 'Atualiza a cada 5 s')}<div class="stat-grid">${stat('Disponíveis', free, 'ok')}${stat('Reservadas agora', reservedNow, 'warn')}${stat('Com alguém', taken)}${stat('Alertas ativos', alertKeys.length, alertKeys.length ? 'bad' : '')}</div><section class="settings-card dash-section"><h2>Alertas de retirada sem autorização</h2>${alerts}</section><section class="settings-card dash-section"><h2>Estado das chaves</h2>${table(['Chave', 'Local', 'Estado', 'Detalhes'], stateRows, 'Nenhuma chave cadastrada.')}</section><section class="settings-card dash-section"><h2>Retiradas e devoluções</h2>${table(['Chave', 'Pessoa', 'Retirada', 'Devolução'], loanRows, 'Nenhuma retirada registrada ainda.')}</section><section class="settings-card dash-section"><h2>Eventos dos sensores</h2>${table(['Horário', 'Chave', 'Evento', 'Responsável'], reedRows, 'Nenhum evento de sensor registrado ainda.')}</section>`;
}
function renderUsers() {
  const count = usersLoaded && !usersError ? `${users.length} cadastrados` : '';
  return `${pageHead('Usuários', 'Cadastre e consulte as contas do sistema', count)}<div class="users-page"><form class="admin-form settings-card" id="createUserForm"><h2>Novo usuário</h2><p>A senha precisa ter pelo menos 8 caracteres.</p><div class="admin-form-grid"><div><label class="form-label" for="newUserName">Nome completo</label><input class="search-input modal-input" id="newUserName" name="name" autocomplete="name" maxlength="120" required></div><div><label class="form-label" for="newUserEmail">E-mail</label><input class="search-input modal-input" id="newUserEmail" name="email" type="email" autocomplete="email" maxlength="255" required></div><div><label class="form-label" for="newUserPassword">Senha</label><input class="search-input modal-input" id="newUserPassword" name="password" type="password" minlength="8" autocomplete="new-password" required></div><div><label class="form-label" for="newUserRole">Permissão</label><select class="select-control" id="newUserRole" name="role"><option value="user">Usuário</option><option value="admin">Administrador</option></select></div><div class="admin-form-wide"><label class="form-label" for="newUserRfid">UID do cartão RFID (opcional)</label><input class="search-input modal-input" id="newUserRfid" name="rfid_uid" maxlength="64" placeholder="Ex.: 04A1B2C3D4"></div></div><div class="admin-form-actions"><button class="btn btn-primary" type="submit">Cadastrar usuário</button></div><p class="form-feedback" id="userFormFeedback" aria-live="polite"></p></form><section class="user-list-section"><div class="user-list-heading"><div><h2>Usuários cadastrados</h2><p>Contas registradas na API</p></div><button class="btn btn-secondary btn-small" data-action="refresh-users">Atualizar lista</button></div><div class="user-list-grid">${renderUserList()}</div></section></div>`;
}
function renderUserList() {
  if (usersLoading && !usersLoaded) return emptyState('♙', 'Carregando usuários', 'Consultando a lista na API…');
  if (usersError) return `<div class="user-list-error"><p>${esc(usersError)}</p><button class="btn btn-secondary btn-small" data-action="refresh-users">Tentar novamente</button></div>`;
  if (!users.length) return emptyState('♙', 'Nenhum usuário cadastrado', 'Os usuários criados aparecerão aqui.');
  return users.map(user => `<article class="user-card"><div class="user-avatar">${esc((user.name || '?').trim().charAt(0).toUpperCase())}</div><div class="user-card-main"><strong>${esc(user.name)}</strong><span>${esc(user.email)}</span></div><div class="user-card-meta"><span class="role-badge ${user.role === 'admin' ? 'admin' : ''}">${user.role === 'admin' ? 'Administrador' : 'Usuário'}</span><span class="user-rfid">${user.rfid_uid ? `Cartão ${esc(user.rfid_uid)}` : (user.rfid_registered ? 'Cartão cadastrado' : 'Sem cartão')}</span><span class="account-state ${user.active ? 'active' : ''}">${user.active ? 'Ativo' : 'Inativo'}</span><span class="user-actions"><button class="btn btn-secondary btn-small" data-action="edit-user" data-id="${user.id}">Editar</button>${user.id === currentUser.id ? '' : `<button class="btn btn-secondary btn-small" data-action="toggle-user" data-id="${user.id}">${user.active ? 'Desativar' : 'Reativar'}</button>`}</span></div></article>`).join('');
}
function recordCard({ code, room, user, start, end, status = '', action = '' }) {
  const statusLabel = status === 'reserved' ? 'Reservada' : status === 'removed-key' ? 'Chave removida' : 'Retirada';
  const isReservation = status === 'reserved' || status === 'removed-key';
  return `<article class="record-card"><div class="record-head"><div><div class="record-key">Chave ${esc(code)}</div><div class="record-room">${esc(room)}</div></div>${status ? `<span class="status ${status}">${statusLabel}</span>` : ''}</div><div class="record-details"><div><div class="detail-label">Responsável</div><div class="detail-value">${esc(user)}</div></div><div><div class="detail-label">${isReservation ? 'Início da reserva' : 'Retirada'}</div><div class="detail-value">${dateTime(start)}</div></div>${end ? `<div><div class="detail-label">Fim da reserva</div><div class="detail-value">${dateTime(end)}</div></div>` : ''}</div>${action ? `<div class="record-actions">${action}</div>` : ''}</article>`;
}
function canCancel(item) { return item.user_id === currentUser.id || currentUser.role === 'admin'; }
function cancelButton(item) {
  return canCancel(item) ? `<button class="btn btn-secondary btn-small" data-action="cancel-reservation" data-id="${item.id}">Cancelar reserva</button>` : '';
}
async function cancelReservation(id) {
  const item = reservations.find(entry => entry.id === Number(id));
  if (!item || !window.confirm(`Cancelar a reserva da chave ${item.key_name} (${dateTime(item.starts_at)})?`)) return;
  try {
    await api(`/api/reservations/${item.id}`, { method: 'DELETE' });
    toast('Reserva cancelada.', 'success');
    await refreshData();
  } catch (error) {
    toast(error.message, 'error');
  }
}
function renderReserved() {
  const list = reservations.filter(item => {
    const matchesUser = reserveFilter === 'all' || item.user_name === reserveFilter;
    return matchesUser && `${item.key_name} ${item.user_name} ${item.title}`.toLowerCase().includes(query.toLowerCase());
  });
  const users = [...new Set(reservations.map(item => item.user_name))];
  const filter = `<select class="select-control filter-control" id="reserveFilter"><option value="all">Todos os usuários</option>${users.map(name => `<option value="${esc(name)}" ${reserveFilter === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`;
  const cards = list.map(item => {
    const key = keys.find(entry => Number(entry.id) === Number(item.key_id));
    const removed = !key;
    return recordCard({ code: key ? keyCode(key) : `ID ${item.key_id}`, room: removed ? `${item.key_name} · chave removida do inventário` : item.key_name, user: item.user_name, start: item.starts_at, end: item.ends_at, status: removed ? 'removed-key' : 'reserved', action: cancelButton(item) });
  });
  return `${pageHead('Chaves reservadas', 'Consulte as reservas registradas na API', `${list.length} reservas`)}${searchToolbar('Buscar chave, local ou pessoa', filter)}<div class="records-grid">${cards.length ? cards.join('') : emptyState('▤', 'Nenhuma reserva encontrada', 'As reservas confirmadas aparecerão aqui.')}</div>`;
}
function renderMine() {
  const mine = loans.filter(loan => loan.user_id === currentUser.id);
  const cards = mine.map(loan => recordCard({ code: loan.key_code, room: loan.key_name, user: loan.user_name, start: loan.checked_out_at, status: 'taken' }));
  const myReservations = reservations.filter(item => item.user_id === currentUser.id && new Date(item.ends_at) > new Date());
  const reservationCards = myReservations.map(item => recordCard({ code: keyCode(keyStates.find(k => k.id === item.key_id) || { id: item.key_id }), room: item.key_name, user: item.user_name, start: item.starts_at, end: item.ends_at, status: 'reserved', action: cancelButton(item) }));
  return `${pageHead('Minhas chaves', 'Suas retiradas e reservas', `${mine.length} retiradas · ${myReservations.length} reservas`)}<div class="demo-banner" style="margin-bottom:20px">A retirada e a devolução são feitas no totem, com o seu cartão, e confirmadas pelos sensores. Esta tela só consulta os dados.</div><h2 class="section-title">Retiradas ativas</h2><div class="records-grid">${cards.length ? cards.join('') : emptyState('♙', 'Nenhuma chave retirada', 'Seus empréstimos ativos aparecerão aqui.')}</div><h2 class="section-title">Minhas reservas</h2><div class="records-grid">${reservationCards.length ? reservationCards.join('') : emptyState('▤', 'Nenhuma reserva', 'Reserve uma chave na tela Chaves.')}</div>`;
}
function renderSettings() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `${pageHead('Configurações', 'Preferências e informações do sistema')}<div class="settings-layout"><section class="settings-card"><h2>Aparência</h2><p>Escolha o tema da interface.</p><div class="setting-row"><div class="setting-label"><strong>Tema da interface</strong><span>Preferência salva neste navegador</span></div><div class="theme-option"><button class="btn btn-secondary ${!dark ? 'selected' : ''}" data-theme-choice="light">☼ Claro</button><button class="btn btn-secondary ${dark ? 'selected' : ''}" data-theme-choice="dark">☾ Escuro</button></div></div></section><section class="settings-card"><h2>Conta conectada</h2><p>${esc(currentUser.name)} · ${esc(currentUser.email)}</p><div class="setting-row"><div class="setting-label"><strong>Perfil</strong><span>${currentUser.role === 'admin' ? 'Administrador' : 'Usuário'}</span></div></div><div class="setting-row"><div class="setting-label"><strong>API</strong><span>${esc(API_BASE)}</span></div></div><div class="demo-banner">A retirada e a devolução são feitas no totem, com o cartão, e confirmadas pelos sensores.</div></section></div>`;
}
const renderers = { dashboard: renderDashboard, available: renderAvailable, keys: renderKeyManagement, users: renderUsers, reserved: renderReserved, mine: renderMine, settings: renderSettings };
function render() {
  if (!dataLoaded) return;
  $('#availableCount').textContent = keyStates.filter(isFree).length;
  $('#reservedCount').textContent = reservations.length;
  const alertCount = keyStates.filter(key => key.unauthorized).length;
  $('#alertCount').textContent = alertCount;
  $('#alertCount').style.display = alertCount ? '' : 'none';
  document.querySelectorAll('[data-admin-only]').forEach(button => button.classList.toggle('visible', currentUser.role === 'admin'));
  if (['keys', 'users', 'dashboard'].includes(page) && currentUser.role !== 'admin') page = 'available';
  if (!renderers[page]) page = 'available';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  content.innerHTML = renderers[page]();
  wirePage();
}
function showError(message) {
  content.innerHTML = `${pageHead('Conexão com a API', 'Não foi possível carregar os dados do claviculário.')}<div class="settings-card api-error"><h2>Falha na comunicação</h2><p>${esc(message)}</p><p>API configurada: <strong>${esc(API_BASE)}</strong></p><button class="btn btn-primary" id="retryButton">Tentar novamente</button></div>`;
}
function wirePage() {
  $('#searchInput')?.addEventListener('input', event => {
    query = event.target.value;
    const pos = event.target.selectionStart;
    render();
    const input = $('#searchInput');
    input.focus();
    input.setSelectionRange(pos, pos);
  });
  $('#reserveFilter')?.addEventListener('change', event => { reserveFilter = event.target.value; render(); });
}
function go(next) { page = next; query = ''; render(); closeSidebar(); if (next === 'users') loadUsers(); }
async function loadUsers() {
  if (currentUser.role !== 'admin') return;
  usersLoading = true;
  usersError = '';
  if (!usersLoaded && page === 'users') render();
  try {
    const result = await api('/api/users');
    users = result.users || [];
    usersLoaded = true;
  } catch (error) {
    usersError = error.message;
  } finally {
    usersLoading = false;
    if (page === 'users') render();
  }
}
function showModal(markup) {
  const layer = $('#modalLayer');
  layer.innerHTML = markup;
  layer.classList.add('open');
  layer.setAttribute('aria-hidden', 'false');
}
function closeModal() {
  const layer = $('#modalLayer');
  layer.classList.remove('open');
  layer.setAttribute('aria-hidden', 'true');
}
function reservationDateDefaults() {
  const start = new Date(Date.now() + 15 * 60_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start: localDateInput(start), end: localDateInput(end) };
}
function openPickKeyModal(id) {
  const key = keyStates.find(item => item.id === Number(id));
  if (!key) return toast('Não foi possível localizar esta chave.', 'error');
  const dates = reservationDateDefaults();
  showModal(`<form class="modal" id="reservationForm" data-key-id="${key.id}"><button class="modal-close" type="button" data-action="dismiss" aria-label="Fechar">×</button><div class="modal-icon">⚿</div><h2>Reservar chave ${esc(keyCode(key))}</h2><p>${esc(keyName(key))}</p><label class="form-label" for="reservationTitle">Em qual aula ou atividade você vai usar esta chave?</label><input class="search-input modal-input" id="reservationTitle" name="title" maxlength="160" placeholder="Ex.: Aula de eletrônica" required><div class="modal-date-grid"><div><label class="form-label" for="reservationStart">Início</label><input class="search-input modal-input" id="reservationStart" name="starts_at" type="datetime-local" value="${dates.start}" required></div><div><label class="form-label" for="reservationEnd">Fim previsto</label><input class="search-input modal-input" id="reservationEnd" name="ends_at" type="datetime-local" value="${dates.end}" required></div></div><p class="reservation-note">Isso cria uma reserva. Para pegar a chave, passe seu cartão no totem.</p><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="dismiss">Cancelar</button><button class="btn btn-primary" type="submit">Confirmar reserva</button></div></form>`);
  $('#reservationTitle').focus();
}
async function submitReservation(form) {
  const fields = new FormData(form);
  const title = String(fields.get('title') || '').trim();
  const start = new Date(String(fields.get('starts_at') || ''));
  const end = new Date(String(fields.get('ends_at') || ''));
  if (!title) return toast('Informe a aula ou atividade.', 'error');
  if (!(start > new Date()) || !(end > start)) return toast('Escolha um período futuro válido.', 'error');
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/reservations', {
      method: 'POST', body: JSON.stringify({
        key_id: Number(form.dataset.keyId),
        title,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
      })
    });
    closeModal();
    toast('Reserva criada com sucesso.', 'success');
    await refreshData();
  } catch (error) {
    button.disabled = false;
    toast(error.message, 'error');
  }
}
function openCreateKeyModal() {
  showModal(`<form class="modal" id="createKeyForm"><button class="modal-close" type="button" data-action="dismiss" aria-label="Fechar">×</button><div class="modal-icon">⚿</div><h2>Adicionar chave</h2><p>O cadastro será enviado para a API.</p><label class="form-label" for="keyCodeInput">Código da chave</label><input class="search-input modal-input" id="keyCodeInput" name="code" maxlength="50" placeholder="Ex.: 001 ou LAB-01" required><label class="form-label" for="keyNameInput">Sala ou local</label><input class="search-input modal-input" id="keyNameInput" name="name" maxlength="120" placeholder="Ex.: Laboratório de Informática" required><label class="form-label" for="keyDescriptionInput">Descrição (opcional)</label><input class="search-input modal-input" id="keyDescriptionInput" name="description" maxlength="500" placeholder="Detalhes do local"><label class="form-label" for="keySensorInput">ID do sensor (opcional)</label><input class="search-input modal-input" id="keySensorInput" name="sensor_id" maxlength="80" placeholder="ID cadastrado no dispositivo"><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="dismiss">Cancelar</button><button class="btn btn-primary" type="submit">Salvar chave</button></div></form>`);
  $('#keyCodeInput').focus();
}
function openEditKeyModal(id) {
  const key = keys.find(item => item.id === Number(id));
  if (!key) return toast('Não foi possível localizar esta chave.', 'error');
  showModal(`<form class="modal" id="editKeyForm" data-key-id="${key.id}"><button class="modal-close" type="button" data-action="dismiss" aria-label="Fechar">×</button><div class="modal-icon">⚿</div><h2>Editar chave ${esc(keyCode(key))}</h2><p>As alterações serão salvas na API.</p><label class="form-label" for="editKeyCode">Código da chave</label><input class="search-input modal-input" id="editKeyCode" name="code" maxlength="50" value="${esc(key.code || '')}" required><label class="form-label" for="editKeyName">Sala ou local</label><input class="search-input modal-input" id="editKeyName" name="name" maxlength="120" value="${esc(key.name || '')}" required><label class="form-label" for="editKeyDescription">Descrição (opcional)</label><input class="search-input modal-input" id="editKeyDescription" name="description" maxlength="500" value="${esc(key.description || '')}"><label class="form-label" for="editKeySensor">ID do sensor (opcional)</label><input class="search-input modal-input" id="editKeySensor" name="sensor_id" maxlength="80" value="${esc(key.sensor_id || '')}"><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="dismiss">Cancelar</button><button class="btn btn-primary" type="submit">Salvar alterações</button></div></form>`);
  $('#editKeyCode').focus();
}
async function createKey(form) {
  const fields = new FormData(form);
  const body = Object.fromEntries(fields.entries());
  for (const field of ['code', 'name', 'description', 'sensor_id']) body[field] = String(body[field] || '').trim();
  if (!body.description) delete body.description;
  if (!body.sensor_id) delete body.sensor_id;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    toast('Chave cadastrada na API.', 'success');
    page = 'keys';
    await refreshData();
  } catch (error) {
    submit.disabled = false;
    toast(error.message, 'error');
  }
}
async function updateKey(form) {
  const fields = new FormData(form);
  const body = Object.fromEntries(fields.entries());
  for (const field of ['code', 'name', 'description', 'sensor_id']) body[field] = String(body[field] || '').trim();
  if (!body.description) body.description = null;
  if (!body.sensor_id) body.sensor_id = null;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api(`/api/keys/${form.dataset.keyId}`, { method: 'PATCH', body: JSON.stringify(body) });
    closeModal();
    toast('Chave atualizada na API.', 'success');
    await refreshData();
  } catch (error) {
    submit.disabled = false;
    toast(error.message, 'error');
  }
}
async function deactivateKey(id) {
  const key = keys.find(item => item.id === Number(id));
  if (!key || !window.confirm(`Desativar a chave ${keyCode(key)}? Ela deixará de aparecer no inventário ativo.`)) return;
  try {
    await api(`/api/keys/${key.id}`, { method: 'DELETE' });
    toast('Chave desativada.', 'success');
    await refreshData();
  } catch (error) {
    toast(error.message, 'error');
  }
}
function openEditUserModal(id) {
  const user = users.find(item => item.id === Number(id));
  if (!user) return toast('Não foi possível localizar este usuário.', 'error');
  const self = user.id === currentUser.id;
  showModal(`<form class="modal" id="editUserForm" data-user-id="${user.id}"><button class="modal-close" type="button" data-action="dismiss" aria-label="Fechar">×</button><div class="modal-icon">♙</div><h2>Editar usuário</h2><p>${esc(user.email)}</p><label class="form-label" for="editUserName">Nome completo</label><input class="search-input modal-input" id="editUserName" name="name" maxlength="120" value="${esc(user.name)}" required><label class="form-label" for="editUserEmail">E-mail</label><input class="search-input modal-input" id="editUserEmail" name="email" type="email" maxlength="255" value="${esc(user.email)}" required><label class="form-label" for="editUserRole">Permissão</label><select class="select-control" id="editUserRole" name="role" ${self ? 'disabled' : ''}><option value="user" ${user.role === 'user' ? 'selected' : ''}>Usuário</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrador</option></select><label class="form-label" for="editUserRfid">UID do cartão RFID (vazio remove o cartão)</label><input class="search-input modal-input" id="editUserRfid" name="rfid_uid" maxlength="64" value="${esc(user.rfid_uid || '')}" placeholder="Ex.: 714A2803"><label class="form-label" for="editUserPassword">Nova senha (deixe vazio para manter)</label><input class="search-input modal-input" id="editUserPassword" name="password" type="password" minlength="8" autocomplete="new-password"><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="dismiss">Cancelar</button><button class="btn btn-primary" type="submit">Salvar alterações</button></div></form>`);
  $('#editUserName').focus();
}
async function updateUser(form) {
  const fields = new FormData(form);
  const body = {
    name: String(fields.get('name') || '').trim(),
    email: String(fields.get('email') || '').trim(),
    rfid_uid: String(fields.get('rfid_uid') || '').trim(),
  };
  if (fields.get('role')) body.role = String(fields.get('role'));
  const password = String(fields.get('password') || '');
  if (password) {
    if (password.length < 8) return toast('A senha precisa ter pelo menos 8 caracteres.', 'error');
    body.password = password;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api(`/api/users/${form.dataset.userId}`, { method: 'PATCH', body: JSON.stringify(body) });
    closeModal();
    toast('Usuário atualizado.', 'success');
    await loadUsers();
  } catch (error) {
    submit.disabled = false;
    toast(error.message, 'error');
  }
}
async function toggleUser(id) {
  const user = users.find(item => item.id === Number(id));
  if (!user || user.id === currentUser.id) return;
  const action = user.active ? 'Desativar' : 'Reativar';
  if (!window.confirm(`${action} a conta de ${user.name}?${user.active ? ' Ela deixará de conseguir entrar e de usar o cartão.' : ''}`)) return;
  try {
    await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: !user.active }) });
    toast(user.active ? 'Usuário desativado.' : 'Usuário reativado.', 'success');
    await loadUsers();
  } catch (error) {
    toast(error.message, 'error');
  }
}
async function createUser(form) {
  const fields = new FormData(form);
  const body = Object.fromEntries(fields.entries());
  for (const field of ['name', 'email', 'password', 'role', 'rfid_uid']) body[field] = String(body[field] || '').trim();
  if (body.password.length < 8) return toast('A senha precisa ter pelo menos 8 caracteres.', 'error');
  if (!body.rfid_uid) delete body.rfid_uid;
  const button = form.querySelector('[type="submit"]');
  const feedback = $('#userFormFeedback');
  button.disabled = true;
  feedback.textContent = 'Enviando cadastro para a API…';
  try {
    const result = await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
    form.reset();
    feedback.textContent = `Usuário ${result.user.name} cadastrado com sucesso.`;
    toast('Usuário cadastrado na API.', 'success');
    usersLoaded = false;
    await loadUsers();
  } catch (error) {
    feedback.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}
function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toastRegion').append(element);
  setTimeout(() => element.remove(), 4500);
}

function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-page]');
  if (nav) return go(nav.dataset.page);
  const action = event.target.closest('[data-action]');
  if (action) {
    if (action.dataset.action === 'dismiss') return closeModal();
    if (action.dataset.action === 'cancel-reservation') return cancelReservation(action.dataset.id);
    if (action.dataset.action === 'pick-key') return openPickKeyModal(action.dataset.id);
    if (action.dataset.action === 'create-key') return openCreateKeyModal();
    if (action.dataset.action === 'edit-key') return openEditKeyModal(action.dataset.id);
    if (action.dataset.action === 'deactivate-key') return deactivateKey(action.dataset.id);
    if (action.dataset.action === 'refresh-users') return loadUsers();
    if (action.dataset.action === 'edit-user') return openEditUserModal(action.dataset.id);
    if (action.dataset.action === 'toggle-user') return toggleUser(action.dataset.id);
  }
  const theme = event.target.closest('[data-theme-choice]');
  if (theme) { setTheme(theme.dataset.themeChoice); return render(); }
  if (event.target.closest('#retryButton')) return refreshData();
});
$('#menuButton').addEventListener('click', () => { $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('open'); });
$('#scrim').addEventListener('click', closeSidebar);
$('#themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('#refreshButton').addEventListener('click', () => page === 'users' ? loadUsers() : refreshData());
$('#logoutButton').addEventListener('click', () => {
  sessionStorage.removeItem('claviculario-token');
  sessionStorage.removeItem('claviculario-user');
  window.location.href = 'login.html';
});
$('#modalLayer').addEventListener('click', event => { if (event.target === $('#modalLayer')) closeModal(); });
$('#modalLayer').addEventListener('submit', event => {
  if (event.target.id === 'reservationForm') { event.preventDefault(); submitReservation(event.target); }
  if (event.target.id === 'createKeyForm') { event.preventDefault(); createKey(event.target); }
  if (event.target.id === 'editKeyForm') { event.preventDefault(); updateKey(event.target); }
  if (event.target.id === 'editUserForm') { event.preventDefault(); updateUser(event.target); }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'createUserForm') { event.preventDefault(); createUser(event.target); }
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeSidebar(); } });
window.addEventListener('resize', () => { if (innerWidth > 1050) closeSidebar(); });
content.innerHTML = `${pageHead('Carregando…', 'Buscando os dados do claviculário.')}`;
refreshData();