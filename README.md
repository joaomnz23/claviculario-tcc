# Claviculário inteligente SENAI (TCC)

Armário de chaves com leitor de cartão: a pessoa passa o cartão no totem, escolhe retirar ou devolver, a porta abre e sensores (reeds) confirmam qual chave saiu ou voltou. Pelo site, qualquer pessoa vê o estado real das chaves e faz reservas; o administrador acompanha tudo em um painel.

## Estrutura

```
claviculario\
├── api\        API Flask: regras, banco, rotas do site, do totem e do ESP32
├── site\       Site (HTML/JS puro): login, chaves, reservas, painel do admin e tela do totem
└── firmware\   Código do ESP32 (cartão, motor, reeds, LEDs)
```

Cada pasta tem seu próprio README com os detalhes: [api/README.md](api/README.md) e [site/README.md](site/README.md). O firmware e a montagem estão descritos na seção **Hardware** deste arquivo.

## Como as partes se conectam

```
Cartão RFID ─> ESP32 ──(X-Device-Token)──> API <──(JWT)── Site (celular, notebook, desktop)
                 ▲  reeds, LEDs, motor        ▲
                 └── consulta a cada ~1 s     └──(X-Terminal-Token)── Totem (tela no claviculário)
                                              │
                                        banco (MySQL ou SQLite)
```

- **Site**: login único (o administrador vai para o painel). Mostra por chave se está disponível, reservada (quem e quando) ou com alguém (quem e desde quando), com atualização automática a cada 5 s. Permite reservar e cancelar reservas.
- **Painel do administrador**: estado em tempo real, histórico de retiradas e devoluções, eventos dos sensores e alertas de retirada sem autorização.
- **Totem**: tela física, aberta pelo cartão, para retirar e devolver.
- **ESP32**: lê o cartão, aciona a porta e os LEDs e informa os sensores. Quem decide é sempre a API.

## Teste rápido no Windows (sem MySQL)

Duas janelas do CMD.

API, em `claviculario\api`:

```
set DATABASE_URL=sqlite:///claviculario.db
flask --app app init-db
flask --app app run --host 0.0.0.0 --port 5000
```

Site, em `claviculario\site`:

```
py serve_frontend.py
```

Abra `http://localhost:5500/login.html`. Pelo celular, na mesma rede Wi-Fi, use `http://IP-DO-PC:5500/login.html` (o firewall precisa liberar as portas 5000 e 5500 na rede privada). O endereço da API é deduzido do endereço da página, sem editar nada.

Dados de teste: administrador `admin@exemplo.com`; usuário `teste@escola.edu` com cartão `714A2803`; chave `LAB-01`. O `sensor_id` das chaves deve ser `1` a `4`, igual ao reed e ao LED de cada uma.

## Hardware

Placa: **ESP32 DevKit de 38 pinos com módulo WROOM-32**. Componentes: leitor RFID MFRC522, motor EV3 com ponte H TB6612FNG, 4 reeds (um por chave) e 4 LEDs RGB (um por chave).

### Pinagem

| Função | Sinal | GPIO | Observação |
|---|---|---|---|
| Leitor RFID MFRC522 | SDA/SS | 5 | alimentar em **3,3 V** |
| | SCK | 18 | |
| | MISO | 19 | |
| | MOSI | 23 | |
| | RST | 22 | |
| Ponte H TB6612 (motor) | IN1 | 16 | direção |
| | IN2 | 17 | direção |
| | PWM | 4 | velocidade |
| Reed da chave 1 | entrada | 34 | só entrada: precisa de resistor externo |
| Reed da chave 2 | entrada | 35 | idem |
| Reed da chave 3 | entrada | 36 (VP) | idem |
| Reed da chave 4 | entrada | 39 (VN) | idem |
| LED da chave 1 | vermelho / verde | 32 / 33 | |
| LED da chave 2 | vermelho / verde | 25 / 26 | |
| LED da chave 3 | vermelho / verde | 27 / 14 | |
| LED da chave 4 | vermelho / verde | 13 / 21 | |

Não usar: GPIO 0, 2, 12 e 15 (boot), 1 e 3 (serial/USB) e 6 a 11 (memória flash). O encoder do motor não é usado.

### Ligações

- **Reeds:** um resistor de **10 kΩ** entre o pino do reed e o **3,3 V** (pull-up externo, obrigatório nos pinos 34, 35, 36 e 39) e o outro fio do reed no **GND**. Ímã perto = contato fechado = LOW = chave presente.
- **LEDs:** só o vermelho e o verde de cada LED RGB (o azul não é usado). Um resistor em série em cada perna (comece com 220 Ω; se o verde ficar fraco, 100 Ω). Amarelo = vermelho e verde ligados juntos.
  - Catodo comum: terminal comum no GND (valor padrão do firmware).
  - Anodo comum: terminal comum no 3,3 V, e trocar `LED_ANODO_COMUM` para `true` no firmware.
- **Motor:** fonte própria, com **GND comum** com o ESP32 e a ponte H. STBY do TB6612 em 3,3 V. Capacitor de 100 nF nos terminais do motor e de 100 µF perto da ponte H. Nunca alimentar o motor pelo 5 V do ESP32 ou da USB. O EV3 é de 9 V; em 5 a 6 V gira mais devagar, o que serve para uma tranca.
- **ESP32:** fonte de 5 V com cerca de 2 A, GND comum com todos os módulos.
- **Ordem:** o reed e o LED N correspondem à chave com `sensor_id` = `N` no cadastro do site (de `1` a `4`).

