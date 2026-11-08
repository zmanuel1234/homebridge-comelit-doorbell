# homebridge-comelit-doorbell

Homebridge plugin for **Comelit ViP** Wi-Fi intercoms (6701W / 6741W Mini). It talks the ViP protocol directly on your LAN (TCP 64100), with no Comelit cloud involved.

- **Doorbell notifications** in the Home app, through a ring sensor and an optional camera doorbell
- **Door release** as a HomeKit lock, allowed only shortly after a ring
- **Experimental: answer the ring** from HomeKit, so anyone in your Home can open the door without the Comelit app
- Every setting is in the Homebridge config editor

This is a continuation of [`homebridge-comelit-intercom`](https://www.npmjs.com/package/homebridge-comelit-intercom) 1.1.1 by danimal4326, whose repository is no longer available. See [NOTICE](NOTICE) and [CHANGELOG](CHANGELOG.md).

## Tested hardware

| Model | Firmware | Status |
|---|---|---|
| 6741W / 6701W Mini hands-free Wi-Fi (model id `MSVU`) | 2.1.0 | Rings, ring sensor, doorbell notifications, door release |

Other ViP devices may work. Please open an issue with your model id and firmware (from the device's web page, *Device info*).

## Requirements

- Homebridge 2.0 (`2.0.0-beta.0` or later), Node.js 18+
- The intercom reachable on your LAN
- **A Comelit user of its own for Homebridge.** If the plugin shares a user with a phone, the intercom delivers each call to only one of them.

## Setup

### 1. Give Homebridge its own Comelit user

1. Open the intercom's web page, `http://<intercom-ip>:8080`, and sign in as installer.
2. Under **Users**, add a user for Homebridge and note its row number (`#3`, for example). That number is the **sub-address**.
3. Download a **backup** from the web page and open `users.cfg` inside it. The 32-character token next to your new user is the plugin's **token**.

### 2. Configure the plugin

Configure it in the Homebridge UI, or by hand:

```json
{
  "platform": "ComelitIntercom",
  "name": "Comelit Intercom",
  "host": "192.168.1.50",
  "token": "0123456789abcdef0123456789abcdef",
  "subaddress": 3
}
```

The platform name stays `ComelitIntercom`, so a config from `homebridge-comelit-intercom` works as is.

### 3. Doorbell notifications (recommended)

The plugin publishes a **ring sensor** (a motion sensor that is active while the bell rings). For a real HomeKit doorbell notification, add a doorbell camera with [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg). It can use a still image as its picture. Enable its local HTTP server, then point `doorbellTriggerUrl` at it, for example `http://localhost:8089/doorbell?Doorbell`.

Put the **Entrance lock** in the same Home room as the doorbell camera. Then the doorbell notification shows the lock, and you can unlock from there.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `host`, `port`, `token` | — , 64100, — | The intercom and the token of the Homebridge user |
| `subaddress` | device default | Row number (#) of the Homebridge user |
| `leaseRefreshMode` | `reconnect` | How the registration is kept fresh: `reconnect` or `inplace` (re-register without dropping the connection) |
| `leaseRefreshMinutes` | 2 | How often. The intercom stops routing calls to a registration after a few minutes. |
| `leaseRecycleMinutes` | 50 | In `inplace` mode, still reconnect fully this often |
| `ringWindowSeconds` | 90 | Unlock is allowed only this long after a ring. `0` allows it at any time. |
| `doorbellTriggerUrl` | `http://localhost:8089/doorbell?Doorbell` | URL called on every ring. Leave empty to turn it off. |
| `registerPush` | `false` | Register as a push device (original behavior). Leave off, because it diverts calls away from the plugin. |
| `answerMode` | `off` | **Experimental.** `handshake` replies to the call without taking it. `answer-on-open` answers when you unlock from Home, opens the door inside the call, then hangs up. |
| `reconnectDelay` | 10 | Seconds before reconnecting after a dropped connection |

## Known limits

- During an unanswered ring, the intercom refuses a door release from a device that didn't answer the call (cause 8, *busy*). Opening from HomeKit during a ring therefore needs `answerMode: answer-on-open`, which is still experimental.
- No live video or two-way audio yet.
- Logs prefixed `zman-call` and `zman-diag` are protocol diagnostics.

## Credits

- danimal4326, for the original `homebridge-comelit-intercom`
- [jfmlima/comelit-vip](https://github.com/jfmlima/comelit-vip) and [ttmx/comelit-vip](https://github.com/ttmx/comelit-vip), for the protocol references

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
