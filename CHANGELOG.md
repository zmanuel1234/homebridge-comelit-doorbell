# Changelog

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
