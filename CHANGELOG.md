# Changelog

## 2.0.0 (unreleased)

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
