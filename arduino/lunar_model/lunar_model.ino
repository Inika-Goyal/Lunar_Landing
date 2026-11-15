/*
  Lunar Landing Site Navigator: tabletop model
  NASA Space Apps Challenge 2026

  Talks to index.html over Web Serial at 115200 baud.

  RECEIVES (from the app, newline-terminated, whenever time or site changes, plus a 2 s heartbeat):
    M,<turntableDeg>,<sunServoDeg>,<earthServoDeg>,<lit 0/1>,<comms 0/1>,<battery 0-100>,<hoursToDark>,<siteName>
    (earthServoDeg is ignored: this build has no Earth arm)

  SENDS (about 10 times a second):
    S,<sunLight 0-1023>,<earthSignal>,<ambient>,<knob 0-1023>,<button 0/1>,<irCode>
    Parts that are not fitted are sent as -1 (earthSignal, ambient), and the app skips them.

  How the model works
    A turntable spins the 3D-printed site so the Sun arm points along the Sun's azimuth.
    One servo arm lifts the Sun LED to the (exaggerated) elevation the app computes.
    A light sensor on the lander reads whether the terrain shadows the Sun LED; the app
    compares that with its own prediction.
    The Earth LED lights when the app predicts a radio link to Earth. It blinks slowly when the
    battery is critical and fast when the lander is lost.

  Parts (Arduino Uno or Nano)
    1x 28BYJ-48 stepper + ULN2003 driver        turntable
    1x SG90 / MG90S servo                       Sun arm
    1x warm white or amber LED + 220 ohm        Sun
    1x blue LED + 220 ohm                       Earth link / battery warning
    1x LDR (photoresistor) + 10k                lander Sun sensor
    1x 10k potentiometer                        time knob
    1x push button                              start / acknowledge story mode

  Wiring
    Stepper IN1..IN4  -> D8, D9, D10, D11   (ULN2003 powered from 5V; for long runs use an external 5V)
    Sun servo signal  -> D2
    Servo power       -> 5V (an external 5V supply is safer; join its ground to the Arduino's GND)
    Sun LED           -> D3 (PWM) through 220 ohm to GND
    Earth LED         -> D5 through 220 ohm to GND
    Button            -> D4 to GND (uses the internal pull-up, no resistor needed)
    Sun sensor        -> A1 as a divider: 5V - LDR - A1 - 10k - GND
    Potentiometer     -> wiper to A0, ends to 5V and GND
    On-board LED D13 lights when the app predicts sunlight (nothing to wire).

  Calibrating
    Open the app, connect, open Menu -> The Model. The RX line shows the raw numbers.
    Put the lander in full "sunlight" and in shadow, then set the Lit threshold halfway between.
    Turn off "Subtract ambient light" (there is no ambient sensor in this build).
    If the arm moves the wrong way flip SUN_DIR below; use SUN_TRIM to level it.
    If the turntable spins the wrong way set TURN_DIR to -1.
*/

#include <Servo.h>

// ---------------------------------------------------------------- pins
const uint8_t STEP_PINS[4]   = {8, 9, 10, 11};
const uint8_t PIN_SUN_SERVO  = 2;
const uint8_t PIN_SUN_LED    = 3;    // PWM
const uint8_t PIN_BUTTON     = 4;
const uint8_t PIN_EARTH_LED  = 5;
const uint8_t PIN_PRED_LED   = 13;   // on-board LED
const uint8_t PIN_KNOB       = A0;
const uint8_t PIN_SUN_SENSOR = A1;

// ---------------------------------------------------------------- tuning
const long  STEPS_PER_REV   = 4096;   // 28BYJ-48 in half-step mode (about 4076 on many units)
const int   TURN_DIR        = 1;      // -1 if the turntable spins the wrong way
const unsigned STEP_US      = 1200;   // microseconds between half-steps (lower = faster, too low stalls)
const int   SUN_DIR = 1, SUN_TRIM = 0;   // servo direction and centre trim (degrees)
const unsigned SERVO_STEP_MS = 12;    // ms per servo degree; smooth instead of snapping
const uint8_t SUN_BRIGHTNESS = 255;   // Sun LED PWM
const unsigned SEND_EVERY_MS = 100;   // S line rate (~10 Hz)
const unsigned long LINK_TIMEOUT_MS = 6000;  // no M line for this long -> idle (park, LEDs low)

// ---------------------------------------------------------------- state
Servo sunServo;
long  stepPos = 0, stepTarget = 0;
uint8_t phase = 0;
unsigned long lastStepUs = 0, lastMoveMs = 0;
bool coilsOn = false;

int sunServoPos = 90, sunServoTarget = 90;
unsigned long lastServoMs = 0;

int predLit = 0, predComms = 0, battery = 100, hoursToDark = 0;
char siteName[40] = "";
unsigned long lastMsgMs = 0;
bool linked = false;

char lineBuf[112];
uint8_t lineLen = 0;

int buttonStable = 0, buttonLast = 0;
unsigned long buttonChangeMs = 0;
unsigned long lastSendMs = 0;

const uint8_t HALF_STEP[8][4] = {
  {1,0,0,0},{1,1,0,0},{0,1,0,0},{0,1,1,0},{0,0,1,0},{0,0,1,1},{0,0,0,1},{1,0,0,1}
};

