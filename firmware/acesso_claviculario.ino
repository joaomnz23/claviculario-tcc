/*
 * Claviculario - firmware ESP32 (fatia 2: sessao fisica e porta com motor)
 *
 *  - Cartao lido: POST /api/device/card (a API abre ou encerra a sessao).
 *  - A cada 1 s: GET /api/device/poll. A porta segue o campo "door".
 *  - Sem resposta da API por 30 s com a porta aberta: fecha.
 *
 * Bibliotecas: MFRC522 (WiFi, HTTPClient, SPI e Preferences vem no core ESP32).
 * RC522 (3.3V): SS 5 | SCK 18 | MISO 19 | MOSI 23 | RST 22
 * Ponte H:      IN1 16 | IN2 17 | PWM/EN 4
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <time.h>
#include "segredos.h"

// ================== AJUSTES ==================
const char* DEVICE_ID = "esp32-001";

const int PINO_SS = 5, PINO_RST = 22;
const int PINO_IN1 = 16, PINO_IN2 = 17, PINO_PWM = 4;

const unsigned long TEMPO_ABRIR_MS = 600;
const unsigned long TEMPO_FECHAR_MS = 600;
const int VELOCIDADE = 200;             // 0 a 255
const bool INVERTER_MOTOR = false;      // true se abrir e fechar estiverem trocados
const bool FECHAR_AO_LIGAR = true;      // exige batente mecanico

const unsigned long INTERVALO_POLL_MS = 1000;
const unsigned long SEM_API_FECHA_MS = 30000;
const unsigned long INTERVALO_WIFI_MS = 10000;
const unsigned long REPETIDO_MS = 2000;
// =============================================

MFRC522 rfid(PINO_SS, PINO_RST);
Preferences prefs;

bool portaAberta = false;
bool apiOk = true;
uint32_t contador = 0;
unsigned long ultimoPoll = 0, ultimaResposta = 0, ultimaTentativaWiFi = 0;
unsigned long ultimaLeitura = 0, ultimaChecagemLeitor = 0;
String ultimoUID;

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
  String compacta = resposta;
  compacta.replace(" ", "");
  compacta.replace("\n", "");
  bool abrir = compacta.indexOf("\"door\":\"open\"") >= 0;
  bool fechar = compacta.indexOf("\"door\":\"closed\"") >= 0;

  if (codigo == 200 && (abrir || fechar)) {
    if (!apiOk) Serial.println("[API] comunicacao restabelecida");
    apiOk = true;
    ultimaResposta = millis();
    moverPorta(abrir);
  } else if (apiOk) {
    apiOk = false;
    Serial.printf("[API] falha na consulta (codigo %d) %s\n", codigo, resposta.c_str());
    if (codigo == 401) Serial.println("[DICA] DEVICE_TOKEN diferente do .env");
    if (codigo <= 0) Serial.println("[DICA] confira API_BASE, firewall e se a API usa --host 0.0.0.0");
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

  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== CLAVICULARIO ===");
  Serial.printf("API: %s\n", API_BASE);

  if (FECHAR_AO_LIGAR) {
    Serial.println("[PORTA] posicionando em fechada");
    girar(false, TEMPO_FECHAR_MS);
  }

  prefs.begin("claviculario", false);
  contador = prefs.getUInt("cnt", 0);

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

  if (millis() - ultimoPoll >= INTERVALO_POLL_MS) {
    consultarApi();
    ultimoPoll = millis();
  }

  if (portaAberta && millis() - ultimaResposta >= SEM_API_FECHA_MS) {
    Serial.println("[AVISO] sem resposta da API; fechando a porta");
    moverPorta(false);
  }
  delay(20);
}
