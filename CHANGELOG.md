# Changelog

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
