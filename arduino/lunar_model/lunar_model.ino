/*
  Lunar Landing Site Navigator: tabletop model
  NASA Space Apps Challenge 2026

  Talks to index.html over Web Serial at 115200 baud.

  RECEIVES (from the app, newline-terminated, whenever time or site changes):
    M,<turntableDeg>,<sunServoDeg>,<earthServoDeg>,<lit 0/1>,<comms 0/1>,<battery 0-100>,<hoursToDark>,<siteName>

  SENDS (about 10 times a second):
    S,<sunLight 0-1023>,<earthSignal>,<ambient>,<knob 0-1023>,<button 0/1>,<irCode>

  How the model works
    A turntable spins the 3D-printed site so the Sun arm points along the Sun's azimuth.
    Two servo arms lift a Sun LED and an Earth LED to the (exaggerated) elevation the app computes.
    A light sensor on the lander reads whether the terrain shadows the Sun LED.
    A second sensor reads the Earth LED. The Earth LED is blinked fast and the sensor is
    read with the LED on and off. The difference ignores room light, so it acts like a "radio link".
    An ambient sensor facing up lets the app subtract room light from the Sun reading.

  Parts (Arduino Uno or Nano)
    1x 28BYJ-48 stepper + ULN2003 driver        turntable
    2x SG90 / MG90S servo                       Sun arm, Earth arm
    1x warm white or amber LED + 220 ohm        Sun
    1x blue LED + 220 ohm                       Earth
    1x red LED + 220 ohm                        battery warning
    3x LDR (photoresistor) + 10k each           lander Sun sensor, lander Earth sensor, ambient
    1x 10k potentiometer                        time knob
    1x push button                              start / acknowledge story mode
    optional: IR receiver (VS1838B / TSOP38238) + remote, needs the IRremote library (4.x)

  Wiring
    Stepper IN1..IN4 -> D2, D4, D7, D8  (ULN2003 powered from 5V; for long runs use an external 5V)
    Sun servo signal   -> D9           Earth servo signal -> D10
    Servo power        -> external 5V supply, grounds joined with the Arduino's GND
    Sun LED            -> D5  (PWM) through 220 ohm to GND
    Earth LED          -> D6  through 220 ohm to GND
    Battery LED (red)  -> D3  through 220 ohm to GND
    Predicted-sunlit   -> on-board LED D13 (lights when the app predicts sunlight)
    LDR dividers (5V - LDR - analog pin - 10k - GND):
        lander Sun sensor -> A0, lander Earth sensor -> A1, ambient sensor -> A2
        (shield the Earth sensor in a short black tube pointing at the Earth arm)
    Potentiometer wiper -> A3 (ends to 5V and GND)
    Button             -> D12 to GND (uses the internal pull-up)
    IR receiver OUT    -> D11 (only if USE_IR is 1)

  Calibrating
    Open the app, connect, open Menu -> The Model. The RX line shows the raw numbers.
    Put the lander in full "sunlight" and in shadow, then set the Lit threshold halfway between.
    Do the same for the Earth-signal threshold with the Earth arm visible and blocked.
    If an arm moves the wrong way, flip SUN_DIR / EARTH_DIR below. Use the *_TRIM values to level them.
*/

#include <Servo.h>

// ---------------------------------------------------------------- options
#define USE_IR 0              // 1 = read an IR remote (install "IRremote" by shirriff/z3t0, v4.x)

#if USE_IR
#include <IRremote.hpp>
#endif

// ---------------------------------------------------------------- pins
const uint8_t STEP_PINS[4] = {2, 4, 7, 8};
const uint8_t PIN_SUN_SERVO   = 9;
const uint8_t PIN_EARTH_SERVO = 10;
const uint8_t PIN_SUN_LED     = 5;
const uint8_t PIN_EARTH_LED   = 6;
const uint8_t PIN_BATT_LED    = 3;
const uint8_t PIN_PRED_LED    = 13;
const uint8_t PIN_BUTTON      = 12;
const uint8_t PIN_IR          = 11;
const uint8_t PIN_SUN_SENSOR   = A0;
const uint8_t PIN_EARTH_SENSOR = A1;
const uint8_t PIN_AMBIENT      = A2;
const uint8_t PIN_KNOB         = A3;

// ---------------------------------------------------------------- tuning
const long  STEPS_PER_REV   = 4096;   // 28BYJ-48 in half-step mode (about 4076 on many units)
const int   TURN_DIR        = 1;      // -1 if the turntable spins the wrong way
const unsigned STEP_US      = 1200;   // microseconds between half-steps (lower = faster, too low stalls)
const int   SUN_DIR = 1,   SUN_TRIM = 0;     // servo direction and centre trim (degrees)
const int   EARTH_DIR = 1, EARTH_TRIM = 0;
const unsigned SERVO_STEP_MS = 12;    // ms per servo degree; smooth instead of snapping
const uint8_t SUN_BRIGHTNESS = 255;   // Sun LED PWM
const unsigned SEND_EVERY_MS = 100;   // S line rate (~10 Hz)
const unsigned long LINK_TIMEOUT_MS = 6000;  // no M line for this long -> idle (park, LEDs low)

// ---------------------------------------------------------------- state
Servo sunServo, earthServo;
float turnTargetDeg = 0;
long  stepPos = 0, stepTarget = 0;
uint8_t phase = 0;
unsigned long lastStepUs = 0, lastMoveMs = 0;
bool coilsOn = false;

int sunServoPos = 90, sunServoTarget = 90;
int earthServoPos = 90, earthServoTarget = 90;
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
unsigned long irCode = 0;

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

