# homebridge-comelit-doorbell

[![npm](https://img.shields.io/npm/v/homebridge-comelit-doorbell)](https://www.npmjs.com/package/homebridge-comelit-doorbell)
[![CI](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml/badge.svg)](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml)

Homebridge plugin for **Comelit ViP** Wi-Fi intercoms (6701W / 6741W Mini). It talks the ViP protocol directly on your network (TCP 64100), with no Comelit cloud involved.

- **Doorbell notifications** in the Home app
- **Door release** as a HomeKit lock, allowed only shortly after a ring
- **Experimental:** answer the ring from HomeKit, so anyone in your Home can open the door without the Comelit app
- Every setting is in the Homebridge config editor

It continues [`homebridge-comelit-intercom`](https://www.npmjs.com/package/homebridge-comelit-intercom) 1.1.1 by danimal4326, whose repository is no longer available. See [NOTICE](NOTICE) and [CHANGELOG](CHANGELOG.md).

## Contents

- [Tested hardware](#tested-hardware)
- [Requirements](#requirements)
- [Setup](#setup)
- [What appears in HomeKit](#what-appears-in-homekit)
- [Settings](#settings)
- [How ring and unlock work](#how-ring-and-unlock-work)
- [Migrating from homebridge-comelit-intercom](#migrating-from-homebridge-comelit-intercom)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Development](#development)

## Tested hardware

| Model | Model id | Firmware | Works |
|---|---|---|---|
| 6741W / 6701W Mini hands-free Wi-Fi | `MSVU` | 2.1.0 | Rings, ring sensor, doorbell notification, door release |

Other ViP devices may work. You'll find the model id and firmware on the intercom's web page, under **Device info**. Please open an issue with them, whether it works or not.

## Requirements

- Homebridge 2.0 (`2.0.0-beta.0` or later) and Node.js 18 or later
- The intercom on your local network, ideally with a fixed IP address
- **A Comelit user of its own for Homebridge.** If Homebridge shares a user with a phone, the intercom delivers each call to only one of them.
- Optional: [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg), for a real HomeKit doorbell notification

## Setup

### 1. Create a Comelit user for Homebridge

1. Open the intercom's web page, `http://<intercom-ip>:8080`, and sign in with the installer password.
2. Open **Users**, add a user for Homebridge, and save. Note its row number (`#3`, for example). That number is the **sub-address**.
3. Download a **backup** from the web page. Open the archive and find `users.cfg`. The 32-character token on the line of your new user is the **token**.

Treat the token like a password: don't post it in issues or screenshots. To revoke it, delete the user on the intercom and create a new one.

### 2. Install

In the Homebridge UI, search **Plugins** for `homebridge-comelit-doorbell` and install it. Or run:

```bash
npm install -g homebridge-comelit-doorbell
```

### 3. Configure

Fill in **Intercom IP address**, **User token** and **User row number** in the plugin's settings. The equivalent JSON:

```json
{
  "platform": "ComelitIntercom",
  "name": "Comelit Intercom",
  "host": "192.168.1.50",
  "token": "0123456789abcdef0123456789abcdef",
  "subaddress": 3,
  "leaseRefreshMode": "inplace"
}
```

Everything else has working defaults. Running the plugin as a **child bridge** is recommended.

### 4. Doorbell notification (recommended)

HomeKit only sends a proper doorbell notification for a doorbell camera. You can get one by adding a camera with [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg), using a still image as its picture:

1. In camera-ffmpeg, turn on its local HTTP server (`porthttp`, for example 8089, with `localhttp: true`), and add a camera named `Doorbell` with **doorbell** enabled.
2. Set this plugin's **Doorbell camera trigger URL** to `http://localhost:8089/doorbell?Doorbell`.
3. In the Home app, put the **door lock** in the same room as the **Doorbell** camera. When you expand the doorbell notification, the lock then appears under the picture and you can unlock from there.

## What appears in HomeKit

| Accessory | HomeKit type | Notes |
|---|---|---|
| One lock per door | Lock | Read from the intercom's door list, with the names set on the intercom. **Unlock** opens the door. The lock shows Unlocked for 3 seconds once the intercom confirms, then Locked again. If the intercom refuses, it goes straight back to Locked and the log says why. |
| Doorbell (named after **Name**) | Motion sensor | Detected for 5 seconds on every ring. Use it in automations. |
| RTSP cameras listed on the intercom, if any | Motion sensor | Placeholder only: no video yet. Their RTSP URL is written to the log. |
| Doorbell camera (named **Name** + `Camera`), only with **Doorbell camera** on | Video doorbell | Experimental. Rings in HomeKit and shows the intercom's video and audio during a call. See [the doorbell camera](#doorbell-camera-experimental). |

Without the doorbell camera, the plugin's own doorbell accessory doesn't produce a HomeKit doorbell notification. Use the camera doorbell from step 4 for that.

## Settings

In the config editor, settings are grouped as below. JSON keys are shown in brackets.

### Connection

| Setting | Default | Description |
|---|---|---|
| Name (`name`) | `Comelit Intercom` | Platform name in the log, and the Doorbell accessory's name when first created |
| Intercom IP address (`host`) | required | Local IP of the Comelit monitor or Extender |
| ViP port (`port`) | `64100` | Leave as is |
| User token (`token`) | required | 32-character token of Homebridge's Comelit user |
| User row number (`subaddress`) | the device's default | Row number (#) of that user. Strongly recommended. |

### Doorbell and door

| Setting | Default | Description |
|---|---|---|
| Listen for rings (`enableNotifications`) | `true` | Keeps a connection open to receive rings. Turn off to use only the lock. |
| Doorbell camera trigger URL (`doorbellTriggerUrl`) | `http://localhost:8089/doorbell?Doorbell` | Called on every ring. Set it to an empty string if you don't use a camera doorbell. |
| Unlock allowed for (`ringWindowSeconds`) | `90` | Seconds after a ring during which HomeKit may unlock. `0` allows unlocking at any time. |

### Registration

The intercom only routes rings to a registration for a few minutes, so the plugin refreshes it regularly.

| Setting | Default | Description |
|---|---|---|
| Registration refresh mode (`leaseRefreshMode`) | `reconnect` | `reconnect`: drop and reopen the connection. `inplace`: renew on the open connection, with no gap (recommended). |
| Registration refresh interval (`leaseRefreshMinutes`) | `2` | Minutes between refreshes. 2 is proven; longer intervals may miss rings. |
| Full reconnect every (`leaseRecycleMinutes`) | `50` | In `inplace` mode, still reconnect fully this often |
| Reconnect delay (`reconnectDelay`) | `10` | Seconds to wait after the connection drops |

### Advanced and experimental

| Setting | Default | Description |
|---|---|---|
| Answer the ring (`answerMode`) | `off` | See [below](#answering-the-ring-experimental). `off`, `handshake`, `answer-on-open` or `answer-on-view`. |
| Register as a push device (`registerPush`) | `false` | Original behavior. Leave off: it diverts calls away from Homebridge. |

### Experimental: doorbell camera

| Setting | Default | Description |
|---|---|---|
| Doorbell camera with live video (`camera`) | `false` | Adds the doorbell camera. See [below](#doorbell-camera-experimental). |
| Talk back from the Home app (`talkBack`) | `false` | Sends the Home app's microphone to the intercom's speaker during a live view |
| Video quality (`videoQuality`) | `sd` | `sd` asks for 320x240, `hd` for the intercom's largest picture (640x240 on a 6741W) |
| Video encoder (`videoCodec`) | `libx264` | ffmpeg encoder for HomeKit. `copy` passes the intercom's H.264 through (less CPU, may not play everywhere). |
| ffmpeg path (`ffmpegPath`) | auto | Empty: ffmpeg-for-homebridge (installed with homebridge-camera-ffmpeg), else `ffmpeg` from the path |
| Picture when there is no call (`snapshotImage`) | dark picture | A JPEG shown when no call is in progress |

### Experimental: media timing

For tuning the doorbell camera's live view after real tests. The defaults follow what comelit-vip measured on a 6741W.

| Setting | Default | Description |
|---|---|---|
| Wait for the first video or audio (`mediaStartTimeoutSeconds`) | `10` | After answering, hang up if nothing arrives within this time |
| End the call after media stops for (`mediaSilenceSeconds`) | `5` | Treat the call as over when video and audio stop for this long |
| Repeat the video request every (`videoRefreshSeconds`) | `15` | The intercom stops sending video about 35 s after a request |

## How ring and unlock work

1. Someone rings. The intercom calls every registered receiver at once: the wall monitor, the Comelit apps and Homebridge.
2. The plugin activates the Doorbell motion sensor and calls the trigger URL, and the HomeKit doorbell notification arrives.
3. During **Unlock allowed for** (90 s by default), anyone in your Home can unlock from the notification or from the lock tile. Outside that window, HomeKit shows the unlock as failed and the log says `Open refused`.

### Answering the ring (experimental)

While a call is ringing and nobody has answered, the intercom refuses a door release from any device that didn't answer (it replies *busy*). The Comelit app works because it answers first. `answerMode` lets the plugin do the same:

| Value | Behavior |
|---|---|
| `off` | The plugin never takes part in the call. Unlocking during a ring is refused as busy. |
| `handshake` | The plugin replies to the call without answering it, for testing. Phones keep ringing. |
| `answer-on-open` | Unlocking from Home answers the ring, opens the door inside the call, then hangs up. Like answering on a phone, the other devices stop ringing. |
| `answer-on-view` | Opening the doorbell camera's live view answers the ring and shows the intercom's video and audio; unlocking then opens inside that call. Closing the view hangs up. Needs the doorbell camera. |

Every message of the call is logged with the prefix `call:`. Please share those logs in an issue if you try it.

### Doorbell camera (experimental)

With **Doorbell camera** on, the plugin adds a video doorbell to HomeKit:

- **It rings by itself.** You no longer need the homebridge-camera-ffmpeg doorbell, and you can clear the trigger URL.
- **Live video needs a call.** The intercom only sends video and audio inside a call, so set **Answer the ring** to `answer-on-view`. Opening the live view during a ring then answers it, like pressing Answer in the Comelit app, and the other devices stop ringing. Outside a call, the camera shows a still picture.
- **Talk-back** (optional) sends the Home app's microphone to the intercom's speaker.
- **ffmpeg is required**, with the `libfdk_aac` encoder for HomeKit audio. The one bundled with homebridge-camera-ffmpeg (ffmpeg-for-homebridge) has it.

The media setup follows what the Comelit app does for an outgoing call (two RTPC channels, audio and video requests, a voice-status message). It is untested on a real intercom, so look for the `call:` lines in the log, which count the video and audio packets received.

## Migrating from homebridge-comelit-intercom

1. Uninstall `homebridge-comelit-intercom`, but **keep its configuration** when asked.
2. Install `homebridge-comelit-doorbell` and restart Homebridge.

The platform name stays `ComelitIntercom`, so your config block works unchanged, including the child bridge. Accessory IDs are also unchanged, so rooms and automations should carry over. Any local patches you applied to the old plugin are not needed.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Rings stop reaching HomeKit after a few minutes | Use the default **Registration refresh interval** of 2 minutes. Check the log for `Registration renewed in place` or reconnects. |
| No rings at all, but the phones ring | Make sure `subaddress` is a user of its own, not shared with a phone, and that `registerPush` is off. On the intercom's Extender page, the Homebridge user should appear under **Registered slaves**. |
| Unlock shows as failed, or snaps back to Locked | Outside the ring window, this is expected (`Open refused` in the log). During a ring, the log shows `intercom refused (cause 8, busy…)`: see [answering the ring](#answering-the-ring-experimental). |
| `Doorbell camera trigger failed` in the log | camera-ffmpeg isn't reachable at the URL. Fix the URL, or set it to an empty string. |
| `Authentication failed` / `Token Not Found` | The token doesn't belong to an active user. Download a fresh backup and copy the token again. |

Turn on **debug mode** for the child bridge to see every protocol message (`VIP msg:`).

## Known limits

- Unlocking from HomeKit **during** a ring needs `answerMode: answer-on-open`, which is experimental.
- Live video and talk-back (doorbell camera) are experimental and untested on a real intercom.
- Only tested on one model and firmware (see above).

## Development

The plugin is written in TypeScript (`src/`) and compiled to `dist/`.

```bash
npm ci
npm run build   # compile src/ to dist/
npm test        # unit tests, using frames captured from a real intercom
```

| Module | What it does |
|---|---|
| `client.ts` | TCP connection, channels, and the registration lease |
| `ctp.ts` | CTP frames on the CTPP channel: building, parsing, ACK/FIN words |
| `vipListener.ts` | Rings and other intercom messages; acknowledgements; answers to door opens |
| `call.ts` | Experimental: taking part in a ringing call (`answerMode`), and its media |
| `media.ts` | RTP, H.264 depacketizing, keyframes |
| `camera.ts` | Experimental doorbell camera: HomeKit streaming through ffmpeg, talk-back |
| `door.ts` | Door release, waiting for the intercom's answer |
| `platform.ts` | Homebridge platform: connection lifecycle, accessories, ring window |
| `config.ts` | Settings and their defaults |

Releases are published to npm by GitHub Actions when a GitHub release is created. A pre-release is published under the `beta` tag.

## Credits

- danimal4326, for the original `homebridge-comelit-intercom`
- [jfmlima/comelit-vip](https://github.com/jfmlima/comelit-vip) and [ttmx/comelit-vip](https://github.com/ttmx/comelit-vip), for the protocol references

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
