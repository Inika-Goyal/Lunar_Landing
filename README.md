# Lunar_Landing

Lunar Landing Site Navigator, NASA Space Apps 2026. Open `index.html` through a local web server (it loads `sites.json`).

## Tabletop model (Arduino)

Sketch: `arduino/lunar_model/lunar_model.ino` (Uno or Nano, needs the Servo library). It talks to the app over Web Serial at 115200 baud: press **Connect model** in the app.

### Wiring

| Part | Pin | Notes |
|---|---|---|
| Stepper driver ULN2003 IN1–IN4 | D8, D9, D10, D11 | 28BYJ-48 turntable |
| Sun servo | D2 | Lifts the Sun LED to the Sun's elevation |
| Sun LED | D3 | Through 220 Ω to GND |
| Button | D4 | To GND (internal pull-up). Starts story mode or acknowledges a warning |
| Earth LED | D5 | Through 220 Ω to GND |
| Time knob (10k pot) | A0 | Wiper to A0, ends to 5V and GND |
| Sun light sensor (LDR) | A1 | 5V – LDR – A1 – 10k – GND |
| On-board LED | D13 | Nothing to wire. On when the app predicts sunlight |

Not used in this build: Earth servo, Earth sensor, ambient sensor, battery LED, IR receiver. The board sends `-1` for the missing sensors and the app skips them.

### What the LEDs mean

- **Sun LED**: always on while connected (the lander sensor reads it). Breathes slowly while waiting for the app.
- **Earth LED**: on when the app predicts a radio link to Earth. Blinks slowly when the battery is critical and fast when the lander is lost.

### Setup

1. Power up with the Sun arm pointing at the model's north mark (that is 0°; there is no home switch).
2. In the app open Menu → The Model, connect, and watch the RX line.
3. Set the Lit threshold halfway between the sensor reading in light and in shadow. Untick "Subtract ambient light".
4. If the arm moves the wrong way flip `SUN_DIR`; if the turntable spins the wrong way set `TURN_DIR` to `-1` (top of the sketch).
