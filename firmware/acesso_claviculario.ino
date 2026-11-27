/*
 * Claviculario - firmware ESP32 (fatia 4: reeds e LEDs, sistema completo)
 *
 *  - Cartao lido: POST /api/device/card (a API abre ou encerra a sessao).
 *  - A cada 1 s: GET /api/device/poll. A porta segue o campo "door" e os
 *    4 LEDs seguem o campo "leds" (cor e piscar calculados pela API).
 *  - Reeds: cada mudanca (chave saiu/voltou) vai para POST /api/device/reeds,
 *    com fila e reenvio (mesmo event_id) se a API estiver fora do ar.
 *  - Sem resposta da API por 30 s com a porta aberta: fecha.
 *  - Sem resposta da API: os LEDs mostram so verde (presente) ou vermelho
 *    (ausente) pelo reed, sem piscar.
 *
 * Bibliotecas: MFRC522 e ArduinoJson 7.x (Gerenciador de Bibliotecas).
 * WiFi, HTTPClient, SPI e Preferences vem no core ESP32.
 *
 * PINAGEM (ESP32 DevKit 38 pinos, WROOM-32)
 *  RC522 (3.3V): SS 5 | SCK 18 | MISO 19 | MOSI 23 | RST 22
 *  Ponte H:      IN1 16 | IN2 17 | PWM 4   (TB6612: STBY em 3.3V)
 *  Reeds:        chave 1 = 34 | 2 = 35 | 3 = 36 | 4 = 39
 *                (so entrada: resistor externo de 10k do pino ao 3.3V;
 *                 o outro fio do reed vai ao GND; ima perto = LOW = presente)
 *  LEDs (R / G): chave 1 = 32 / 33 | 2 = 25 / 26 | 3 = 27 / 14 | 4 = 13 / 21
 *                (resistor em serie em cada perna; azul nao usado;
 *                 amarelo = vermelho + verde ligados juntos)
 *  O reed N corresponde a chave com sensor_id = N no cadastro do site.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include "segredos.h"

// ================== AJUSTES ==================
const char* DEVICE_ID = "esp32-001";

const int PINO_SS = 5, PINO_RST = 22;
const int PINO_IN1 = 16, PINO_IN2 = 17, PINO_PWM = 4;

const int NUM_CHAVES = 4;
const int PINOS_REED[NUM_CHAVES]  = {34, 35, 36, 39};
const int PINOS_LED_R[NUM_CHAVES] = {32, 25, 27, 13};
const int PINOS_LED_G[NUM_CHAVES] = {33, 26, 14, 21};

// false = LED de CATODO comum (terminal comum no GND, pino HIGH acende)
// true  = LED de ANODO comum  (terminal comum no 3.3V, pino LOW acende)
// Se no teste da partida os LEDs ficarem acesos quando deveriam estar
// apagados (ou tudo estranho), troque este valor.
const bool LED_ANODO_COMUM = false;
const unsigned long PISCA_MS = 500;      // periodo completo do piscar

const unsigned long DEBOUNCE_MS = 80;    // filtro de trepidacao dos reeds
const unsigned long REENVIO_REED_MS = 2000;
const int FILA_MAX = 16;                 // eventos de reed guardados se a API cair

const unsigned long TEMPO_ABRIR_MS = 600;
const unsigned long TEMPO_FECHAR_MS = 600;
const int VELOCIDADE = 200;              // 0 a 255
const bool INVERTER_MOTOR = false;       // true se abrir e fechar estiverem trocados
const bool FECHAR_AO_LIGAR = false;      // so ligue (true) depois de ter batente mecanico

const unsigned long INTERVALO_POLL_MS = 1000;
const unsigned long SEM_API_FECHA_MS = 30000;
const unsigned long INTERVALO_WIFI_MS = 10000;
const unsigned long REPETIDO_MS = 2000;
// =============================================

MFRC522 rfid(PINO_SS, PINO_RST);
Preferences prefs;

bool portaAberta = false;
volatile bool apiOk = true;
volatile bool ledsValidos = false;       // true quando o ultimo poll trouxe os LEDs
uint32_t contador = 0;
unsigned long ultimoPoll = 0, ultimaResposta = 0, ultimaTentativaWiFi = 0;
unsigned long ultimaLeitura = 0, ultimaChecagemLeitor = 0;
String ultimoUID;

// reeds
volatile bool reedPresente[NUM_CHAVES];  // estado estavel (apos o filtro)
bool reedLido[NUM_CHAVES];               // ultima leitura crua
unsigned long reedMudouEm[NUM_CHAVES];

struct EventoReed {
  int chave;          // 0 a 3
  bool presente;
  uint32_t numero;    // faz parte do event_id; fixo nos reenvios
  String quando;      // "" se a hora ainda nao estava sincronizada
};
EventoReed fila[FILA_MAX];
int filaIni = 0, filaTam = 0;
unsigned long ultimoEnvioReed = 0;
bool falhouReed = false;

// LEDs (escritos pelo poll, lidos pela tarefa dos LEDs)
volatile uint8_t corLed[NUM_CHAVES];     // 0 apagado, 1 vermelho, 2 amarelo, 3 verde
volatile bool piscaLed[NUM_CHAVES];

// ---------- motor ----------
void girar(bool abrindo, unsigned long duracao) {
  bool sentido = abrindo != INVERTER_MOTOR;
  digitalWrite(PINO_IN1, sentido ? HIGH : LOW);
  digitalWrite(PINO_IN2, sentido ? LOW : HIGH);
  analogWrite(PINO_PWM, VELOCIDADE);
  delay(duracao);
  analogWrite(PINO_PWM, 0);
  digitalWrite(PINO_IN1, LOW);
  digitalWrite(PINO_IN2, LOW);
}

void moverPorta(bool abrir) {
  if (abrir == portaAberta) return;
  Serial.println(abrir ? "[PORTA] abrindo..." : "[PORTA] fechando...");
  girar(abrir, abrir ? TEMPO_ABRIR_MS : TEMPO_FECHAR_MS);
  portaAberta = abrir;
  Serial.println(abrir ? "[PORTA] ABERTA" : "[PORTA] FECHADA");
}

// ---------- LEDs ----------
const int LED_LIGADO = LED_ANODO_COMUM ? LOW : HIGH;
const int LED_DESLIGADO = LED_ANODO_COMUM ? HIGH : LOW;

void setLed(int i, bool vermelho, bool verde) {
  digitalWrite(PINOS_LED_R[i], vermelho ? LED_LIGADO : LED_DESLIGADO);
  digitalWrite(PINOS_LED_G[i], verde ? LED_LIGADO : LED_DESLIGADO);
}

// Roda em paralelo ao loop, entao o piscar nao trava durante chamadas HTTP ou motor.
void tarefaLeds(void*) {
  for (;;) {
    bool fase = ((millis() / (PISCA_MS / 2)) % 2) == 0;
    for (int i = 0; i < NUM_CHAVES; i++) {
      uint8_t cor;
      bool pisca;
      if (ledsValidos) {
        cor = corLed[i];
        pisca = piscaLed[i];
      } else {                            // sem API: so o reed decide
        cor = reedPresente[i] ? 3 : 1;
        pisca = false;
      }
      bool aceso = !pisca || fase;
      setLed(i, aceso && (cor == 1 || cor == 2), aceso && (cor == 2 || cor == 3));
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// Mostra cada LED em vermelho, verde e depois todos em amarelo.
void testeLeds() {
  Serial.println("[LED] teste: vermelho, verde e amarelo");
  for (int i = 0; i < NUM_CHAVES; i++) {
    setLed(i, true, false);  delay(250);
    setLed(i, false, true);  delay(250);
    setLed(i, false, false);
  }
  for (int i = 0; i < NUM_CHAVES; i++) setLed(i, true, true);
  delay(500);
  for (int i = 0; i < NUM_CHAVES; i++) setLed(i, false, false);
}

void aplicarLeds(JsonArrayConst leds) {
  for (JsonObjectConst item : leds) {
    int i = atoi(item["sensor_id"] | "0") - 1;
    if (i < 0 || i >= NUM_CHAVES) continue;
    const char* cor = item["color"] | "off";
    corLed[i] = !strcmp(cor, "red") ? 1 : !strcmp(cor, "yellow") ? 2 : !strcmp(cor, "green") ? 3 : 0;
    piscaLed[i] = item["blink"] | false;
  }
  ledsValidos = true;
}

// ---------- rede ----------
// Faz o pedido e devolve o codigo HTTP (<= 0 = sem comunicacao).
int pedir(const char* rota, const String& corpo, String& resposta) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.begin(String(API_BASE) + rota);
  http.setConnectTimeout(2000);
  http.setTimeout(3000);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  int codigo;
  if (corpo.length()) {
    http.addHeader("Content-Type", "application/json");
    codigo = http.POST(corpo);
  } else {
    codigo = http.GET();
  }
  resposta = codigo > 0 ? http.getString() : "";
  resposta.trim();
  http.end();
  return codigo;
}

void consultarApi() {
  String resposta;
  int codigo = pedir("/api/device/poll", "", resposta);

  JsonDocument doc;
  bool ok = false, abrir = false;
  if (codigo == 200 && deserializeJson(doc, resposta) == DeserializationError::Ok) {
    const char* porta = doc["door"] | "";
    if (!strcmp(porta, "open")) { abrir = true; ok = true; }
    else if (!strcmp(porta, "closed")) { ok = true; }
  }

  if (ok) {
    if (!apiOk) Serial.println("[API] comunicacao restabelecida");
    apiOk = true;
    ultimaResposta = millis();
    aplicarLeds(doc["leds"].as<JsonArrayConst>());
    moverPorta(abrir);
  } else {
    ledsValidos = false;                  // LEDs voltam a seguir so os reeds
    if (apiOk) {
      apiOk = false;
      Serial.printf("[API] falha na consulta (codigo %d) %s\n", codigo, resposta.c_str());
      if (codigo == 401) Serial.println("[DICA] DEVICE_TOKEN diferente do .env");
      if (codigo <= 0) Serial.println("[DICA] confira API_BASE, firewall e se a API usa --host 0.0.0.0");
    }
  }
}

void cuidarWiFi() {
  static bool estava = false;
  bool conectado = WiFi.status() == WL_CONNECTED;
  if (conectado != estava) {
    estava = conectado;
    if (conectado) Serial.printf("[WIFI] conectado, IP %s\n", WiFi.localIP().toString().c_str());
    else Serial.println("[WIFI] desconectado");
  }
  if (!conectado && millis() - ultimaTentativaWiFi >= INTERVALO_WIFI_MS) {
    ultimaTentativaWiFi = millis();
    Serial.println("[WIFI] tentando conectar...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// "2026-11-20T13:05:00Z" ou "" se a hora ainda nao foi sincronizada
String horaUTC() {
  struct tm t;
  if (!getLocalTime(&t, 10) || t.tm_year < (2024 - 1900)) return "";
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

// ---------- reeds ----------
void enfileirarReed(int chave, bool presente) {
  if (filaTam == FILA_MAX) {
    Serial.println("[AVISO] fila de reeds cheia; descartando o evento mais antigo");
    filaIni = (filaIni + 1) % FILA_MAX;
    filaTam--;
  }
  contador++;
  prefs.putUInt("cnt", contador);
  EventoReed& e = fila[(filaIni + filaTam) % FILA_MAX];
  e.chave = chave;
  e.presente = presente;
  e.numero = contador;
  e.quando = horaUTC();
  filaTam++;
}

// Detecta mudanca estavel (filtro de trepidacao) e coloca na fila.
void lerReeds() {
  unsigned long agora = millis();
  for (int i = 0; i < NUM_CHAVES; i++) {
    bool presente = digitalRead(PINOS_REED[i]) == LOW;   // ima perto = LOW
    if (presente != reedLido[i]) {
      reedLido[i] = presente;
      reedMudouEm[i] = agora;
    } else if (presente != reedPresente[i] && agora - reedMudouEm[i] >= DEBOUNCE_MS) {
      reedPresente[i] = presente;
      Serial.printf("[REED] chave %d: %s\n", i + 1, presente ? "PRESENTE" : "AUSENTE");
      enfileirarReed(i, presente);
    }
  }
}

// Envia o evento mais antigo da fila; se falhar, tenta de novo depois (mesmo event_id).
void enviarFilaReeds() {
  if (filaTam == 0) return;
  if (falhouReed && millis() - ultimoEnvioReed < REENVIO_REED_MS) return;

  EventoReed& e = fila[filaIni];
  String corpo = "{\"event_id\":\"" + String(DEVICE_ID) + "-reed-" + String(e.numero) +
                 "\",\"sensor_id\":\"" + String(e.chave + 1) +
                 "\",\"present\":" + (e.presente ? "true" : "false");
  if (e.quando.length()) corpo += ",\"occurred_at\":\"" + e.quando + "\"";
  corpo += "}";

  String resposta;
  int codigo = pedir("/api/device/reeds", corpo, resposta);
  ultimoEnvioReed = millis();
  Serial.printf("[REED] envio chave %d %s: HTTP %d %s\n", e.chave + 1,
                e.presente ? "presente" : "ausente", codigo, resposta.c_str());

  // 2xx e 4xx (exceto 401/403): a API respondeu, nao adianta reenviar.
  bool entregue = codigo > 0 && codigo < 500 && codigo != 401 && codigo != 403;
  if (entregue) {
    if (codigo == 404) Serial.printf("[DICA] cadastre uma chave com sensor_id %d\n", e.chave + 1);
    falhouReed = false;
    filaIni = (filaIni + 1) % FILA_MAX;
    filaTam--;
    ultimoPoll = 0;                       // atualiza os LEDs logo em seguida
  } else {
    falhouReed = true;
    if (codigo == 401 || codigo == 403) Serial.println("[DICA] DEVICE_TOKEN diferente do .env");
  }
}

// ---------- cartao ----------
void enviarCartao(const String& uid) {
  contador++;
  prefs.putUInt("cnt", contador);
  String corpo = "{\"event_id\":\"" + String(DEVICE_ID) + "-card-" + String(contador) +
                 "\",\"rfid_uid\":\"" + uid + "\"";
  String quando = horaUTC();
  if (quando.length()) corpo += ",\"occurred_at\":\"" + quando + "\"";
  corpo += "}";

  // Reenvia com o mesmo event_id: a API nao aplica duas vezes.
  for (int tentativa = 1; tentativa <= 3; tentativa++) {
    String resposta;
    int codigo = pedir("/api/device/card", corpo, resposta);
    Serial.printf("[CARTAO] tentativa %d: HTTP %d %s\n", tentativa, codigo, resposta.c_str());
    if (codigo > 0 && codigo < 500) {
      if (codigo == 404) Serial.printf("[DICA] cadastre o cartao %s em um usuario\n", uid.c_str());
      return;
    }
    delay(500);
  }
  Serial.println("[ERRO] cartao nao entregue; passe novamente");
}

void lerCartao() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  String uid;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  if (uid == ultimoUID && millis() - ultimaLeitura < REPETIDO_MS) return;
  Serial.printf("\n[CARTAO] UID %s\n", uid.c_str());
  enviarCartao(uid);
  ultimoUID = uid;
  ultimaLeitura = millis();
  consultarApi();  // reage sem esperar o proximo ciclo
}

void cuidarLeitor() {
  if (millis() - ultimaChecagemLeitor < 30000) return;
  ultimaChecagemLeitor = millis();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (v == 0x00 || v == 0xFF) {
    Serial.println("[ERRO] leitor RFID sem resposta; reiniciando o modulo");
    rfid.PCD_Init();
  }
}

// ---------- principal ----------
void setup() {
  pinMode(PINO_IN1, OUTPUT);
  pinMode(PINO_IN2, OUTPUT);
  pinMode(PINO_PWM, OUTPUT);
  digitalWrite(PINO_IN1, LOW);
  digitalWrite(PINO_IN2, LOW);
  digitalWrite(PINO_PWM, LOW);

  for (int i = 0; i < NUM_CHAVES; i++) {
    pinMode(PINOS_LED_R[i], OUTPUT);
    pinMode(PINOS_LED_G[i], OUTPUT);
    setLed(i, false, false);
    pinMode(PINOS_REED[i], INPUT);        // 34/35/36/39: pull-up EXTERNO de 10k
  }

  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== CLAVICULARIO ===");
  Serial.printf("API: %s\n", API_BASE);

  prefs.begin("claviculario", false);
  contador = prefs.getUInt("cnt", 0);

  testeLeds();

  if (FECHAR_AO_LIGAR) {
    Serial.println("[PORTA] posicionando em fechada");
    girar(false, TEMPO_FECHAR_MS);
  }

  // Estado inicial dos reeds: informa a API (repeticoes nao geram mudanca).
  delay(100);
  for (int i = 0; i < NUM_CHAVES; i++) {
    bool presente = digitalRead(PINOS_REED[i]) == LOW;
    reedLido[i] = presente;
    reedPresente[i] = presente;
    reedMudouEm[i] = millis();
    Serial.printf("[REED] chave %d: %s (partida)\n", i + 1, presente ? "PRESENTE" : "AUSENTE");
    enfileirarReed(i, presente);
  }
  xTaskCreate(tarefaLeds, "leds", 3072, NULL, 1, NULL);

  SPI.begin(18, 19, 23, PINO_SS);
  rfid.PCD_Init();
  delay(50);
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("Leitor RFID: 0x%02X %s\n", v, (v == 0x00 || v == 0xFF) ? "SEM RESPOSTA (confira a ligacao)" : "OK");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  ultimaTentativaWiFi = millis();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

void loop() {
  cuidarWiFi();
  cuidarLeitor();
  lerCartao();
  lerReeds();
  enviarFilaReeds();

  if (millis() - ultimoPoll >= INTERVALO_POLL_MS) {
    consultarApi();
    ultimoPoll = millis();
  }

  if (portaAberta && millis() - ultimaResposta >= SEM_API_FECHA_MS) {
    Serial.println("[AVISO] sem resposta da API; fechando a porta");
    moverPorta(false);
  }
  delay(10);
}