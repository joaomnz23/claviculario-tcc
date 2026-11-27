(() => {
  const form = document.querySelector('#loginForm');
  const identityStep = document.querySelector('#identityStep');
  const passwordStep = document.querySelector('#passwordStep');
  const identityInput = document.querySelector('#loginIdentity');
  const passwordInput = document.querySelector('#loginPassword');
  const submitButton = document.querySelector('#loginSubmit');
  const description = document.querySelector('#loginDescription');
  const note = document.querySelector('#loginNote');
  const themeOptions = [...document.querySelectorAll('[data-login-theme]')];
  const loginScreen = document.querySelector('#loginScreen');
  const loginCard = document.querySelector('.login-card');
  const apiBase = (window.API_BASE_URL || '').trim().replace(/\/$/, '');
  let email = '';
  // Já logado: vai direto para o destino certo.
  try {
    const saved = JSON.parse(sessionStorage.getItem('claviculario-user') || 'null');
    if (sessionStorage.getItem('claviculario-token') && saved) window.location.replace(saved.role === 'admin' ? 'index.html#painel' : 'index.html');
  } catch { /* Segue para o login. */ }

  function applyTheme(theme) {
    const light = theme === 'light';
    loginScreen.classList.toggle('light-theme', light);
    loginScreen.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;
    loginScreen.style.background = light
      ? 'radial-gradient(ellipse at 76% 14%, #e1e4e7 0, transparent 36%), radial-gradient(ellipse at 15% 91%, #e5e8eb 0, transparent 38%), linear-gradient(135deg, #f3f5f7 0%, #e9edf0 52%, #dfe4e8 100%)'
      : 'radial-gradient(ellipse at 76% 14%, #343638 0, transparent 36%), radial-gradient(ellipse at 15% 91%, #17191b 0, transparent 38%), linear-gradient(135deg, #292a2b 0%, #151617 48%, #050606 100%)';
    loginScreen.style.color = light ? '#10243a' : '#ffffff';
    loginCard.style.backgroundColor = light ? 'rgba(255,255,255,.93)' : 'rgba(23,24,25,.85)';
    loginCard.style.borderColor = light ? 'rgba(255,255,255,.67)' : 'rgba(255,255,255,.07)';
    loginCard.style.boxShadow = light ? '0 24px 70px rgba(16,36,58,.12)' : '0 30px 100px rgba(0,0,0,.47)';
    themeOptions.forEach(button => {
      const selected = button.dataset.loginTheme === theme;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    try { localStorage.setItem('senai-theme', theme); } catch { /* A tela continua alterando o tema sem persistência. */ }
  }

  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('senai-theme') === 'dark' ? 'dark' : 'light'; } catch { /* Usa o tema claro. */ }
  applyTheme(savedTheme);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-login-theme]');
    if (button) applyTheme(button.dataset.loginTheme);
  });

  function showPasswordStep(show) {
    identityStep.hidden = show;
    passwordStep.hidden = !show;
    identityInput.required = !show;
    passwordInput.required = show;
    submitButton.innerHTML = show ? 'Entrar <span aria-hidden="true">→</span>' : 'Avançar <span aria-hidden="true">→</span>';
    description.textContent = show ? 'Digite sua senha para continuar.' : 'Entre com seus dados para acessar o claviculário.';
    note.textContent = show ? `Conta: ${email}` : 'Entre com sua conta cadastrada no sistema.';
    if (show) passwordInput.focus();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (passwordStep.hidden) {
      email = identityInput.value.trim().toLowerCase();
      if (!email) return identityInput.reportValidity();
      showPasswordStep(true);
      return;
    }
    if (!passwordInput.value) return passwordInput.reportValidity();

    if (!apiBase) {
      note.textContent = 'Configure a URL pública da API no arquivo api-config.js.';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Conectando…';
    note.textContent = 'Validando seus dados com o servidor.';
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: passwordInput.value }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Não foi possível entrar. Confira seus dados.');
      sessionStorage.setItem('claviculario-token', result.access_token);
      sessionStorage.setItem('claviculario-user', JSON.stringify(result.user));
      window.location.href = result.user.role === 'admin' ? 'index.html#painel' : 'index.html';
    } catch (error) {
      note.textContent = error instanceof TypeError
        ? `Não foi possível concluir a conexão com ${apiBase}. Confira se a API está acessível e se o CORS permite ${window.location.origin}. O navegador pode bloquear o POST se o preflight OPTIONS falhar.`
        : error.message;
      submitButton.disabled = false;
      submitButton.innerHTML = 'Entrar <span aria-hidden="true">→</span>';
    }
  });

  document.querySelector('#loginBack').addEventListener('click', () => {
    showPasswordStep(false);
    passwordInput.value = '';
    note.textContent = 'Entre com sua conta cadastrada no sistema.';
    identityInput.focus();
  });
})();