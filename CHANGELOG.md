# Changelog

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
