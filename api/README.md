# API do claviculário

Este projeto é a parte do servidor de um claviculário de chaves. A API recebe pedidos do site e eventos do ESP32, confere as regras e grava os dados no banco.

## Visão geral

- **Site**: autentica uma pessoa com e-mail e senha; consulta chaves, reservas e empréstimos.
- **ESP32**: autentica o dispositivo com um token secreto; envia o cartão RFID e as mudanças dos sensores (reeds), e consulta comandos (porta e LEDs).
- **Totem**: tela física que usa o token do terminal; mostra a sessão aberta pelo cartão.
- **API Flask**: confere os dados, identifica o usuário pelo cartão e atualiza o banco.
- **MySQL**: mantém usuários, chaves, reservas, eventos do dispositivo e empréstimos.

O ESP32 não precisa conhecer a senha do usuário. Ele lê o cartão e envia seu UID para a API. A API encontra a conta associada ao UID. O UID é apenas um identificador: mantenha também o token secreto do dispositivo e use HTTPS quando a API estiver acessível pela rede.

## Estrutura dos arquivos

| Arquivo | Para que serve |
|---|---|
| `app.py` | Ponto de entrada usado pelo Flask e execução local. |
| `claviculario/__init__.py` | Configura a aplicação, conecta extensões e registra rotas. |
| `claviculario/models.py` | Modelos/tabelas do banco de dados. |
| `claviculario/auth.py` | Login, token e cadastro de usuários. |
| `claviculario/keys.py` | Cadastro e consulta de chaves. |
| `claviculario/reservations.py` | Criação, consulta e cancelamento de reservas. |
| `claviculario/loans.py` | Consulta dos empréstimos. |
| `claviculario/device.py` | Endpoint antigo de eventos RFID do ESP32 (`/api/device/events`), mantido por compatibilidade. |
| `claviculario/hardware.py` | Sessão física, reeds, porta, LEDs, rotas do totem, estado das chaves e histórico dos sensores. |
| `claviculario/extensions.py` e `utils.py` | Extensões compartilhadas e funções auxiliares. |
| `schema.sql` | Criação manual das tabelas no MySQL. |
| `requirements.txt` | Bibliotecas Python necessárias. |
| `.env.example` | Exemplo das configurações secretas e da conexão ao banco. |

## Preparação no Raspberry Pi

Recomendado: Python 3.11 ou mais recente e MySQL 8 ou mais recente.

1. Crie no MySQL um banco e um usuário próprio para a aplicação. Dê ao usuário permissões somente nesse banco.
2. Copie `.env.example` para `.env`.
3. Edite `.env`: preencha a conexão em `DATABASE_URL` e substitua os valores de exemplo de `FLASK_SECRET_KEY`, `JWT_SECRET_KEY` e `DEVICE_TOKEN` por segredos aleatórios.
4. Acrescente ao `.env` os dados do primeiro administrador:

   ```dotenv
   ADMIN_NAME=Administrador
   ADMIN_EMAIL=admin@exemplo.com
   ADMIN_PASSWORD=uma-senha-forte
   ```

5. Crie e ative um ambiente virtual e instale as bibliotecas:

   ```sh
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

   No Windows, a ativação é `.venv\\Scripts\\activate`.

6. Crie as tabelas e o administrador inicial:

   ```sh
   flask --app app init-db
   ```

7. Para teste rápido no Windows, sem MySQL (CMD, na pasta `api`):

   ```
   set DATABASE_URL=sqlite:///claviculario.db
   flask --app app init-db
   flask --app app run --host 0.0.0.0 --port 5000
   ```

   O `set` vale só para aquela janela do CMD. Para desenvolvimento na rede local, inicie a API:

   ```sh
   flask --app app run --host 0.0.0.0 --port 5000
   ```

Variáveis do `.env`: `FLASK_SECRET_KEY`, `JWT_SECRET_KEY`, `JWT_ACCESS_TOKEN_MINUTES`, `DATABASE_URL`, `CORS_ORIGINS`, `DEVICE_TOKEN` (ESP32), `TERMINAL_TOKEN` (totem), `SESSION_TIMEOUT_SECONDS` (inatividade da sessão física, padrão 60 s) e os dados do administrador inicial.

O padrão de desenvolvimento usa SQLite se `DATABASE_URL` não estiver definida. Para o Raspberry Pi, configure a URL MySQL antes de inicializar. Por exemplo:

```dotenv
DATABASE_URL=mysql+pymysql://claviculario:senha@localhost:3306/claviculario?charset=utf8mb4
```

A configuração de CORS lê `CORS_ORIGINS` do ambiente. Se a variável não for definida, a API aceita requisições de navegador vindas de qualquer origem (`*`), sem exigir configuração manual. Para restringir as origens, informe uma ou mais URLs separadas por vírgula, por exemplo `CORS_ORIGINS=https://site.exemplo.com,https://admin.exemplo.com`. As rotas continuam exigindo JWT ou token do dispositivo conforme indicado; CORS não substitui autenticação.