// ---------------------------------------------------------------- stepper (non-blocking)
void writeCoils(uint8_t p) {
  for (uint8_t i = 0; i < 4; i++) digitalWrite(STEP_PINS[i], HALF_STEP[p][i]);
  coilsOn = true;
}
void releaseCoils() {
  for (uint8_t i = 0; i < 4; i++) digitalWrite(STEP_PINS[i], LOW);
  coilsOn = false;
}
void updateStepper() {
  if (stepPos == stepTarget) {
    // let the motor cool once it has been still for a moment
    if (coilsOn && millis() - lastMoveMs > 600) releaseCoils();
    return;
  }
  unsigned long now = micros();
  if (now - lastStepUs < STEP_US) return;
  lastStepUs = now;
  int dir = stepTarget > stepPos ? 1 : -1;
  stepPos += dir;
  phase = (phase + (dir * TURN_DIR > 0 ? 1 : 7)) & 7;
  writeCoils(phase);
  lastMoveMs = millis();
}

// ---------------------------------------------------------------- servo (eased one degree at a time)
int servoAngle(float appDeg) {
  // app sends -90..90 (asin result); servo wants 0..180 with 90 = level
  return constrain((int)lroundf(90 + SUN_DIR * appDeg + SUN_TRIM), 0, 180);
}
void updateServo() {
  unsigned long now = millis();
  if (now - lastServoMs < SERVO_STEP_MS) return;
  lastServoMs = now;
  if (sunServoPos != sunServoTarget) { sunServoPos += sunServoTarget > sunServoPos ? 1 : -1; sunServo.write(sunServoPos); }
}

// ---------------------------------------------------------------- incoming M lines
void handleLine(char *s) {
  if (s[0] != 'M' || s[1] != ',') return;
  float v[7];
  char *tok = strtok(s + 2, ",");
  for (uint8_t i = 0; i < 7; i++) {
    if (!tok) return;            // malformed: ignore the whole line
    v[i] = atof(tok);
    tok = strtok(NULL, ",");
  }
  // the site name is everything after the 8th comma (the app strips commas from names)
  if (tok) { strncpy(siteName, tok, sizeof(siteName) - 1); siteName[sizeof(siteName) - 1] = 0; }

  float turnDeg  = constrain(v[0], -180, 180);
  stepTarget     = lroundf(turnDeg / 360.0f * STEPS_PER_REV);
  sunServoTarget = servoAngle(v[1]);
  // v[2] = Earth servo angle: not used in this build
  predLit     = v[3] > 0.5f;
  predComms   = v[4] > 0.5f;
  battery     = constrain((int)v[5], 0, 100);
  hoursToDark = (int)v[6];

  digitalWrite(PIN_PRED_LED, predLit ? HIGH : LOW);
  lastMsgMs = millis();
  linked = true;
}
void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      lineBuf[lineLen] = 0;
      if (lineLen) handleLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;               // overlong line: drop it
    }
  }
}

// ---------------------------------------------------------------- inputs
int readAvg(uint8_t pin, uint8_t n) {
  long sum = 0;
  for (uint8_t i = 0; i < n; i++) sum += analogRead(pin);
  return sum / n;
}
void updateButton() {
  int raw = digitalRead(PIN_BUTTON) == LOW;   // pressed = LOW with pull-up
  if (raw != buttonLast) { buttonLast = raw; buttonChangeMs = millis(); }
  if (millis() - buttonChangeMs > 25) buttonStable = raw;
}

// ---------------------------------------------------------------- outputs
void updateLeds() {
  unsigned long now = millis();
  if (!linked) {
    // idle: slow "breathing" Sun LED so the model looks alive before the app connects
    int b = (int)(40 + 35 * sin(now / 900.0));
    analogWrite(PIN_SUN_LED, b);
    digitalWrite(PIN_EARTH_LED, LOW);
    return;
  }
  // the Sun LED stays steady: the lander sensor is reading it
  analogWrite(PIN_SUN_LED, SUN_BRIGHTNESS);
  // Earth LED: link status, overridden by the battery warning
  if (battery <= 0)       digitalWrite(PIN_EARTH_LED, (now / 150) % 2);   // fast blink: lander lost
  else if (battery < 20)  digitalWrite(PIN_EARTH_LED, (now / 500) % 2);   // slow blink: critical
  else                    digitalWrite(PIN_EARTH_LED, predComms ? HIGH : LOW);
}

void sendStatus() {
  unsigned long now = millis();
  if (now - lastSendMs < SEND_EVERY_MS) return;
  lastSendMs = now;
  int sunLight = readAvg(PIN_SUN_SENSOR, 4);
  int knob     = readAvg(PIN_KNOB, 4);
  Serial.print(F("S,"));
  Serial.print(sunLight);     Serial.print(F(",-1,-1,"));   // no Earth sensor, no ambient sensor
  Serial.print(knob);         Serial.print(',');
  Serial.print(buttonStable); Serial.println(F(",0"));      // no IR receiver
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 4; i++) pinMode(STEP_PINS[i], OUTPUT);
  pinMode(PIN_SUN_LED, OUTPUT);
  pinMode(PIN_EARTH_LED, OUTPUT);
  pinMode(PIN_PRED_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  sunServo.attach(PIN_SUN_SERVO);
  sunServo.write(sunServoPos);
  // The turntable has no home switch: power up with the Sun arm pointing at the
  // model's "north" mark. That position is 0 degrees.
  stepPos = stepTarget = 0;
}

void loop() {
  readSerial();
  updateStepper();
  updateServo();
  updateButton();
  updateLeds();
  sendStatus();

  // app went away: park the arm level and go idle (turntable stays put)
  if (linked && millis() - lastMsgMs > LINK_TIMEOUT_MS) {
    linked = false;
    sunServoTarget = 90;
    digitalWrite(PIN_PRED_LED, LOW);
  }
}
