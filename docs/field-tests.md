# Field tests

Internal notes from tests on the maintainer's own installation: a Comelit 6741W with a Comelit Extender, Homebridge on a Raspberry Pi 4 (ffmpeg 7.0.2), an iPhone, and an Apple home hub. Not published to npm. Screenshots are described in words only; no pictures of people are kept here.

## 2026-11-09: 2.1.0-beta.29 at the door

| Test | Result |
|---|---|
| Ring, untouched | HomeKit asked for the picture 3 times, 0.0–0.6 s after the ring; all 3 waited and got this ring's picture 3.3–3.4 s after the ring. The call kept ringing for its full minute (the ring preview doesn't disturb it). |
| Unlock from Control Centre during a ring, no live view | Answered, opened, hung up; the door opened about 1–2 s after the tap; the lock showed Unlocked about 7 s after the tap. |
| Normal call (live view, talk-back, close) | First picture 2.6 s after the live view started; talk-back reached the panel; clean hang-up. |
| Unlock inside the live view | Door opened; the intercom ended the call about 12 s later. |
| Restart | The last visitor's picture was shown again. |
| Leftover ffmpeg after the calls | None (`pgrep -a ffmpeg` empty). |
| Home app camera sizes | After talk-back off/on with restarts, requests changed from 1280x720 to 640x360 (132 kbps). |

## 2026-11-10: 2.1.0, the visitor's picture in the ring notification

Screenshots from the iPhone (descriptions):

1. **Ring banner, as it appeared** (`now`, Time Sensitive, Control Centre open, a phone call in progress): *"Main Entrance — Someone rang the doorbell."* with a **black square** where the picture goes.
2. **Notification Centre, 16:11 and 16:12:** Home entries combining several events (*"Someone was seen"*, *"Motion was detected"*, *"Entrance Lock was locked"*, the user arriving), with thumbnails from a camera's person detection (most likely the Nest front-door camera, top-down view), not from the intercom.
3. **Notification Centre, 16:23:** a single Home summary from 12 minutes earlier (*"… arrived — Someone was seen. Main Entrance Entrance Lock locked. Garage Camera changed modes."*). The doorbell ring is not kept as its own entry.

Findings:

- **iOS shows the doorbell banner at once, without waiting for the picture.** The banner appeared about 1–2 s after the button, with an empty (black) picture, while on 2026-11-09 the plugin answered HomeKit's picture requests about 3.4 s after the ring. The ring itself is therefore not delayed by the picture wait.
- **Not yet known:** whether the banner's picture fills in once the plugin's picture arrives. Notification Centre can't show it, because iOS folds the ring into a Home summary whose picture comes from another camera.
- **Noise:** the Comelit lock relocks 3 s after each open, which adds *"Entrance Lock locked"* to Home's notifications. Lock notifications can be turned off for it in the Home app.

Second round (16:28, Persistent banners already on, Home app open in the foreground):

4. **Ring banner, as it appeared:** again a black square where the picture goes.
5. **A few seconds later:** the banner was gone (with the Home app in the foreground, iOS doesn't keep it), but the Comelit camera's tile in the Home app showed the person at the door, updated about 1 s earlier.

So the plugin's picture of the ring reaches the Home app within seconds; the banner is shown before it, and whether the banner swaps it in is still unknown.

Next test: with the phone **locked** (Lock Screen notifications stay until cleared), ring and take a screenshot as the notification appears and again about 5 s later; or look at an Apple Watch a few seconds after the ring. Earlier plan: set the Home app's banners to *Persistent* (Settings → Notifications → Home), ring, and take a screenshot as the banner appears and again about 5 s later; compare with the log's `HomeKit asked for a … picture` lines and the saved `ring-*.jpg` (with `mediaCaptureDir` set). If the picture never fills in, the alternative is to fetch the picture before telling HomeKit about the ring (about 3 s later banner, with the visitor in it).