O comando `init-db` cria tabelas usando os modelos Python. Como alternativa, importe `schema.sql` no MySQL e depois rode `flask --app app init-db` para criar o administrador inicial. Se já existir um banco de uma versão anterior sem o campo RFID, aplique uma vez:

```sql
ALTER TABLE users ADD COLUMN rfid_uid VARCHAR(64) NULL UNIQUE;
```

Para disponibilizar a API fora de uma rede de desenvolvimento, use um servidor WSGI e HTTPS. O servidor de desenvolvimento do Flask não é indicado para produção.

## Conceitos principais

### Como o código está organizado

O projeto foi dividido por responsabilidade para ficar mais fácil de acompanhar:

1. `app.py` chama `create_app()` e expõe a variável `app` esperada pelo comando Flask.
2. `claviculario/__init__.py` monta a aplicação, carrega configurações, conecta banco e JWT e registra os grupos de rotas.
3. Cada arquivo de rotas define um Blueprint: um conjunto de URLs relacionado a um assunto.
4. As rotas usam as classes de `models.py` para ler e gravar dados. Funções compartilhadas, como conversão de data, ficam em `utils.py`.

Essa organização não muda os endereços HTTP documentados abaixo; ela apenas separa o código por assunto.

### O caminho de uma requisição

Por exemplo, quando o site consulta `GET /api/keys`:

1. O navegador envia uma requisição HTTP para o Raspberry Pi, junto com o token JWT.
2. Flask compara o caminho e método HTTP com `@bp.get("/api/keys")` em `claviculario/keys.py` e escolhe a função `list_keys`.
3. `@jwt_required()` roda antes da função e rejeita a chamada se o token estiver ausente, inválido ou expirado.
4. A função usa os modelos de `models.py` através de `db` (`extensions.py`) para consultar as chaves e empréstimos no banco.
5. `jsonify(...)` transforma os dados Python em JSON; Flask envia a resposta de volta ao navegador.

Os decoradores `@bp.get`, `@bp.post` e `@bp.delete` conectam uma função a um método e endereço HTTP. `request` é o pedido que chegou ao servidor: `request.get_json()` lê seu corpo e `request.args` lê parâmetros da URL. Uma rota normalmente termina retornando o conteúdo da resposta e, opcionalmente, um código HTTP como `201` (criado), `400` (pedido inválido), `401` (não autenticado), `403` (sem permissão) ou `404` (não encontrado).

### Como Python grava dados no banco

Os modelos são classes Python que representam tabelas. Por exemplo, `User(...)` monta um objeto usuário. `db.session.add(objeto)` prepara a inclusão ou alteração; `db.session.commit()` confirma as mudanças e as envia ao banco. Se ocorrer um erro no meio de uma transação que precisa ser desfeita, `db.session.rollback()` cancela as mudanças pendentes. Consultas como `User.query.filter_by(email=email).first()` significam “procure usuários com este e-mail e devolva o primeiro resultado, ou `None` se não houver”.

`db.relationship(...)` conecta objetos relacionados para que o código possa navegar entre eles. Uma reserva guarda `key_id` e `user_id` (os números das chaves estrangeiras), e os relacionamentos permitem também ler `reservation.key.name` e `reservation.user.name`.

### Como os arquivos se conectam

```text
app.py
  └─ create_app() em claviculario/__init__.py
       ├─ conecta db e jwt de extensions.py
       ├─ registra os Blueprints (auth, keys, reservations, loans, device)
       └─ registra /health e o comando init-db

Blueprint de rota ── usa ──> models.py ── mapeia ──> tabelas MySQL/SQLite
       ├─ usa db/jwt de extensions.py
       └─ usa validações e respostas comuns de utils.py
```

O ponto importante é que `create_app()` reúne as peças. Os arquivos de rotas não criam outro servidor Flask; eles apenas descrevem grupos de endereços, chamados Blueprints, que a aplicação principal registra.

### Usuários e login do site

As senhas são guardadas como hash, não em texto simples. O login retorna um token JWT. O site deve enviar esse token nas rotas protegidas:

```http
Authorization: Bearer TOKEN_RECEBIDO_NO_LOGIN
```

Existem dois papéis: `user` e `admin`. Administradores podem cadastrar usuários e chaves. Usuários podem consultar as chaves e criar reservas. Cada usuário só pode cancelar as próprias reservas, a menos que seja administrador.

