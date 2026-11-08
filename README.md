# homebridge-comelit-intercom

Homebridge 2.0 plugin for the **Comelit 6701W** WiFi video intercom. Communicates entirely via the ICONA Bridge TCP protocol on port 64100 — no cloud required.

## Features

- **Door locks** — one `LockMechanism` accessory per door/gate relay; tap to open in the Home app
- **Doorbell** — fires a native HomeKit doorbell event on ring, triggering iOS/macOS notifications
- **RTSP cameras** — exposes any RTSP cameras reported in the device config
- **Auto-reconnect** — transparent reconnection with configurable delay
- **100% local** — all TCP traffic stays on your LAN

## Prerequisites

- Node.js 18 or newer
- Homebridge 2.0 (`2.0.0-beta.0` or later)
- Comelit 6701W accessible on your local network
- Your device's 32-character hex token (see [Finding your token](#finding-your-token))

## Finding Your Token

1. Browse to `http://<device-ip>:8080` (default credentials: `admin` / `comelit`)
2. Go to **Device Info** — copy the **ID32** value (32-character hex string)

## Installation

### From npm (once published)

```bash
npm install -g homebridge-comelit-intercom
```

Restart Homebridge and configure via the UI.

### From source

```bash
git clone https://github.com/Danimal4326/homebridge-comelit-intercom.git
cd homebridge-comelit-intercom
npm install
npm run build
npm link
```

Restart Homebridge after linking.

## Configuration

Add a platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ComelitIntercom",
      "name": "Comelit Intercom",
      "host": "192.168.1.100",
      "token": "your32charhextokenhere",
      "port": 64100,
      "enableNotifications": true,
      "reconnectDelay": 10
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|:--------:|---------|-------------|
| `platform` | ✅ | — | Must be `ComelitIntercom` |
| `name` | ✅ | — | Display name in the Homebridge UI |
| `host` | ✅ | — | Device IP address or hostname |
| `token` | ✅ | — | 32-char hex token from the device admin page |
| `port` | | `64100` | ICONA Bridge TCP port |
| `enableNotifications` | | `true` | Open a persistent CTPP/VIP channel for doorbell events. Disable only to troubleshoot. |
| `reconnectDelay` | | `10` | Seconds to wait before reconnecting after a connection drop |

When using **Config UI X** (Homebridge UI), all fields appear as a form automatically via `config.schema.json`.

## Build

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run watch        # watch mode for development
```

Output lands in `dist/`. The plugin entry point is `dist/index.js`.

## Accessories

| Accessory | HAP Service | Notes |
|-----------|-------------|-------|
| One per door/gate | `LockMechanism` | Tap **Open** in the Home app to trigger the relay. Shows as "Unlocked" briefly, then auto-returns to "Locked" after 3 s. |
| Doorbell | `Doorbell` + `Speaker` | Fires a ring event on doorbell press. Triggers native HomeKit notifications automatically. |
| RTSP cameras *(if any)* | `MotionSensor` stub | Cameras found in device config are registered. Full HomeKit streaming is a planned future addition. |

## Usage

### Opening a door

Tap the lock accessory in the Home app and press **Open**. You can also use Siri:

```
"Hey Siri, unlock Front Door"
```

### Doorbell notifications

Rings trigger a native HomeKit notification on all registered iOS/macOS devices — no automation required.

To act on a ring (e.g. turn on a light), create a **HomeKit automation**:
- **Trigger:** *Doorbell detects doorbell*
- **Action:** any scene or accessory action

### Reconnection

The plugin reconnects automatically when the device wakes from sleep or the network recovers. The `reconnectDelay` setting controls how long it waits. A 90-second keepalive probe prevents false disconnects while the device is idle.

## Protocol

The ICONA Bridge protocol runs over raw TCP on port 64100. Every message has an 8-byte header:

```
[0x00 0x06] [body_length LE16] [request_id LE16] [0x00 0x00]
```

Key channel flows:
- **UAUT** — authentication: send token → expect code 200
- **UCFG** — device config: parse doors, cameras, apartment address
- **PUSH** — FCM token registration; re-sent every 90 s as a keepalive probe
- **CTPP** — persistent binary channel: doorbell ring, door opened, registration renewal ACK

## Acknowledgments

Protocol knowledge derived from community reverse-engineering:
- [ha-component-comelit-intercom](https://github.com/nicolas-fricke/ha-component-comelit-intercom) — Nicolas Fricke
- [comelit-client](https://github.com/madchicken/comelit-client) — Pierpaolo Follia
- [Protocol analysis](https://grdw.nl/2023/01/28/my-intercom-part-1.html) — grdw

## License

Apache 2.0
