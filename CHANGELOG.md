# Changelog

## 2.2.0 (2026-11-11)

Stable release after three pre-releases (2.1.1-beta.1, 2.1.1-beta.2, 2.2.0-beta.1). Everything below is compared with 2.1.0; the pre-release entries further down give the details. No setting was renamed or removed, but settings are checked more strictly: see **Changed** below.

### Added

- **Next Visitor switch** (`nextVisitorSwitch`, off by default, in the **Door** section): while it is on, the next ring opens the door the same way as doctor mode (after **open after**, `doctorModeDelaySeconds`), then the switch turns itself off. If the open doesn't go through, it stays on for the next ring; with doctor mode also on, a ring opens once. If nobody rings, it turns off after **Next Visitor: turn off after** (`nextVisitorMinutes`, 2 hours). Its state survives a restart, and turning it off during the seconds before the open cancels the open.

### Changed (check these when updating)

- **Settings are checked more strictly.** A number above the config editor's maximum is now replaced by the default (2.1.0 used it as it was): for example `ringWindowSeconds: 900` becomes 90 s, `leaseRecycleMinutes: 60` becomes 50. Text that isn't a plain number (`"90s"`, `"1e3"`, `false`, blank) and choices with typos are also replaced by the default. Each one is reported once at startup: after updating, look in the log for lines with `is not valid` and fix those values. Before, `false` as **Unlock allowed for** meant "any time".

### Fixed

- **No more black picture in the ring notification.** An empty, black first keyframe from the intercom is skipped; the plugin waits for the next, real one.
- **Doctor mode:** turning the Doctor Mode switch off during the seconds before the open now cancels the open.
- **No ffmpeg left running after Homebridge restarts or stops.**
- Small leaks: a live view HomeKit prepared but never started, and doors the intercom no longer lists.

### Release mechanics

- Publishing stops if the GitHub release's **Set as a pre-release** box doesn't match the version; npm in the publish workflow is pinned to major version 11.

Tests: 133 in all.

## 2.2.0-beta.1 (2026-11-11)

Fixes from an independent review of the whole plugin, before the stable 2.2.0. Includes everything from 2.1.1-beta.1 and beta.2 (no black notification picture; the Next Visitor switch).

### Fixed

- **Unlock allowed for** (`ringWindowSeconds`) could be turned into "any time" by a value that isn't a number: `false`, a blank text, `[]` or `"0x0"` were read as 0, without a warning. Numbers are now accepted only as numbers or plain digits; anything else is reported and the 90 s window is kept. Only an explicit `0` allows unlocking at any time, as documented.
- **Doctor mode:** turning the Doctor Mode switch off during the seconds before the open now cancels the open, as it does for the Next Visitor switch.
- **Settings above the config editor's maximum** are now reported and replaced by the default, like those below the minimum. A very large value could overflow Node's timers: for example a huge refresh interval made the registration renew in a tight loop.
- **Invalid choices** (for example a typo in **Answer the ring**, `"answer-on-veiw"`) are now reported at startup instead of silently becoming the default. A path or text setting that isn't text no longer stops the plugin from loading; it is reported.
- **No ffmpeg left running after a restart:** when Homebridge shuts down, every camera view is stopped and its ffmpeg killed.
- A live view HomeKit prepared but never started is forgotten after a minute (a small, slow leak).
- A door the intercom no longer lists is dropped from the plugin's own list of locks too.

### Release mechanics

- Publishing now stops if the GitHub release's **Set as a pre-release** box doesn't match the version (ticked for a `-beta` version, unticked for a stable one), so a stable release can't go to npm's `beta` tag by mistake, or a beta to `latest`.
- npm in the publish workflow is pinned to major version 11.

### Documentation

- README: values outside the editor's limits or choices are reported; one intercom per bridge; turning a doctor mode or Next Visitor switch off during the delay cancels; the Next Visitor switch in the module table.

Tests: 133 in all, including tests for three rules that had none (one open per ring during the delay, only a ring opens the unlock window, a stopped view kills its ffmpeg).

## 2.1.1-beta.2 (2026-11-10)

### Added

- **Next Visitor switch** (`nextVisitorSwitch`, off by default, in the **Door** section): a HomeKit switch that lets one expected visitor in. While it is on, the next ring opens the door, the same way as doctor mode (answer, open, hang up, after **open after** seconds), and the switch turns itself off. If nobody rings, it turns itself off after **Next Visitor: turn off after** (`nextVisitorMinutes`, 2 hours by default). If the open doesn't go through, it stays on for the next ring. With doctor mode also on, a ring opens once. It keeps its state and time limit across restarts. Turning it off during the seconds before the open cancels the open. Your Doctor Mode switch is unchanged.

Tests: 125 in all.

## 2.1.1-beta.1 (2026-11-10)

### Fixed

- **A black picture in the ring notification.** At the start of a ring, the intercom sometimes sends an empty, black first keyframe while its camera is still getting ready; the plugin took it as the visitor's picture, so the notification (and the camera tile) showed a black square. Seen twice on 2026-11-10: the saved `ring-*.jpg` were completely black, 2 KB, while the other rings' pictures were normal, 50 KB. A keyframe smaller than 2 KB is now treated as empty: the plugin waits for the next one (the 6741W sends one every 2.7–3 s), and picture requests made just after the ring then wait up to 7 s after it instead of 4.5 s (HomeKit warns only after 8 s). If no real picture comes by then, HomeKit gets the earlier visitor's picture, never a black one.
- Debug log: the ring preview's line gives the size of the picture's keyframe and of any empty keyframes before it, and a skipped empty keyframe is logged.

