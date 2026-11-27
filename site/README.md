# Claviculário inteligente SENAI: site

Site em HTML/JS puro, sem framework. Fica na pasta `claviculario\site\`, ao lado de `claviculario\api\` (API Flask) e `claviculario\firmware\`. O site não inicia nem hospeda a API: ele só a consome.

## Endereço da API

[api-config.js](api-config.js) monta o endereço sozinho: usa o mesmo host da página, na porta 5000. Se o site abre em `http://192.168.0.50:5500`, a API é `http://192.168.0.50:5000`. Nada precisa ser editado quando o IP muda, desde que a API rode no mesmo computador do site (o caso do Raspberry Pi).

Para apontar para uma API em outro endereço, preencha `OVERRIDE` em `api-config.js`, sem barra no final:

```js
const OVERRIDE = 'https://api.seudominio.com';
```

Como as chamadas partem do navegador, a API precisa permitir CORS (`CORS_ORIGINS`, padrão `*`) e aceitar `GET`, `POST`, `PATCH`, `DELETE` e `OPTIONS`. Se o site estiver em HTTPS, a API também precisa usar HTTPS.

## Executar localmente (Windows)

Em um terminal, na pasta `claviculario\site`:

```
py serve_frontend.py
```

Abra `http://localhost:5500/login.html`. Para abrir no celular, na mesma rede Wi-Fi, use `http://IP-DO-COMPUTADOR:5500/login.html` (descubra o IPv4 com `ipconfig`). O Windows precisa liberar a porta 5500 em rede privada, e a API (porta 5000) também precisa estar acessível na rede.

Para subir a API, veja `..\api\README.md`.

## Telas

- `login.html`: login único por e-mail e senha. O administrador vai para o painel; o usuário comum vai para as chaves.
- `index.html`: usuário comum vê **Chaves** (estado real de cada uma e reserva), **Chaves reservadas**, **Minhas chaves** (retiradas e reservas, com cancelamento) e **Configurações**. O administrador também vê **Painel**, **Chaves** (cadastro) e **Usuários**. Os dados se atualizam sozinhos a cada 5 segundos.
- `totem.html`: tela do totem físico (tablet ou notebook no claviculário). Usa o token do terminal, não o login.

## Endpoints usados

- Login: `POST /api/auth/login` (JWT guardado na sessão do navegador).
- Estado das chaves: `GET /api/keys/status` (presença, quem está com a chave, reserva). `GET /api/keys` serve ao cadastro.
- Reservas: `GET` e `POST /api/reservations`; cancelamento por `DELETE /api/reservations/{id}` (dono ou administrador).
- Empréstimos: `GET /api/loans?active=true|false`.
- Administrador: `GET/POST/PATCH/DELETE /api/users`, `POST/PATCH/DELETE /api/keys` e `GET /api/reed-events` (alertas e histórico dos sensores).

Retiradas e devoluções físicas não são feitas pelo site: o cartão RFID abre a sessão no totem e os sensores (reeds) registram a chave saindo ou voltando. O site só consulta e reserva. Formatos e regras dos endpoints: `..\api\README.md`.