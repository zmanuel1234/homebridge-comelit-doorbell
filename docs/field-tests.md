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

Third round (16:48, at the door, camera app open, then the Lock Screen):

6. **Ring banner, as it appeared:** a real picture from the intercom (the panel's eye-level street view), not a black square; the person ringing stood to the side, out of frame.
7. **Lock Screen:** the doorbell notification with the same picture. A separate *"Someone was seen"* notification came from another camera's person detection.

The log (2.1.0 with beta.31's debug line) confirms it: for the ring at 16:48:02, HomeKit asked for the picture three times, 0.0–0.5 s after the ring, all **640x360**, and all got this ring's picture about 3.4 s after the ring (saved as `ring-20261110-164802.jpg`). A further ring at 16:49:10 showed the same: three 640x360 requests at 0.0, 0.4 and 0.7 s, this ring's picture after waiting 2.6–3.2 s. As all requests are the same size, the saved picture is what the banner got. (The plugin sends the intercom's 4:3 picture at 640x480 when asked for 640x360.)

So the visitor's picture can be in the banner from the start. In the two earlier rounds the phone was busy in the foreground (Control Centre during a call; the Home app open), and the banner showed a black square; whether that is typical will show over more ordinary rings.

Earlier plan: with the phone **locked** (Lock Screen notifications stay until cleared), ring and take a screenshot as the notification appears and again about 5 s later; or look at an Apple Watch a few seconds after the ring. Earlier plan: set the Home app's banners to *Persistent* (Settings → Notifications → Home), ring, and take a screenshot as the banner appears and again about 5 s later; compare with the log's `HomeKit asked for a … picture` lines and the saved `ring-*.jpg` (with `mediaCaptureDir` set). If the picture never fills in, the alternative is to fetch the picture before telling HomeKit about the ring (about 3 s later banner, with the visitor in it).

### The saved notification pictures (2026-11-10, 16:56)

Five `ring-*.jpg` from the day, measured: three are normal 640x480 pictures of the street (about 50 KB, average brightness 126–130); **two are completely black** (2,020 bytes, every pixel 0). The live-call recordings of the same days never start black (first keyframes 23–32 KB).

So the black squares in the banners at 16:11 and 16:28 were most likely black pictures from the plugin, not iOS showing the banner early: at the start of a ring the intercom sometimes sends an empty, black first keyframe while its camera gets ready, and the ring preview took it as the visitor's picture. A black 640x240 keyframe is about 1 KB; a very dim real one at least 3 KB.

Fixed in 2.1.1-beta.1: keyframes under 2 KB are skipped, and the picture requests wait for the next real keyframe (up to 7 s after the ring).

## 2026-11-11: 2.3.0-beta.1 to beta.6, recording rings (HomeKit Secure Video)

Same installation, with **Record rings** on and the camera's Recording Options set to Stream & Allow Recording, Record audio on.

| Beta | Test | Result |
|---|---|---|
| beta.1 | Updating with an existing doorbell camera | No **Recording Options** in the Home app: hap-nodejs added the recording services to the cached camera but not the motion sensor that triggers them. Fixed in beta.2 (the plugin adds its own motion sensor). |
| beta.2 | Unanswered rings, calls, a quick unlock, a Next Visitor ring (open after 5 s) | All recorded, one clip per ring (31 s and 51 s for the first two). One clip looked like two rings in one, with a gap: two rings close together, the second joining the first one's recording. Clips had no sound. |
| beta.3 | The same, with sound | Still no sound: the plugin read **Record audio** from the wrong HomeKit service and always found it off. The ring preview's sound request got no reply: the 6741W sends **no sound before answering** (four rings). |
| beta.4 | Answered call with sound | Sound in the clip from the moment the call was answered; then on and off for the last part of the call. The saved sound showed gaps of a second or more, matching Wi-Fi stalls between the intercom and the Pi (late sound was dropped to keep picture and sound together). |
| beta.5 | Clip times against the new debug lines | Three rings: the Home app dated each clip **3.4–4.5 s after** the log's `the recording starts at`. Fits HomeKit treating the first 4 s of a clip as the prebuffer from before the event. |
| beta.6 | Unanswered ring, two answered rings | Clip start times in the Home app **exact** (to the second) against the log, each clip opening with a few seconds of still picture. First piece to HomeKit 4.1 s after the recording starts (8.0 s on beta.5). |
| beta.6 | Unlock during a ring | The lock tile showed Unlocked at once and Locked again a few seconds later; the door opened (`not refused`) about 4 s after the tap. |
| beta.6 | Talk-back | Noticeably less delay at the panel than the ~2 s heard before (not measured). |
| beta.6 | Sound in answered calls | In the clips. In one call of about a minute, 260 pieces (5.2 s) of the door's sound arrived too late and were dropped, and 2.6 s were silence-filled; in a shorter call, 39 pieces (0.8 s). Kept as a known limitation for 2.3.0. |
| beta.6 | First hour after the update | `Connection, last 60 min` debug line: 28 renewals, all 28 answered, 1 planned reconnect; no warnings. |

Other findings:

- **Next Visitor with a HomeKit arrival automation** ("anyone arrives" turns the switch on): it turned on for every arrival of a member of the home, including while another member was already in, and the arriving member was let in on their ring about a minute later. The Home app on a phone that hadn't reconnected after a bridge restart still showed the switch off while it was on; the log was right.
- A test run of the automation from the Home app ("Test This Automation") left the switch on, and the next ring was let in.