Tests: 114 in all.

## 2.1.0 (2026-11-10)

The first stable release since 2.0.4, after 31 pre-releases (from beta.15 on, tested on a Comelit 6741W). Everything below is compared with 2.0.4; the pre-release entries further down give the details.

### Added

- **A HomeKit video doorbell.** Turn on **Doorbell camera with live video** and set **Answer the ring** to `answer-on-view`: rings show on all your Apple devices, and opening the camera's live view answers the call with the intercom's video and the door's sound. Closing the view hangs up.
- **Talk-back** from the Home app's microphone to the door (on by default with the camera).
- **The visitor's picture in the ring notification** (`ringPreview`, on by default): the plugin gets the picture from the intercom during the ring, without answering, and HomeKit waits for it (about 3 s after the ring on a 6741W). It needs the doorbell camera, and **Answer the ring** (or doctor mode) not `off`, since the plugin must follow the call, and **Show the last visitor for** above 0.
- **Open the door during a ring** from the live view, the lock, Control Centre, the Apple Watch or Siri. With `answer-on-view`, unlocking without the live view answers the call, opens and hangs up, as `answer-on-open` already did. Opening is still allowed only within **Unlock allowed for** (90 s) of a ring.
- **Doctor mode**: every ring opens the door after a short delay, always or while a HomeKit switch is on.
- **The last visitor's picture** on the camera tile, kept across restarts for **Show the last visitor for** (5 minutes by default).
- **No Response** on the lock when the intercom has been unreachable for more than 30 s.
- **Door volume** for the sound from the door (+12 dB by default), and a choice of video quality.
- **A reconnect back-off** up to **Longest reconnect wait** (5 minutes) when the intercom can't be reached.
- **Troubleshooting**: one summary line per live view, and **Save each call's video and audio to** (`mediaCaptureDir`) keeps the raw media of the last 10 calls and the picture each ring's notification got.

### Changed (check these when updating)