O cartão é cadastrado junto ao usuário. Exemplo do corpo de criação de usuário (requer token de administrador):

```json
{
  "name": "Ana Silva",
  "email": "ana@escola.edu",
  "password": "senha-com-pelo-menos-8-caracteres",
  "role": "user",
  "rfid_uid": "04A1B2C3D4"
}
```

`rfid_uid` pode ser omitido na criação, mas sem ele a pessoa não poderá ser reconhecida pelo leitor RFID. O UID é normalizado para maiúsculas e deve ser único.

### Chaves e estado atual

O cadastro administrativo de chave recebe `code` e `name`; `description` e `sensor_id` são opcionais. `GET /api/keys` informa só `available` e `holder_user_id` (considera apenas empréstimos).

O estado completo vem de `GET /api/keys/status` (qualquer usuário autenticado): para cada chave, `present` (sensor), `holder` (quem está com ela e desde quando), `reservation` (quem reservou, início, fim e `now`), `unauthorized` (saiu sem sessão), `available`, `reserved_for_me`. Uma reserva "vale agora" se já começou ou começa em até 60 minutos. O site usa essa rota.

Atenção: o `sensor_id` de cada chave precisa ser `"1"`, `"2"`, `"3"` ou `"4"`, igual ao número do reed/LED no firmware.

### Reservas

Uma reserva tem chave, usuário, título, início e fim. Os horários devem ser enviados em ISO 8601, preferencialmente com `Z` para UTC, por exemplo `2026-11-20T13:00:00Z`. A API armazena os horários em UTC.

Os intervalos são tratados como início incluso e fim exclusivo: `[início, fim)`. Assim, uma reserva que termina às 14h não conflita com outra que começa às 14h. Reservas confirmadas da mesma chave não podem se sobrepor. A rota de listagem aceita filtros `from`, `to` e `key_id`, úteis para montar uma agenda.

### Mensagens do ESP32

O ESP32 envia o cabeçalho `X-Device-Token` com o valor configurado em `DEVICE_TOKEN`. O JSON contém um `event_id` único, a ação, o UID RFID e os IDs das chaves. Use `withdraw` para retirada e `return` para devolução.

Exemplo de retirada:

```http
POST /api/device/events
X-Device-Token: SEGREDO_DO_DISPOSITIVO
Content-Type: application/json
```

```json
{
  "event_id": "esp32-001-000045",
  "rfid_uid": "04A1B2C3D4",
  "action": "withdraw",
  "key_ids": [3, 4],
  "occurred_at": "2026-11-20T13:05:00Z"
}
```

O `event_id` é criado pelo ESP32 para cada leitura/operação e deve ser mantido igual se o mesmo evento for reenviado por falha de rede. Isso impede que uma repetição crie empréstimos duplicados. Se várias chaves forem enviadas juntas, a API valida todas; se alguma não puder ser retirada/devolvida, nenhuma mudança daquele evento é gravada.

`occurred_at` é opcional. Se omitido, o servidor usa o horário em que recebeu a mensagem. Mantenha o relógio do ESP32 sincronizado (por exemplo, via NTP) se enviar esse campo.

## Rotas disponíveis

As rotas do totem, do ESP32 (sessão) e do estado das chaves estão na seção seguinte, "Totem, sessão física e sensores".

| Método | Rota | Quem pode usar | Função |
|---|---|---|---|
| `GET` | `/health` | qualquer cliente | Confirma que a API está respondendo. |
| `POST` | `/api/auth/login` | público | Faz login com `email` e `password`. |
| `GET` | `/api/auth/me` | usuário autenticado | Retorna os dados da conta do token. |
| `POST` | `/api/users` | administrador | Cadastra pessoa, senha, papel e UID RFID opcional. |
| `GET` | `/api/users` | administrador | Lista usuários, inclusive inativos. |
| `PATCH` | `/api/users/{id}` | administrador | Altera os campos enviados do usuário. |
| `DELETE` | `/api/users/{id}` | administrador | Desativa o usuário, preservando o histórico. |
| `GET` | `/api/keys` | usuário autenticado | Lista chaves e disponibilidade. |
| `POST` | `/api/keys` | administrador | Cadastra uma chave. |
| `PATCH` | `/api/keys/{id}` | administrador | Altera os campos enviados da chave. |
| `DELETE` | `/api/keys/{id}` | administrador | Desativa a chave, preservando o histórico. |
| `GET` | `/api/reservations` | usuário autenticado | Lista reservas; aceita `from`, `to`, `key_id`. |
| `POST` | `/api/reservations` | usuário autenticado | Cria reserva. |
| `DELETE` | `/api/reservations/{id}` | dono ou administrador | Cancela reserva confirmada. |
| `GET` | `/api/loans?active=true` | usuário autenticado | Lista empréstimos; usuário vê os próprios, admin vê todos. Com `active=false` lista também os já devolvidos. |
| `POST` | `/api/device/events` | ESP32 autenticado | Registro direto de retirada ou devolução pelo RFID (fluxo antigo, mantido). |