### Firmware (`firmware\esp32-claviculario\esp32-claviculario.ino`)

1. Instale o suporte à placa ESP32 na IDE do Arduino e, em Gerenciar Bibliotecas, as bibliotecas **MFRC522** e **ArduinoJson 7.x**. Placa: ESP32 Dev Module.
2. Crie na mesma pasta do `.ino` o arquivo `segredos.h` (não é versionado):

   ```cpp
   #define WIFI_SSID "nome-da-rede"
   #define WIFI_PASSWORD "senha-da-rede"
   #define API_BASE "http://IP-DO-PC:5000"
   #define DEVICE_TOKEN "mesmo-valor-do-DEVICE_TOKEN-do-.env-da-API"
   ```

3. Grave na placa (se aparecer `Wrong boot mode`, segure o botão BOOT durante o upload) e abra o Monitor Serial em **115200**.

O firmware lê o cartão (`/api/device/card`), consulta `/api/device/poll` a cada 1 s (porta e cores dos LEDs), envia as mudanças dos reeds (`/api/device/reeds`, com fila e reenvio se a API cair) e fecha a porta se ficar 30 s sem resposta da API. Sem API, os LEDs mostram só verde (presente) ou vermelho (ausente).

Ajustes no início do `.ino`: `LED_ANODO_COMUM`, `INVERTER_MOTOR`, `TEMPO_ABRIR_MS`, `TEMPO_FECHAR_MS`, `VELOCIDADE` e `FECHAR_AO_LIGAR` (deixar `false` até existir batente mecânico).

### Roteiro de testes

Faça nesta ordem, com o Monitor Serial aberto.

1. **API e site no ar** (seção "Teste rápido") e usuário de teste com o cartão cadastrado (tela Usuários do site, campo UID).
2. **Chaves cadastradas** com `sensor_id` de `1` a `4`.
3. **LEDs:** na partida cada LED acende vermelho, verde e, no fim, todos em amarelo. Se acender invertido ou ficar aceso quando deveria estar apagado, troque `LED_ANODO_COMUM`.
4. **Reeds:** aproxime e afaste o ímã de cada reed. O Serial mostra `[REED] chave N: PRESENTE/AUSENTE` e o painel do administrador registra o evento em até 5 s.
5. **Alerta:** tire um ímã sem passar o cartão. O painel mostra retirada sem autorização.
6. **Cartão e totem:** passe o cartão. O totem entra na conta, escolha Retirar, selecione a chave e confirme. Tire e devolva a chave e confira o histórico no painel.
7. **LEDs com a API:** presente e livre = verde; ausente = vermelho; reservada por outra pessoa = amarelo; chave escolhida ou reservada para quem está logado = piscando.
8. **Motor (por último):** confirme o batente mecânico, ajuste `INVERTER_MOTOR` e os tempos de abrir e fechar.

### Problemas comuns

- `[DICA] DEVICE_TOKEN diferente do .env`: o token do `segredos.h` não é igual ao `DEVICE_TOKEN` da API.
- `[DICA] confira API_BASE, firewall...`: use o IPv4 do PC (`ipconfig`), inicie a API com `--host 0.0.0.0` e libere a porta 5000 no firewall (rede privada).
- `[DICA] cadastre o cartão ...`: o UID do cartão não está em nenhum usuário ativo.
- `[DICA] cadastre uma chave com sensor_id N`: falta a chave com esse `sensor_id` no site.
- Ao ligar com uma chave ausente e sem empréstimo, o painel mostra alerta de retirada sem autorização: está correto, a chave realmente não está no armário.
- Leitor RFID `SEM RESPOSTA`: confira a ligação e a alimentação em 3,3 V.
- ESP32 reiniciando quando o motor gira: ruído da fonte; confira o GND comum e os capacitores.

## Regras principais

- Retirada, devolução, hora e responsável nunca são editados nem apagados. Horários ficam em UTC no banco; as telas mostram o horário local.
- Os reeds são a fonte de verdade. Pegar uma chave diferente da escolhida, ou uma reservada por outra pessoa, não bloqueia: registra quem pegou.
- Reed que muda sem sessão ativa vira retirada sem autorização e gera alerta.
- A sessão física termina com o mesmo cartão de novo, com "Encerrar" no totem ou por inatividade.

## Estado atual

- Pronto e testado: API (sessão física, reeds, poll, totem, estado das chaves, histórico, login com aviso de conta desativada), site completo (chaves com estado real, reservas e cancelamento, painel do admin, gestão de usuários com cartão RFID, login único, uso no celular) e tela do totem.
- Firmware: leitura do cartão e comunicação com a API testadas. **Reeds, LEDs e fila de eventos estão escritos, mas ainda não foram testados em hardware**; o motor também não.
- Pendente: testes de hardware (roteiro acima) e implantação no Raspberry Pi, que hospedará API e site.
- Decisões: todos os usuários logados veem quem está com cada chave. Sessão do site expira em 60 minutos. Sem limite de duração ou antecedência de reserva por enquanto.

## Segredos

Não versionar `.env`, bancos `.db`, `segredos.h` nem `.venv` (já estão no `.gitignore`; confira antes do primeiro commit). Troque `FLASK_SECRET_KEY`, `JWT_SECRET_KEY`, `DEVICE_TOKEN` e `TERMINAL_TOKEN` antes de usar fora de testes.