- **Node.js 20, 22 or 24 is required** (2.0.x allowed Node.js 18).
- **Registration refresh mode** defaults to `inplace`: no gap in which rings are missed. Set `leaseRefreshMode: reconnect` for the old behaviour.
- **Doorbell camera trigger URL** (`doorbellTriggerUrl`) has no default any more. If you used it with homebridge-camera-ffmpeg's default port, set it explicitly; with the plugin's own doorbell camera you don't need it.
- **A short normal log**: rings, door opens, doctor mode, one summary per live view, and problems. The rest (the connection's steps, renewals, `call:` and `diag:` lines) needs the child bridge's debug mode. The log prefixes `zman-call` and `zman-diag` are now `call:` and `diag:`.
- **The settings screen** is regrouped: Intercom, Doorbell camera and answering, and Door first; Picture and sound, Advanced and Troubleshooting folded away. No setting was renamed or removed, so your JSON keeps working.
- **Invalid settings**, and numbers below the config editor's minimum, are replaced by their default and reported once at startup. `true`/`false` written as text are accepted: `"false"` now really turns a setting off (2.0.x read it as on).
- In `reconnect` mode, a planned refresh reconnects after about 2 s instead of the reconnect delay.
- Rewritten in TypeScript; two intercoms in one Homebridge no longer share settings; the accessory model shown in the Home app is `ViP door relay` / `ViP doorbell`.

### Fixed

- **Rings could stop silently**: unacknowledged messages during a call (the intercom kept repeating them), a ring arriving while registering being taken as the registration's answer, a dropped connection during setup never reconnecting, and half-open channels taking the next channel's answer.
- **Unlock**: the unlock window could fail open on an invalid setting; several quick taps sent several opens; with **Listen for rings** off, opens waited 10 s for nothing.
- **Accessories** answer HomeKit from startup, before the first connection, and a shutdown during the connection setup no longer leaves a connection open.

### Known limits

See [Known limits](README.md#known-limits): tested on one 6741W; RTSP cameras listed by the intercom are placeholders; a door output of `0` is sent as `1` inside a call; the gate output is untested.

## 2.1.0-beta.31 (2026-11-10)

### Changed

- **Debug log: the size of each picture HomeKit asks for after a ring**, e.g. `Doorbell camera: HomeKit asked for a 640x360 picture 0.4 s after the ring; gave this ring's picture after waiting 3.0 s (saved)`. HomeKit asks several times per ring (the home hub for the notification, and your devices); the size shows which request is which, and `(saved)` marks the one kept in `mediaCaptureDir`. Logged whether the ring preview is on or off; it replaces the `Ring preview: HomeKit asked for the picture …` line.

## 2.1.0-beta.30 (2026-11-10)

### Added

- **The notification picture is kept for troubleshooting**: with **Save each call's video and audio to** (`mediaCaptureDir`) set, the first picture HomeKit gets after each ring is saved there exactly as sent, as `ring-<time of the ring>.jpg` (last 10 rings kept, like the call recordings). The log says where, and whether it was this ring's picture, an earlier visitor's or the idle one. No new setting.

Tests: 108 in all.

## 2.1.0-beta.29 (2026-11-09)

Clean-up for the stable 2.1.0: the log and the settings screen. No change to how the plugin works.

### Changed

- **A short normal log**: the settings at startup, `Comelit Intercom ready` (at startup and after a lost connection), rings, door opens, doctor mode, one summary line per live view, and problems. Moved to debug: the connection's steps (`Connecting`, `Authenticated`, `Device config`, CTPP), planned reconnects every **Full reconnect every** minutes and the `ready` after them, closed channels, the live view's details (`streaming`, `first picture`, `call ended`, `viewer inactive`, talk-back arriving) and the ring preview's lines. Nothing is dropped: with the child bridge's debug mode on, the log shows everything as before.
- **The settings screen**, regrouped by what you use: **Intercom**, **Doorbell camera and answering**, **Door** (open), then **Picture and sound**, **Advanced** and **Troubleshooting** (folded away). Talk-back and the notification picture only show with the doorbell camera on, and the doctor mode delay only with doctor mode on. Nothing is renamed or removed in the JSON.
- **"Experimental" removed** from the doorbell camera, answering and talk-back, which are tested on a 6741W.
- **README**: a new introduction, a **Recommended Home app setup** section (room, notifications, banners, opening without the video, chime, expected visitors), the settings tables in the same groups as the screen, a note on what the normal and debug logs show, and a troubleshooting row for No Response.
- A test checks that the settings screen shows every setting once and the README documents each.

### Fixed (from an independent review of beta.28)

- **The notification picture waited 4.5 s for nothing** when no ring preview could run: with **Answer the ring** `off` (the default) and doctor mode off, with **Show the last visitor for** `0`, or when calls go elsewhere. It now waits only when a preview can run, and stops waiting 1.5 s after the ring if none started.
- **A second ring** while the first one's picture was awaited could drop the wait.
- **Unlocking during a ring** just as the call ended (answered on the monitor or a phone, or the ringing timed out) sent the open into the ended call and showed Unlocked, though the door stayed shut. It now opens the normal way in that case.
- **A connection lost during its setup** could clear the "unreachable since" time, delaying No Response.
- `Ring preview: no video before answering …` is logged at normal level, once per ring, when the intercom gives no picture; the other ring preview lines stay at debug.
- The settings screen also shows talk-back and the notification picture when `camera` is written as text (`"true"`). The README and the setting's description say the ring preview needs **Answer the ring** (or doctor mode) not `off`.

Tests: 106 in all.

## 2.1.0-beta.28 (2026-11-09)

Towards the stable 2.1.0: the HomeKit experience during a ring.

### Changed

- **Visitor's picture in the ring notification** (`ringPreview`) is **on by default** and no longer a test; its setting moved to the doorbell camera section. On the 6741W video before an answer works (tested with beta.27), but the first picture comes about 3 s after the ring, while HomeKit asks for the notification's picture after 0.2–2 s, so it got the previous visitor's picture. A picture request in the first 4.5 s after a ring now waits for this ring's picture (or for the preview to stop without one). The ring itself still goes out at once. The log line `Ring preview: …` says which picture HomeKit got and how long it waited.
- **Unlocking during a ring without opening the live view** (`answerMode: answer-on-view`): the plugin answers the call, opens the door and hangs up, as doctor mode does. So a visitor can be let in from the notification, the Apple Watch, Control Centre or Siri. Before, the intercom refused the open as *busy* unless the live view was open.
- **A cleaner visitor's picture** (notification, camera tile and still view): saved at near-best JPEG quality instead of ffmpeg's low default. Measured on a 6741W frame: noticeably less blocky, about 60 KB instead of 33 KB. The intercom's small 640x240 picture remains the limit.

### Added

- **The lock shows No Response** in Home when the intercom has been unreachable for more than 30 s (a normal reconnect takes a second or two and doesn't show). A tap then gives Home's "No Response" instead of quietly going back to Locked. It clears as soon as the connection is back.

Tests: 100 in all.

## 2.1.0-beta.27 (2026-11-09)

A test build for the visitor's picture in the ring notification. Everything else is as in beta.26.

### Added

- **Visitor's picture in the ring notification (test)** (`ringPreview`, off by default, in the troubleshooting section): on a ring, asks the intercom for video before anyone answers, so the notification can show who is at the door instead of an older picture. It doesn't answer: the phones and the monitor keep ringing, and it stops at the first picture, after 8 s at most, or as soon as the call is answered (the live view and doctor mode work as before). The log says what happened (`Ring preview (test): video before answering works / no video before answering …`), and when HomeKit asked for the notification's picture, to see whether the picture comes in time.
- **The last visitor's picture survives a restart**: it is saved in Homebridge's storage folder (`comelit-last-visitor.h264`) and shown again after a restart or update, until **Show the last visitor for** has passed since it was taken. Before, any restart reset the camera to the idle picture.

## 2.1.0-beta.26 (2026-11-09)

Fixes from an independent review of beta.25, before the stable 2.1.0.

### Fixed

- **Live view closed while it was starting** (doorbell camera): ffmpeg and the return socket could be started after the viewer had already left, and run until restart. The plugin now checks after each step and starts nothing for a viewer who left; a recording started for it is closed.
- **Call ended by the intercom while its media was being set up**: the media is now ended at once instead of being kept for a call that no longer exists.
- **Doctor mode or unlock without a viewer**: the hang-up 1.5 s after opening now checks again that no live view started meanwhile, instead of cutting that view off.
- **Two devices watching one call** fed each video frame twice into the picture cache.
- **Call ended while a live view was starting** (for example while its recording was being set up): the view showed nothing until HomeKit gave up. It now shows the picture, or ends.
- **A live view that fails to start during the pause after a door open** left the call answered; it is now hung up.
- **Listen for rings off** (`enableNotifications: false`): no more registration refresh every 2 minutes for a registration that doesn't exist; the connection is renewed every **Full reconnect every** minutes instead. As no ring is ever seen, the lock refuses to open unless **Unlock allowed for** is `0`, and the log now says so at startup. `"false"` written as text is now read as false (it was read as true); the same for `camera`, `talkBack` and `registerPush`.
- **Settings below the config editor's minimum** (for example a refresh interval of 0.1 minutes, or a live view wait of 1 s) are now replaced by the default and reported at startup, like other invalid values. An invalid **Show the last visitor for** keeps the 5-minute default instead of turning the picture off.
- **Restart and shutdown**: a Homebridge shutdown during the connection setup no longer leaves a connection open; the locks and other accessories answer HomeKit from startup (a tap before the first connection says it isn't connected) instead of only after the first connection. The cache now keeps the intercom's current doors and cameras, so the first connection rebuilds the accessories only if they changed.

Tests for the fixes (89 in all).

### Documentation

- The video quality options say what they ask for (320x240, up to 800x480); a 6741W sends 640x240 either way.
- Lock: inside a call the intercom doesn't confirm an open, so Unlocked there means sent and not refused.
- The troubleshooting row for a closed ring channel gives the real reconnect delay; recordings are kept per call (last 10 calls), not per view; two new known limits (door output 0 inside a call; door channels left open with rings off).
- README only, from a second review of 2.1.0-beta.25: setting up the Comelit user (a user needs one activation in the Comelit app before it has a token, and must not be deactivated afterwards; where the token is in `users.cfg`); a section on updating from 2.0.x; a real summary line as the example; troubleshooting rows that rely on the summary line instead of debug-only lines, and one for rings missed right after a restart; hedged statements that aren't observed yet (the phones stopping when HomeKit answers); a duplicate line removed; the doctor mode switch in the module list and known limits.

## 2.1.0-beta.25 (2026-11-08)

Preparing the stable 2.1.0 release.

### Changed

- **Quieter log.** The call's messages (`call:`), diagnostics (`diag:`), registration renewals (`Registration renewed in place`, `VIP:` lines) and event lines are now logged at debug level. Without debug mode, the log keeps to rings, door opens, warnings and one summary line per live view. Turn on debug mode for the child bridge to see everything, as before.
- **`leaseRefreshMode` defaults to `inplace`** (was `reconnect`): renewing on the open connection has no gap in which rings are missed, and is the mode tested for days. Configs that set `reconnect` keep it.
- **`talkBack` defaults to on** (was off), since it works. With the doorbell camera, the Home app now shows a microphone button. Set `talkBack: false` to hide it. The warning about talk-back without the camera is gone.

### Fixed (review before the stable release)

- `videoCodec: copy` could never show the intercom's video: the plugin restores its timestamps and its 4:3 shape with ffmpeg filters, which need re-encoding. `copy` now falls back to `libx264` with a startup warning.
- A ring within 10 s of the previous call could start its live video from the previous call's keyframe, giving a garbled picture until the next keyframe. Each call now starts from its own.
- Two devices opening the live view outside a call at the same moment shared one temporary picture file, which one of them could overwrite while the other was reading it. Each view now has its own, removed when it closes.
- Two devices talking at once during a call had their voices interleaved into a garble. The first one to talk keeps the line until it has been quiet for a second.
- With `mediaCaptureDir` set, each device watching a call made its own recording of the same media. There is now one per call.

### Documentation

- README: the tested-hardware section is a table of tested features; the new defaults; which log lines need debug mode; the example config no longer sets `leaseRefreshMode`; `copy` isn't a usable encoder; wording for users updating from 2.0.x instead of beta numbers.
- Tests for the `copy` fallback and the keyframe reset (75 in all).

## 2.1.0-beta.24 (2026-11-08)

From the eighth real test (beta.23): clean video, sound without delay, doctor mode working.

### Fixed

- **Messages from the intercom during a call are acknowledged right away.** Before, the plugin only acknowledged them with its next message, so anything it had no reply to was sent again and again: after 20 s of unanswered ringing the intercom checks that the plugin is still there (an empty message), and repeated it five times over 7 s; earlier, its media request arrived three times. The plugin now sends a plain acknowledgement, as the intercom does for ours. This applies while calls are followed (any `answerMode` but `off`, or doctor mode on).

### Added

- Test for the acknowledgements: the empty check, a repeated message, the media request, and no acknowledgement of acknowledgements (73 in all).

## 2.1.0-beta.23 (2026-11-08)

From the seventh real test (beta.22): the picture was still smeared at the start, and the sound from the door arrived a few seconds late. Both reproduced here with a recorded call and the Pi's ffmpeg 7.0.2, and both had the same kind of cause: ffmpeg's start-up handling of its input.

### Fixed

- **Smeared, grey start of the live video.** The video input used `-fflags nobuffer`, which makes ffmpeg drop what it reads while probing the input. That was the intercom's first keyframe (about 33 KB), so ffmpeg had nothing to build the picture on until the next keyframe, 3–7 s later, and showed grey smears in between. Without it, the picture is clean from the first frame. (This was probably also why beta.17 needed `showall`; the 2 s keyframe interval from beta.20 stays.)
- **Sound from the door about 3 s late.** The audio input had no probe limits, so ffmpeg held about 3.3 s of audio before sending any, and the sound lagged by that much for the whole call. It now starts after about 0.1 s. Talk-back was measured too and has no such delay.

### Added

- Tests for both input options (72 in all).

## 2.1.0-beta.22 (2026-11-08)

From the sixth real test (beta.21, doctor mode off): video, talk-back and the last visitor's picture work; the picture was smeared at the start, and the sound from the door was hard to hear.

### Changed

- **Sharper picture.** The camera offered the Home app up to 1920x1080, so it asked for 1280x720 at about 300 kbps. The intercom's picture (640x480 once restored to 4:3) was enlarged to four times the pixels and squeezed through that bitrate, which smeared it, most at the start. The camera now offers at most 640x480, the intercom's own size: three times more data per pixel, and less work for the Pi. You may have to close and reopen the Home app once.
- **Louder sound from the door.** Measured on a recorded call: the intercom's microphone gives speech at about -33 dB, against about -20 dB for normal speech. The plugin now turns it up by 12 dB, with a limiter so loud sounds (like the door release, which peaks near full scale) don't distort. Checked with ffmpeg 7.0.2.

### Added

- `doorVolume` (12 dB, 0–24): how much to turn up the sound from the door. 0 leaves it as it is.
- README: the setting, the picture size, the quiet microphone. Tests (72).

## 2.1.0-beta.21 (2026-11-08)

### Added

- **Doctor mode** (`doctorMode`, off by default): every ring opens the first door by itself, after `doctorModeDelaySeconds` (2). The plugin answers the call, opens inside it and hangs up, as the Comelit app does, since the intercom refuses opens during an unanswered ring. `always`, or `switch` for a **Doctor Mode** HomeKit switch that turns it on and off (by hand or by automation; keeps its state across restarts). Works with any `answerMode`. Doesn't open if someone answered on a phone first. Startup warning when `always`.
- Tests for doctor mode (72 in all).
- README: the settings, the switch, how it works.

## 2.1.0-beta.20 (2026-11-08)

Live video works on the Raspberry Pi with 2.1.0-beta.19 (565 frames in a 39 s call), and the last visitor's picture shows the visitor.

### Fixed

- **Grey, smeared picture for the first seconds** (most likely cause). The plugin's video encoder sent a keyframe only every 250 frames (x264's default, about 15 s). The Home app joins the stream a moment after it starts; if it misses the first keyframe, it smears until the next one. It now gets a keyframe every 2 s. The intercom's own video decodes cleanly from its first keyframe (checked on three recorded calls), so the smears came from our side of the stream.

### Documentation

- README: live video confirmed on the Pi (ffmpeg 7.0.2); the camera's tested features; a smeared start clears within 2 s.

## 2.1.0-beta.19 (2026-11-08)

### Fixed

- **The live video was still frozen and grey on the Raspberry Pi.** beta.17's fix (`-use_wallclock_as_timestamps`) works with ffmpeg 8, which it was tested with, but not with the ffmpeg 7.0.2 on the Homebridge Raspberry Pi image, so the Pi still sent 2 frames per call. Each frame now gets its arrival time in the video filter (`setpts` with the wall clock), which works with both: replaying both recorded calls through ffmpeg 7.0.2 and 8.0 gives about 15 frames per second, from 0.7 s.
- **The last visitor's picture often showed an empty doorway.** It was the call's last keyframe, taken after the visitor had gone in. It is now the call's first keyframe, while the visitor waits at the panel. A second live view of the same call keeps that picture.

### Added

- Tests for the new video filter and the last-visitor picture (68 in all).
- README: troubleshooting row updated; when the last visitor's picture is taken.

## 2.1.0-beta.18 (2026-11-08)

### Fixed

- **The last visitor's picture was replaced by the idle picture when you opened the camera.** After a call, the camera's tile showed the last visitor, but opening the camera outside a call streamed the idle picture, and the tile then showed that. Within `lastVisitorMinutes`, the live view outside a call now shows the last visitor too.
- The last visitor's picture was squashed (640x240). It is now shown as 4:3, like the live video.

## 2.1.0-beta.17 (2026-11-08)

From the third real test, with the new diagnostics and a recording of the call: **talk-back works** (your voice is heard at the panel), and the picture was almost frozen. Replaying the recording through the plugin's ffmpeg command reproduced and explained it.

### Fixed

- **Frozen live video.** The 6741W's video says it runs at 1,200,000 frames per second, so ffmpeg gave the frames timestamps microseconds apart and passed only 2 frames per call to the Home app. ffmpeg now uses the arrival time of each frame: the recorded call gives about 16 frames per second.
- **The picture started late.** ffmpeg showed nothing until the intercom's second keyframe, 3–4 s in. It now starts at the first one: about 0.6 s after the video starts, instead of 4.6 s, on the recording.
- **Squashed picture.** The 6741W sends 640x240, a 4:3 picture at half height. Pictures wider than 2:1 are now stretched back to 4:3.
- The `diag: frame … on unknown channel` lines after a view closed were still there: closing a media channel dropped its handler at once. Late packets are now ignored for 5 s after the close.

### Added

- Test with the real SPS (640x240) and the new ffmpeg input options (67 in all).
- README: talk-back tested; the 6741W sends 640x240 whatever `videoQuality` is; when the picture appears; troubleshooting for a frozen picture.

## 2.1.0-beta.16 (2026-11-08)

From the second real test: in two of three calls the live view stayed blank for the few seconds it was open, although video was arriving, the picture with `hd` looked about the same as with `sd`, and it was unclear whether talk-back sent anything. This version logs enough to answer these from the log alone, and tries one fix.

### Changed

- If the video has no keyframe 1.5 s after it starts, the plugin asks the intercom for video again, which may bring a keyframe sooner. Until a keyframe arrives, nothing can be shown.

### Added

- Log lines for the video: its real size and profile (`call: video 800x480, …`), how long the first keyframe took, and the keyframe interval. Also when the first picture went to HomeKit.
- Log lines for talk-back: when sound from the Home app's microphone arrives, and how many talk-back packets went to the intercom (`talk-back sent=…`).
- **A summary line for every live view** (`Doorbell camera: live view summary: …`): how long it lasted, whether it was live or the picture, the size the Home app asked for, when the first picture went out, frames ffmpeg sent to the Home app (from ffmpeg's progress), how many reports the Home app sent back while receiving, microphone data, why it ended, and what the intercom sent (real size, first video, first keyframe, keyframe interval, packets, talk-back sent).
- `mediaCaptureDir` (experimental, empty by default): saves each live view's raw video and audio, and your talk-back, for troubleshooting. Keeps the last 10.
- Tests for the size reader (five real SPS), the video re-request, the report counter and the capture clean-up (66 in all).
- README: why the view can start blank, troubleshooting for blank views and talk-back, what to send when reporting a camera problem, the new setting.

### Fixed

- After a live view closed, the intercom's last packets were logged as `diag: frame … on unknown channel`. They are now dropped quietly.

## 2.1.0-beta.15 (2026-11-08)

First test on a real intercom (6741W, firmware 2.1.0): answering from the live view, live video, the intercom's audio and unlocking during the call all worked.

### Fixed

- **Talk-back channel.** The intercom sends its own audio request right after the answer, before the plugin's. The plugin only listened for it after sending its own, so it missed it, waited 3 s for nothing, and would have sent talk-back audio to the wrong channel. It now keeps the intercom's request whenever it arrives. The live view also starts about 3 s sooner.
- The start of the video no longer goes to ffmpeg before the stream's parameters (SPS) arrive. Before, ffmpeg logged `non-existing PPS 0 referenced` and could show a grey or smeared first picture.
- A door open inside a call was logged as "the intercom did not confirm it" although the door opened. Inside a call the intercom only acknowledges the open, so no refusal now counts as opened.

### Added

- Test replaying the intercom's audio request from the real call (62 in all).
- README: tested features, what a call looks like (start time, muted start, the intercom ending the call after an open), a troubleshooting row.

## 2.1.0-beta.14 (2026-11-08)

- No changes to the plugin. CI runs with read-only repository access, and the connection tests wait for events instead of fixed delays, so a slow CI machine can't make them fail.

## 2.1.0-beta.13 (2026-11-08)

### Fixed

- With no `name` in the config, the doorbell accessory was created as "Comelit Doorbell", while the config editor and README say the default is "Comelit Intercom". It now uses "Comelit Intercom". Existing accessories keep their names.

### Documentation

- README: the feature list mentions the doorbell camera; `videoQuality: hd` asks for up to 800x480 (it said 640x240); the ring flow says where the doorbell notification comes from; known limits mention the gap in `reconnect` mode.

## 2.1.0-beta.12 (2026-11-08)

### Fixed

- If `snapshotImage` pointed to a file that doesn't exist (for example an old picture that was deleted), every live view without a call failed, because ffmpeg couldn't open it. The plugin now uses the built-in picture instead and names the missing file in the log once.
- If making a picture from the last video frame failed, the Home app got no picture at all. It now gets the idle picture.

### Added

- Test for the missing-picture fallback (61 in all).
- README and config editor: what happens when the picture file is missing.

## 2.1.0-beta.11 (2026-11-08)

### Fixed

- **Rings could stop silently.** When the intercom closed a channel, the plugin acknowledged it but kept treating the channel as open. If it was the ring channel (CTPP), nothing rang until the next full reconnect: up to 50 minutes in `inplace` mode, because renewals were still "sent" on the closed channel. The plugin now forgets closed channels and reconnects right away when the ring channel closes (log: `The intercom closed channel CTPP`).
- A frame that made its handler fail (for example a malformed media packet) was thrown out of the connection's data event, which can stop Homebridge. It is now logged and skipped, and the following frames are handled as usual.

### Changed

- npm description and keywords mention the doorbell camera.

### Added

- Tests for the above (60 in all).
- README: troubleshooting row for a closed ring channel.

## 2.1.0-beta.10 (2026-11-08)

### Fixed

- **Unlock window failed open.** A `ringWindowSeconds` that wasn't a valid number (negative, or text such as `"ninety"`) turned the window off, so HomeKit could unlock at any time. Now only an explicit `0` does that; anything invalid keeps the 90 s window.
- `reconnectDelay` of `0` or less made the plugin retry the connection in a tight loop. Invalid values now use the default of 10 s.
- `subaddress` written as text in JSON (`"3"`) was silently ignored, so the plugin registered as the intercom's default user, which the phones also use. Numbers written as text are now accepted for all number settings.
- A space or line break pasted around the host or token made the connection or login fail. They are now trimmed.

### Added

- Invalid setting values are named in a startup warning (`… is not valid, using …`).
- A one-line summary of the settings in use at startup (`Settings: …`), without the token.
- Tests for the above (58 in all).
- README: how invalid values are handled, the settings summary, a troubleshooting row.

## 2.1.0-beta.9 (2026-11-08)

### Fixed

- A ring that arrived in the few seconds after connecting, while the plugin was registering for rings, was taken as the intercom's answer to the registration and lost. It is now passed on, so it rings in HomeKit. This happens on every reconnect, so every 2 minutes in `reconnect` mode.
- A channel whose open failed or timed out stayed half-open, and the intercom's answer to the next channel the plugin opened was given to it. After one failed open, that connection's later opens (media, keepalive) could fail or mix up channels.
- A JSON request whose send failed left a 30 s timer that then rejected with nothing listening for it, which Node reports as an unhandled rejection and can stop Homebridge.

### Added

- Tests for the above (54 in all).
- README: the full list of source modules, and a note on rings during re-registration.

## 2.1.0-beta.8 (2026-11-08)

### Fixed

- A connection that dropped during setup, before the plugin was watching for drops (for example while registering for push), was never reconnected: the plugin stayed offline until restarted.
- Opening the live view and closing it again before the intercom's media had started left the call answered with media running and nobody watching. The media is now ended.
- If the video ffmpeg stopped (for example a missing encoder), the live view stayed frozen until HomeKit gave up. It now ends right away, with the reason in the log.
- Several quick taps on Unlock sent several door opens. Taps while an open is on its way are ignored.
- Finished calls were kept in memory until the next door open or live view. They are now dropped when the next ring arrives.
- A reconnect could still be scheduled while Homebridge was shutting down.

### Changed

- Registration refresh in `reconnect` mode: the plugin reconnects within 2 s instead of after `reconnectDelay` (10 s), so the gap in which rings are missed is short. Dropped connections still wait `reconnectDelay`.
- Accessories are only rebuilt when the intercom's doors or cameras change, not on every reconnect. Before, each reconnect (every 2 minutes in `reconnect` mode) rewrote Homebridge's accessory cache.

### Added

- Tests for the above (51 in all).
- README: the 2 s reconnect gap, ignored extra taps, troubleshooting for `video ffmpeg stopped`, the release tag rule.

## 2.1.0-beta.7 (2026-11-08)

### Fixed

- A registration refresh that needs a full reconnect (`leaseRefreshMode: reconnect`, or the `leaseRecycleMinutes` reconnect in `inplace` mode) could drop the connection in the middle of an answered call, cutting the live view. It now waits until the call is over, checking every 30 s, for at most 10 minutes. In-place renewals are unaffected.

### Changed

- **`doorbellTriggerUrl` is empty by default.** Before, a missing setting meant `http://localhost:8089/doorbell?Doorbell`. If you use a homebridge-camera-ffmpeg doorbell and never set the URL, set it now, or the camera-ffmpeg doorbell stops ringing.
- When the intercom can't be reached, the wait between reconnect attempts doubles after each failure, up to `maxReconnectDelay`, instead of retrying every `reconnectDelay` seconds forever. A failed reconnect is now always retried (before, an error thrown while setting up could stop the retries).
- Planned reconnects for the registration are logged as `Reconnecting (registration lease refresh …)` instead of a `Device disconnected` warning.
- Requires Node.js 20, 22 or 24 (as Homebridge 2 does). CI also builds and tests on Node 20 and 22.

### Added

- `maxReconnectDelay` (300 s), in the Registration section.
- Tests for the connection lifecycle: reconnect and in-place leases, waiting during a call, the reconnect back-off (47 in all).
- README: the new setting, the trigger URL change, supported Node versions, troubleshooting for an unreachable intercom.

## 2.1.0-beta.6 (2026-11-08)

- No changes to the plugin. The publish workflow checks the release tag with a script, so the log reads "Release tag … matches package.json" instead of printing the failure text.

## 2.1.0-beta.5 (2026-11-07)

### Fixed

- Two viewers opening the live view at the same time each answered the call and set up media twice. They now share one answer and one media setup.
- A media setup that failed halfway was left attached to the call, and the next viewer reused it. It is now cleaned up (the call stays answered, so unlocking still works) and the next viewer tries again.
- A live view whose viewer vanished before sending anything kept streaming forever. The inactivity timer now starts with the stream.
- After a call, the camera kept showing the last video frame until restart. It now goes back to the idle picture after `lastVisitorMinutes`.

### Added

- `liveViewWaitSeconds` (8): if the intercom's media takes longer when a live view opens, the picture is shown instead of the Home app giving up, and media that arrives later with no viewer is ended.
- `lastVisitorMinutes` (5).
- Startup warnings for settings that don't work together: `answer-on-view` or `talkBack` without the camera, and the camera together with a trigger URL (two notifications per ring).
- README: both ways to get a doorbell notification, ffmpeg requirements, camera troubleshooting.
- Tests for two viewers, a failed media setup, keyframe age, the ffmpeg arguments and the warnings (40 in all).

## 2.1.0-beta.4 (2026-11-07)

- Doorbell camera: outside a call it shows a picture that comes with the plugin (a doorbell and "Live video starts when someone rings") instead of a dark frame. `snapshotImage` still overrides it.
- ffmpeg is found automatically in more places: inside homebridge-camera-ffmpeg (scoped package `@homebridge-plugins/...`) and `/usr/local/bin/ffmpeg` (Homebridge Raspberry Pi image).

## 2.1.0-beta.3 (2026-11-07)

- No changes to the plugin. Published with setup-node v6, which removes the `always-auth` warnings from the publish run.

## 2.1.0-beta.2 (2026-11-07)

Experimental features, all off by default.

### Added

- **Doorbell camera** (`camera`): a HomeKit video doorbell that rings by itself and shows the intercom's video and audio during a call, through ffmpeg. Outside a call it shows a still picture (`snapshotImage`).
- **Answer when viewing** (`answerMode: answer-on-view`): opening the camera's live view answers the ring, then requests video and audio as the Comelit app does: UDPM and two RTPC channels, audio and video media requests, VOICESTATUS. Closing the view hangs up. Unlocking during the view opens inside the call.
- **Talk-back** (`talkBack`): the Home app's microphone is sent to the intercom's speaker as G.711 A-law.
- `videoQuality`, `videoCodec`, `ffmpegPath` settings.
- Media timing settings: `mediaStartTimeoutSeconds` (10), `mediaSilenceSeconds` (5), `videoRefreshSeconds` (15).
- The connection now reports channels the intercom opens (name and handle, which were misparsed before) and can route media channels.
- Unknown-channel diagnostics are rate-limited, so media can't flood the log.

### Tested

- Unit tests for RTP, H.264 depacketizing, the keyframe cache, the call's media requests, and media routing.
- The camera streaming against ffmpeg-for-homebridge: synthetic H.264 and A-law in, SRTP video and AAC-ELD audio out, a snapshot from the live keyframe, the still picture without a call, and talk-back from a simulated Home app microphone.
- Not yet on a real intercom.

## 2.0.4 (2026-11-07, 2.0.x line)

- The fix for lost intercom messages from 2.1.0-beta.1, backported to 2.0.3.

## 2.1.0-beta.1 (2026-11-07)

Rewritten in TypeScript, with the same behavior as 2.0.3: the CTP frames the plugin sends were checked byte for byte against 2.0.3 for a ring, the handshake, renewals, closes, door opens and registration.

### Fixed

- Messages from the intercom could be lost. After the listener had waited a minute without anything arriving, the next message went to that expired wait and was dropped, so after an idle period the first message, possibly a ring, was lost. Rings captured on 2026-11-07 only got through because the intercom sends the INVITE twice. This may also be why rings stopped arriving when the registration was refreshed less often.
- With **Listen for rings** off, a door open no longer waits 10 s for an answer that can't arrive.

### Changed

- Settings are passed through the plugin instead of global variables, so two intercoms in one Homebridge no longer share settings.
- Log prefixes: `zman-call` is now `call:`, and `zman-diag` is now `diag:`.
- The accessory model shown in the Home app is now `ViP door relay` / `ViP doorbell` instead of `6701W`.
- Removed unused video-call code and an unreachable door-open sequence. The untested actuator (gate) path is kept, but no longer reports a confirmed open.

### Added

- Unit tests for the frame encoding, ACK words, rings, door-open answers, the handshake, registration across reconnects, the lock states and the settings defaults, most of them using frames captured from a real intercom.

## 2.0.3 (2026-11-07)

### Fixed

- Accessories were registered again on every reconnect after a fresh install. Homebridge rejected the duplicate, and the ring sensor stopped updating until the next restart. Each accessory is now registered once.
- Unlock reported success even when the intercom refused. The plugin now waits up to 10 s for the intercom's answer: the lock shows Unlocked only once the door actually opens, snaps back to Locked if refused, and the log gives the cause (for example `cause 8, busy`).
- Only an INVITE from the intercom counts as a ring. Other new connections no longer fire a ring or open the unlock window.
- Releases are no longer logged as `door_opened` events.
- The ring window now applies to Unlock only, not Lock.
- The doorbell trigger URL also works with `https`, with a 5 s timeout.

### Added

- Tests built from frames captured from a real intercom, run by CI and before each publish.

## 2.0.2 (2026-11-07)

- Documentation: the README covers every setting, the accessories the plugin creates, migration, the ring-to-open flow and troubleshooting.
- Config editor: every setting has a description, settings are grouped into sections, and host and token are required.
- No changes to how the plugin behaves.

## 2.0.1 (2026-11-07)

- No functional changes. First release published through npm trusted publishing from GitHub Actions, to test the release pipeline and the update in the Homebridge UI.

## 2.0.0 (2026-11-07)

First release as `homebridge-comelit-doorbell`, based on `homebridge-comelit-intercom` 1.1.1.

### Changed

- New package name. The platform name stays `ComelitIntercom`, and accessory IDs keep their original seed, so existing configs and HomeKit accessories carry over.
- The doorbell is a ring sensor (motion sensor) instead of a switch.
- The lock answers HomeKit right away instead of waiting for the door command.
- The plugin no longer registers for push by default (`registerPush`), which had diverted calls away from it.

### Fixed

- CTP acknowledgements now flip the connection id and advance the peer sequence, so the intercom stops retransmitting events.
- The door release is built as a proper OPEN_DOOR packet, sent from the plugin's own address.
- Connections the intercom closes are closed back.
- Rings kept arriving only for a few minutes after connecting. The registration is now refreshed (`leaseRefreshMinutes`, `leaseRefreshMode`).

### Added

- `subaddress`: use a dedicated Comelit user.
- `ringWindowSeconds`: unlock only shortly after a ring.
- `doorbellTriggerUrl`: trigger a camera doorbell (homebridge-camera-ffmpeg) on each ring.
- `leaseRecycleMinutes`, `registerPush`, `reconnectDelay` down to 1 s.
- All settings in the Homebridge config editor.
- Experimental `answerMode`: reply to or answer the incoming call.
- Diagnostic logging (`zman-diag`, `zman-call`).
