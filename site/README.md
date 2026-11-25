# Claviculário inteligente SENAI

O frontend roda no computador do totem e consome a API hospedada externamente. Ele não inicia nem hospeda o backend. A cópia em `api/` é apenas o código recebido no ZIP e serve de referência para conferir rotas e configuração de CORS.

## Configurar o endereço remoto

O frontend está configurado para usar `http://10.139.22.211:5000`. Se o endereço mudar, edite [api-config.js](api-config.js) e informe a URL base pública da API, sem barra no final:

```js
window.API_BASE_URL = 'https://api.seudominio.com';
```

O servidor precisa disponibilizar `/api/auth/login`, `/api/keys`, `GET/POST/PATCH/DELETE /api/users`, `GET/POST/PATCH/DELETE /api/keys`, `/api/reservations` e `/api/loans`. Como as chamadas partem do navegador, o servidor remoto deve devolver `Access-Control-Allow-Origin` com a origem exata do site, permitir `Authorization` e `Content-Type`, e aceitar `GET`, `POST`, `PATCH`, `DELETE` e `OPTIONS`. Para uma página local em `http://localhost:5500`, adicione essa origem à configuração de CORS no servidor. O backend atualizado precisa estar implantado e o Flask reiniciado no servidor externo. Se o site estiver em HTTPS, a API também precisa usar HTTPS.

## Executar o frontend localmente

Para visualizar o frontend durante o desenvolvimento, abra um terminal nesta pasta e execute:

```powershell
py serve_frontend.py
```

Abra [http://localhost:5500/login.html](http://localhost:5500/login.html). Esse servidor só entrega os arquivos da interface e bloqueia o acesso HTTP à pasta `api/` e aos arquivos `.env`; a API continua sendo chamada pela URL remota em `api-config.js`.

Para abrir em um celular conectado à mesma rede Wi-Fi, inicie o servidor da mesma forma, descubra o IPv4 deste computador com `ipconfig` e acesse `http://IP-DO-COMPUTADOR:5500/login.html` no navegador do celular. O servidor escuta na rede local na porta 5500. Se o Windows perguntar, permita o acesso em redes privadas. A API remota também precisa permitir no CORS a origem `http://IP-DO-COMPUTADOR:5500`.

## Integração

- Login por e-mail e senha: `POST /api/auth/login`, com token JWT guardado na sessão do navegador.
- Lista de chaves: `GET /api/keys`.
- Administradores: **Chaves** lista o inventário e permite criar, editar (`PATCH /api/keys/{id}`) e desativar (`DELETE /api/keys/{id}`) chaves; **Usuários** lista contas via `GET /api/users` e cadastra contas via `POST /api/users`, com perfil `user` ou `admin`.
- Reservas: a tela de chaves disponíveis permite selecionar **Reservar**, informar a aula ou atividade e o período previsto; o frontend cria a reserva via `POST /api/reservations`. `GET /api/reservations` alimenta as telas de reservas.
- Empréstimos ativos: `GET /api/loans?active=true`.
- Atualizar recarrega os dados remotos. As demais telas consultam e exibem dados; retiradas e devoluções físicas chegam à API pelo RFID.

O botão **Reservar** cria uma reserva para a aula/atividade informada; a retirada física continua sendo registrada pelo RFID. A exclusão de chave é feita pela API como desativação, preservando o histórico. A interface não envia comandos ao ESP32 nem simula retiradas/devoluções. Consulte [api/README.md](api/README.md) para os formatos e regras dos endpoints.
