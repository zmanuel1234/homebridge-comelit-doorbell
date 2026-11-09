# homebridge-comelit-doorbell

[![npm](https://img.shields.io/npm/v/homebridge-comelit-doorbell)](https://www.npmjs.com/package/homebridge-comelit-doorbell)
[![CI](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml/badge.svg)](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml)

Homebridge plugin for **Comelit ViP** Wi-Fi intercoms (6701W / 6741W Mini). It talks the ViP protocol directly on your network (TCP 64100), with no Comelit cloud involved.

- **Doorbell notifications** in the Home app
- **Door release** as a HomeKit lock, allowed only shortly after a ring
- **Experimental:** answer the ring from HomeKit, so anyone in your Home can open the door without the Comelit app
- **Experimental:** a HomeKit video doorbell showing the intercom's video and audio during a ring, with optional talk-back
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
| 6741W / 6701W Mini hands-free Wi-Fi | `MSVU` | 2.1.0 | Rings, ring sensor, doorbell notification, door release; doorbell camera (2.1.0-beta.19): answering from the live view, the intercom's audio, talk-back, unlocking during the call; live video (640x240, shown as 4:3) checked by replaying recorded calls, live on the Pi still to confirm |

Other ViP devices may work. You'll find the model id and firmware on the intercom's web page, under **Device info**. Please open an issue with them, whether it works or not.

## Requirements

- Homebridge 2.0 (`2.0.0-beta.0` or later) and Node.js 20, 22 or 24
- The intercom on your local network, ideally with a fixed IP address
- **A Comelit user of its own for Homebridge.** If Homebridge shares a user with a phone, the intercom delivers each call to only one of them.
- For a HomeKit doorbell notification, one of:
  - the plugin's own **doorbell camera** (experimental), which needs ffmpeg with the `libfdk_aac` encoder. The Homebridge Raspberry Pi image has it (`/usr/local/bin/ffmpeg`, ffmpeg 7.0), and so does the ffmpeg-for-homebridge package (ffmpeg 7.0 or 8.0, depending on its version). Video is checked with ffmpeg 7.0.2 and 8.0.
  - a still-image doorbell camera from [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) (step 4 below)

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

HomeKit only sends a proper doorbell notification for a doorbell camera. There are two ways to get one:

- **The plugin's own doorbell camera** (experimental): turn on **Doorbell camera with live video**. It rings in HomeKit by itself and, with `answerMode: answer-on-view`, shows the intercom's video during a ring. See [the doorbell camera](#doorbell-camera-experimental). Leave the trigger URL below empty, or each ring gives two notifications.
- **A still-image camera from homebridge-camera-ffmpeg**, triggered by this plugin:

1. In camera-ffmpeg, turn on its local HTTP server (`porthttp`, for example 8089, with `localhttp: true`), and add a camera named `Doorbell` with **doorbell** enabled.
2. Set this plugin's **Doorbell camera trigger URL** to `http://localhost:8089/doorbell?Doorbell`. It is empty by default, so nothing is called until you set it.
3. In the Home app, put the **door lock** in the same room as the **Doorbell** camera. When you expand the doorbell notification, the lock then appears under the picture and you can unlock from there.

## What appears in HomeKit

| Accessory | HomeKit type | Notes |
|---|---|---|
| One lock per door | Lock | Read from the intercom's door list, with the names set on the intercom. **Unlock** opens the door. The lock shows Unlocked for 3 seconds once the intercom confirms, then Locked again. Extra taps while an open is on its way are ignored. If the intercom refuses, it goes straight back to Locked and the log says why. |
| Doorbell (named after **Name**) | Motion sensor | Detected for 5 seconds on every ring. Use it in automations. |
| RTSP cameras listed on the intercom, if any | Motion sensor | Placeholder only: no video yet. Their RTSP URL is written to the log. |
| Doorbell camera (named **Name** + `Camera`), only with **Doorbell camera** on | Video doorbell | Experimental. Rings in HomeKit and shows the intercom's video and audio during a call. See [the doorbell camera](#doorbell-camera-experimental). |

Without the doorbell camera, the plugin's own doorbell accessory doesn't produce a HomeKit doorbell notification. Use the camera doorbell from step 4 for that.

## Settings

In the config editor, settings are grouped as below. JSON keys are shown in brackets.

In JSON, numbers may also be written as text (`"subaddress": "3"`). A value that isn't valid is replaced by its default, and the log says so at startup (`… is not valid, using …`). For **Unlock allowed for** that means the 90 s window is kept: only an explicit `0` allows unlocking at any time. At startup the log also shows a one-line summary of the settings in use (`Settings: …`), without the token.

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
| Doorbell camera trigger URL (`doorbellTriggerUrl`) | empty | Called on every ring, e.g. `http://localhost:8089/doorbell?Doorbell` for a homebridge-camera-ffmpeg doorbell. Leave empty if you don't use one, or if you use this plugin's doorbell camera. |
| Unlock allowed for (`ringWindowSeconds`) | `90` | Seconds after a ring during which HomeKit may unlock. `0` allows unlocking at any time. |

### Registration

The intercom only routes rings to a registration for a few minutes, so the plugin refreshes it regularly. A refresh that needs a full reconnect waits while a call is answered (live view or `answer-on-open`), so it can't cut the call (for at most 10 minutes); in-place renewals carry on as usual.

| Setting | Default | Description |
|---|---|---|
| Registration refresh mode (`leaseRefreshMode`) | `reconnect` | `reconnect`: drop and reopen the connection, within 2 s (rings in that gap are missed; a ring during the few seconds of re-registration is kept). `inplace`: renew on the open connection, with no gap (recommended). |
| Registration refresh interval (`leaseRefreshMinutes`) | `2` | Minutes between refreshes. 2 is proven; longer intervals may miss rings. |
| Full reconnect every (`leaseRecycleMinutes`) | `50` | In `inplace` mode, still reconnect fully this often |
| Reconnect delay (`reconnectDelay`) | `10` | Seconds to wait after the connection drops. Planned reconnects for the registration wait at most 2 s. |
| Longest reconnect wait (`maxReconnectDelay`) | `300` | If the intercom can't be reached, the wait doubles after each failed attempt (10, 20, 40 … s) up to this many seconds. It goes back to the reconnect delay once connected. |

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
| Video quality (`videoQuality`) | `sd` | `sd` asks for 320x240, `hd` for up to 800x480. A 6741W sends 640x240 either way (its camera's format), which the plugin shows as 4:3. |
| Video encoder (`videoCodec`) | `libx264` | ffmpeg encoder for HomeKit. `copy` passes the intercom's H.264 through (less CPU, may not play everywhere). |
| ffmpeg path (`ffmpegPath`) | auto | Empty: ffmpeg-for-homebridge (on its own or inside homebridge-camera-ffmpeg), then `/usr/local/bin/ffmpeg` (Homebridge Raspberry Pi image), then `ffmpeg` from the path |
| Picture when there is no call (`snapshotImage`) | built-in picture | A JPEG shown when no call is in progress. Empty, or a file that doesn't exist: the picture that comes with the plugin (`assets/doorbell-idle.jpg`). A missing file is named in the log once. |
| Show the last visitor for (`lastVisitorMinutes`) | `5` | After a call, the camera's picture, and its live view outside a call, show the last visitor this long, then the idle picture. The picture is taken at the start of the call, while the visitor waits at the panel. `0`: always the idle picture. |

### Experimental: media timing and troubleshooting

For tuning the doorbell camera's live view after real tests. The defaults follow what comelit-vip measured on a 6741W.

| Setting | Default | Description |
|---|---|---|
| Wait for the first video or audio (`mediaStartTimeoutSeconds`) | `10` | After answering, hang up if nothing arrives within this time |
| End the call after media stops for (`mediaSilenceSeconds`) | `5` | Treat the call as over when video and audio stop for this long |
| Repeat the video request every (`videoRefreshSeconds`) | `15` | The intercom stops sending video about 35 s after a request |
| Live view: wait for the intercom's video at most (`liveViewWaitSeconds`) | `8` | When the live view opens, wait this long for the intercom's media, then show the picture (the Home app gives up on slow streams) |
| Save each call's video and audio to (`mediaCaptureDir`) | empty | For troubleshooting only. A folder where each live view's raw media is saved: the intercom's video (`.h264`) and audio (`.alaw`), and your talk-back (`-talkback.alaw`). The last 10 views are kept. About 3–5 MB per minute. |

## How ring and unlock work

1. Someone rings. The intercom calls every registered receiver at once: the wall monitor, the Comelit apps and Homebridge.
2. The plugin activates the Doorbell motion sensor, and the HomeKit doorbell notification arrives: from the plugin's doorbell camera if it is on, or from the camera-ffmpeg doorbell through the trigger URL if that is set.
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
- **ffmpeg is required**, with the `libfdk_aac` encoder for HomeKit audio. The one bundled with homebridge-camera-ffmpeg (ffmpeg-for-homebridge) has it. Checked with ffmpeg 7.0.2 (Homebridge Raspberry Pi image) and 8.0.

The media setup follows what the Comelit app does for an outgoing call (two RTPC channels, audio and video requests, a voice-status message). The intercom's audio, talk-back and unlocking during the call work on a 6741W. Live video works when the recorded calls are replayed through ffmpeg 7.0.2 and 8.0; on the Pi itself it is still to be confirmed with 2.1.0-beta.19. The `call:` lines in the log count the video and audio packets received.

What a call looks like:

- The picture appears about 2–3 s after you open the live view (answering and setting up the media take about 2 s).
- The picture is the intercom's own: 640x240 on a 6741W, shown as 4:3, so it is softer than a modern camera.
- The Home app starts live views muted: tap the speaker icon to hear the door.
- After the door opens, the intercom ends the call by itself after about 10–15 s, and the live view closes. That is the intercom's behavior, as in the Comelit app.
- Inside a call the intercom doesn't send a separate answer to the door open; the plugin takes "no refusal" as opened.

## Migrating from homebridge-comelit-intercom

1. Uninstall `homebridge-comelit-intercom`, but **keep its configuration** when asked.
2. Install `homebridge-comelit-doorbell` and restart Homebridge.
3. If you used a homebridge-camera-ffmpeg doorbell, check that **Doorbell camera trigger URL** is filled in. The old plugin and versions up to 2.1.0-beta.6 called `http://localhost:8089/doorbell?Doorbell` when the setting was missing; 2.1.0-beta.7 and later call nothing.

The platform name stays `ComelitIntercom`, so your config block works unchanged, including the child bridge. Accessory IDs are also unchanged, so rooms and automations should carry over. Any local patches you applied to the old plugin are not needed.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Rings stop reaching HomeKit after a few minutes | Use the default **Registration refresh interval** of 2 minutes. Check the log for `Registration renewed in place` or reconnects. |
| No rings at all, but the phones ring | Make sure `subaddress` is a user of its own, not shared with a phone, and that `registerPush` is off. On the intercom's Extender page, the Homebridge user should appear under **Registered slaves**. |
| Unlock shows as failed, or snaps back to Locked | Outside the ring window, this is expected (`Open refused` in the log). During a ring, the log shows `intercom refused (cause 8, busy…)`: see [answering the ring](#answering-the-ring-experimental). |
| Rings arrive, but camera-ffmpeg's doorbell no longer rings (after updating to 2.1.0-beta.7) | The trigger URL has no default any more. Set **Doorbell camera trigger URL** to `http://localhost:8089/doorbell?Doorbell`. |
| Live view ends with `video ffmpeg stopped` | ffmpeg failed; the lines before it in the log say why (often a missing encoder: check **Video encoder** and **ffmpeg path**). The plugin ends the view instead of leaving a frozen picture. |
| `… is not valid, using …` at startup | A setting has a value the plugin can't use (for example a negative number or a typo), so its default is used instead. Fix it in the config editor. |
| `The intercom closed channel CTPP` followed by a reconnect | The intercom ended the channel rings arrive on. The plugin reconnects at once so rings keep coming. If it happens often, please open an issue with the log. |
| `Reconnecting in … s` with growing waits | The intercom can't be reached (powered off, Wi-Fi, IP changed). The plugin keeps trying, at most every **Longest reconnect wait**. Check the IP address. |
| `Doorbell camera trigger failed` in the log | camera-ffmpeg isn't reachable at the URL. Fix the URL, or set it to an empty string. |
| `Authentication failed` / `Token Not Found` | The token doesn't belong to an active user. Download a fresh backup and copy the token again. |
| Two doorbell notifications per ring | The doorbell camera and a camera-ffmpeg doorbell (trigger URL) both ring. Clear **Doorbell camera trigger URL**, or hide the camera-ffmpeg camera. The log warns about this at startup. |
| The live view shows a frozen, almost still or grey picture | Fixed in 2.1.0-beta.19 (beta.17 fixed it only for ffmpeg 8, not the ffmpeg 7.0 on the Homebridge Raspberry Pi image). The summary line's `frames sent to the Home app` should grow by about 16 per second. |
| The live view stays blank for several seconds | The video can only start at a keyframe. The log shows `call: video …; first keyframe … s after …` and `call: a keyframe every … s`; please share those lines in an issue if it takes long. |
| Talk-back: the visitor doesn't hear you | Look for `talk-back: sound from the Home app microphone is arriving` (the Home app sends your voice) and `talk-back sent=…` above zero in `call: media received` (it goes to the intercom). |
| The live view closes by itself shortly after unlocking | Expected: the intercom ends the call about 10–15 s after the door opens. |
| Live view shows only the picture during a ring | Check `answerMode` is `answer-on-view`. Then look for `call: media received video=… audio=…` in the log: zeros mean the intercom accepted the call but sent no media. `took over … s; showing the picture` means it was slow; raise **Live view: wait**. |
| No sound in the live view, or `Unknown encoder 'libfdk_aac'` | The ffmpeg in use lacks `libfdk_aac`. Check the `Doorbell camera: ffmpeg …` line at startup, and set **ffmpeg path** to one that has it (e.g. `/usr/local/bin/ffmpeg` on the Homebridge Pi image). |
| The camera keeps showing a visitor from earlier | That's the last visitor, shown for **Show the last visitor for** minutes after a call. Set it to `0` to always show the idle picture. |

Turn on **debug mode** for the child bridge to see every protocol message (`VIP msg:`).

### What to send when reporting a doorbell camera problem

Every live view ends with one summary line, which answers most questions on its own:

```
Doorbell camera: live view summary: 33.1 s, live, asked 1280x720 30 fps 299 kbps, first picture 2.4 s,
frames sent to the Home app=480, video units to ffmpeg=1650, Home app reports=62, microphone data=210,
ended: the intercom ended the call; intercom: 800x480, first video 0.9 s, first keyframe 2.3 s,
keyframe every 2.0 s, packets video=3706 audio=1548 other=0, talk-back sent=840
```

| Part | Meaning |
|---|---|
| `first picture` | When the video could start (the intercom's first keyframe). Before that, the view is blank. |
| `frames sent to the Home app` | Frames ffmpeg encoded and sent. 0 with video arriving: ffmpeg problem. |
| `Home app reports` | Reports the Home app sent back while receiving. 0: the stream doesn't reach the phone. |
| `microphone data` / `talk-back sent` | Your voice arriving from the Home app / sent on to the intercom. |
| `intercom: …` | The real video size, when video and keyframes arrived, and packet counts. |

To collect the plugin's lines for a test, replace the times with yours (here 18:13–18:29):

```bash
grep -E "\[Comelit Intercom\]" /var/lib/homebridge/homebridge.log | grep -E "(6|18):(1[3-9]|2[0-9]):" | grep -v "VIP msg:" > ~/comelit-test.txt
```

For picture or sound problems, set **Save each call's video and audio to**, test again, and attach the files from that folder.

## Known limits

- Unlocking from HomeKit **during** a ring needs the call to be answered: `answerMode: answer-on-open`, or `answer-on-view` from the camera's live view. Both are experimental.
- The doorbell camera is experimental, tested on one 6741W: the intercom's audio, talk-back and unlocking during the call. Live video is checked with recordings, and still to be confirmed live on the Pi.
- Only tested on one model and firmware (see above).
- In `reconnect` mode, a ring during the up to 2 s reconnect every refresh interval is missed. `inplace` mode has no such gap.

## Development

The plugin is written in TypeScript (`src/`) and compiled to `dist/`.

```bash
npm ci
npm run build   # compile src/ to dist/
npm test        # unit tests, using frames captured from a real intercom
```

CI runs the checks on Node 24 (the required `check` job) and the build and tests on Node 20 and 22.

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
| `config.ts` | Settings and their defaults, the reconnect back-off |
| `protocol.ts` | ICONA frame headers, channel open/close commands, JSON messages, the CTPP registration |
| `channels.ts` | Channel state and the message queue each channel reads from |
| `ctpp.ts` | Registering on the CTPP channel after connecting |
| `auth.ts`, `configReader.ts`, `push.ts` | Login with the token, reading doors and cameras from the intercom, keepalive |
| `accessories/` | The HomeKit lock, ring sensor and (unused) RTSP camera placeholders |
| `settings.ts` | Names and fixed timings |

Releases are published to npm by GitHub Actions when a GitHub release is created. A pre-release is published under the `beta` tag. The release tag must be `v` followed by the version in `package.json` (e.g. `v2.1.0-beta.8`), or the publish stops.

## Credits

- danimal4326, for the original `homebridge-comelit-intercom`
- [jfmlima/comelit-vip](https://github.com/jfmlima/comelit-vip) and [ttmx/comelit-vip](https://github.com/ttmx/comelit-vip), for the protocol references

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
