// A API roda no mesmo computador do site (porta 5000), então o endereço é
// montado a partir do endereço da própria página: se o site abre em
// http://192.168.0.50:5500, a API é http://192.168.0.50:5000.
// Para usar uma API em outro endereço, preencha OVERRIDE (sem barra no final).
// Exemplo: const OVERRIDE = 'https://api.seudominio.com';
const OVERRIDE = '';
window.API_BASE_URL = OVERRIDE || `${location.protocol}//${location.hostname || 'localhost'}:5000`;