// ---------------------------------------------------------------- servos (eased one degree at a time)
int servoAngle(float appDeg, int dir, int trim) {
  // app sends -90..90 (asin result); servo wants 0..180 with 90 = level
  return constrain((int)lroundf(90 + dir * appDeg + trim), 0, 180);
}
void updateServos() {
  unsigned long now = millis();
  if (now - lastServoMs < SERVO_STEP_MS) return;
  lastServoMs = now;
  if (sunServoPos != sunServoTarget)     { sunServoPos += sunServoTarget > sunServoPos ? 1 : -1;       sunServo.write(sunServoPos); }
  if (earthServoPos != earthServoTarget) { earthServoPos += earthServoTarget > earthServoPos ? 1 : -1; earthServo.write(earthServoPos); }
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

  turnTargetDeg    = constrain(v[0], -180, 180);
  stepTarget       = lroundf(turnTargetDeg / 360.0f * STEPS_PER_REV);
  sunServoTarget   = servoAngle(v[1], SUN_DIR, SUN_TRIM);
  earthServoTarget = servoAngle(v[2], EARTH_DIR, EARTH_TRIM);
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

// ---------------------------------------------------------------- sensors
int readAvg(uint8_t pin, uint8_t n) {
  long sum = 0;
  for (uint8_t i = 0; i < n; i++) sum += analogRead(pin);
  return sum / n;
}
// Earth "radio": the Earth LED blinks at ~330 Hz (looks steady to the eye). The sensor is read at the
// end of each on and off half-period, and on-minus-off cancels room light. Non-blocking, so the
// turntable keeps stepping smoothly.
const unsigned EARTH_HALF_US = 1500;
bool earthOn = true;
unsigned long earthToggleUs = 0;
long earthAcc = 0;
uint8_t earthPairs = 0;
int earthOnRead = 0;
int earthSignal = 0;
void updateEarth() {
  unsigned long now = micros();
  if (now - earthToggleUs < EARTH_HALF_US) return;
  earthToggleUs = now;
  int r = analogRead(PIN_EARTH_SENSOR);          // settled reading for the half-period that just ended
  if (earthOn) earthOnRead = r;
  else {
    earthAcc += earthOnRead - r;
    if (++earthPairs >= 16) {
      earthSignal = constrain(earthAcc / earthPairs * 4, 0, 1023);   // x4 gain so the default threshold is usable
      earthAcc = 0; earthPairs = 0;
    }
  }
  earthOn = !earthOn;
  digitalWrite(PIN_EARTH_LED, earthOn ? HIGH : LOW);
}
void updateButton() {
  int raw = digitalRead(PIN_BUTTON) == LOW;   // pressed = LOW with pull-up
  if (raw != buttonLast) { buttonLast = raw; buttonChangeMs = millis(); }
  if (millis() - buttonChangeMs > 25) buttonStable = raw;
}
void updateIR() {
#if USE_IR
  if (IrReceiver.decode()) {
    if (!(IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT)) irCode = IrReceiver.decodedIRData.command;
    IrReceiver.resume();
  }
#endif
}

// ---------------------------------------------------------------- outputs
void updateLeds() {
  unsigned long now = millis();
  if (!linked) {
    // idle: slow "breathing" Sun LED so the model looks alive before the app connects
    int b = (int)(40 + 35 * sin(now / 900.0));
    analogWrite(PIN_SUN_LED, b);
    digitalWrite(PIN_BATT_LED, LOW);
    return;
  }
  analogWrite(PIN_SUN_LED, SUN_BRIGHTNESS);
  if (battery <= 0)       digitalWrite(PIN_BATT_LED, (now / 150) % 2);   // fast blink: lander lost
  else if (battery < 20)  digitalWrite(PIN_BATT_LED, (now / 500) % 2);   // slow blink: critical
  else                    digitalWrite(PIN_BATT_LED, LOW);
}

void sendStatus() {
  unsigned long now = millis();
  if (now - lastSendMs < SEND_EVERY_MS) return;
  lastSendMs = now;
  int sunLight    = readAvg(PIN_SUN_SENSOR, 4);
  int ambient     = readAvg(PIN_AMBIENT, 4);
  int knob        = readAvg(PIN_KNOB, 4);
  Serial.print(F("S,"));
  Serial.print(sunLight);    Serial.print(',');
  Serial.print(earthSignal); Serial.print(',');
  Serial.print(ambient);     Serial.print(',');
  Serial.print(knob);        Serial.print(',');
  Serial.print(buttonStable); Serial.print(',');
  Serial.println(irCode);
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 4; i++) pinMode(STEP_PINS[i], OUTPUT);
  pinMode(PIN_SUN_LED, OUTPUT);
  pinMode(PIN_EARTH_LED, OUTPUT);
  pinMode(PIN_BATT_LED, OUTPUT);
  pinMode(PIN_PRED_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  sunServo.attach(PIN_SUN_SERVO);
  earthServo.attach(PIN_EARTH_SERVO);
  sunServo.write(sunServoPos);
  earthServo.write(earthServoPos);
  digitalWrite(PIN_EARTH_LED, HIGH);
#if USE_IR
  IrReceiver.begin(PIN_IR, DISABLE_LED_FEEDBACK);
#endif
  // The turntable has no home switch: power up with the Sun arm pointing at the
  // model's "north" mark. That position is 0 degrees.
  stepPos = stepTarget = 0;
}

void loop() {
  readSerial();
  updateStepper();
  updateServos();
  updateEarth();
  updateButton();
  updateIR();
  updateLeds();
  sendStatus();

  // app went away: park the arms level and go idle (turntable stays put)
  if (linked && millis() - lastMsgMs > LINK_TIMEOUT_MS) {
    linked = false;
    sunServoTarget = earthServoTarget = 90;
    digitalWrite(PIN_PRED_LED, LOW);
  }
}