## Exemplos de chamadas

### 1. Fazer login

```sh
curl -X POST http://raspberrypi:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@exemplo.com","password":"uma-senha-forte"}'
```

Copie o `access_token` da resposta para usar nas chamadas do site.

### Administração de usuários e chaves

As rotas `PATCH` aceitam somente os campos que precisam mudar. Em usuários, os campos aceitos são `name`, `email`, `password`, `role`, `rfid_uid` e `active`; senhas continuam armazenadas como hash e devem ter pelo menos 8 caracteres. Em chaves, são aceitos `code`, `name`, `description`, `sensor_id` e `active`. E-mail, UID RFID, código e sensor continuam únicos.

As rotas `DELETE` desativam o registro em vez de apagá-lo fisicamente, para manter reservas, empréstimos e eventos históricos. Usuários desativados não podem entrar; chaves desativadas deixam de aparecer na listagem normal e não podem ser reservadas. A listagem administrativa de usuários inclui contas inativas, e ambos os tipos podem ser reativados com `PATCH` enviando `{"active": true}`.

### 2. Cadastrar uma chave

```sh
curl -X POST http://raspberrypi:5000/api/keys \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' \
  -d '{"code":"LAB-01","name":"Laboratório 01","sensor_id":"sensor-01"}'
```

### 3. Consultar chaves

```sh
curl http://raspberrypi:5000/api/keys -H 'Authorization: Bearer TOKEN'
```

### 4. Reservar uma chave

```sh
curl -X POST http://raspberrypi:5000/api/reservations \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' \
  -d '{"key_id":1,"title":"Aula de Física","starts_at":"2026-11-20T13:00:00Z","ends_at":"2026-11-20T14:00:00Z"}'
```

## Totem, sessão física e sensores

Fluxo: o cartão passa no leitor, o ESP32 chama `POST /api/device/card` e a API abre uma **sessão física** (passar o mesmo cartão de novo, o botão Encerrar do totem ou a inatividade encerram). Durante a sessão o totem escolhe retirar ou devolver e confirma as chaves. Os **reeds** (um por chave) são a fonte de verdade: ímã saindo é retirada, voltando é devolução. Mudança de reed sem sessão ativa vira retirada sem autorização (`unauthorized`), que aparece como alerta no painel.

Autenticação: ESP32 usa `X-Device-Token`; o totem usa `X-Terminal-Token`; o site usa JWT.

| Método | Rota | Quem usa | Função |
|---|---|---|---|
| `POST` | `/api/device/card` | ESP32 | Cartão lido: abre ou encerra a sessão (`event_id` único). |
| `GET` | `/api/device/poll` | ESP32 | Estado da sessão, comando da porta e cor/pisca de cada LED. Consultado a cada ~1 s. |
| `POST` | `/api/device/reeds` | ESP32 | Mudanças dos reeds (`event_id`, `sensor_id`, presente ou ausente, horário). |
| `GET` | `/api/totem/session` | totem | Sessão ativa e tempo restante. |
| `POST` | `/api/totem/mode` | totem | Escolhe retirar ou devolver. |
| `POST` | `/api/totem/take` | totem | Confirma as chaves escolhidas (`key_ids`); libera a porta. |
| `POST` | `/api/totem/activity` | totem | Renova a inatividade. |
| `POST` | `/api/totem/end` | totem | Encerra a sessão. |
| `GET` | `/api/keys/status` | site (JWT) | Estado completo das chaves. |
| `GET` | `/api/reed-events?limit=` | administrador | Histórico dos eventos dos sensores (até 500). |

Tabelas novas (criadas pelo `init-db`): `physical_sessions` e `reed_events`. Cores dos LEDs, calculadas pela API: verde (presente e livre), vermelho (ausente), amarelo (presente e reservada por outro), piscando (chave escolhida ou reservada para quem está logado).

## O que este projeto não faz

- Não controla eletricamente a fechadura nem os LEDs; isso é responsabilidade do firmware e do circuito.
- Não decide como o leitor RFID é conectado ao ESP32.
- Não substitui o mecanismo físico por uma verificação online em tempo real: planeje o que acontece se a rede cair.
- O UID simples de alguns cartões RFID pode ser copiado. O token do ESP32 protege a API contra chamadas sem credencial, mas não impede sozinho a clonagem de um cartão.