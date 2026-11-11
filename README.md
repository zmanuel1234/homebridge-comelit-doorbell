# homebridge-comelit-doorbell

[![npm](https://img.shields.io/npm/v/homebridge-comelit-doorbell)](https://www.npmjs.com/package/homebridge-comelit-doorbell)
[![CI](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml/badge.svg)](https://github.com/zmanuel1234/homebridge-comelit-doorbell/actions/workflows/ci.yml)

Homebridge plugin for **Comelit ViP** Wi-Fi intercoms (6701W / 6741W Mini). It talks the ViP protocol directly on your network (TCP 64100), with no Comelit cloud involved.

- **A HomeKit video doorbell**: rings on all your Apple devices, with the visitor's picture in the notification
- **Answer from HomeKit**: live video, the door's sound and talk-back, like the Comelit app
- **Open the door** from the live view, the lock, the Apple Watch or Siri, allowed only shortly after a ring
- **Doctor mode**: let every visitor in automatically, always or with a HomeKit switch
- Every setting is in the Homebridge config editor; tested on a 6741W (see [tested hardware](#tested-hardware))

It continues [`homebridge-comelit-intercom`](https://www.npmjs.com/package/homebridge-comelit-intercom) 1.1.1 by danimal4326, whose repository is no longer available. See [NOTICE](NOTICE) and [CHANGELOG](CHANGELOG.md).

## Contents

- [Tested hardware](#tested-hardware)
- [Requirements](#requirements)
- [Setup](#setup)
- [What appears in HomeKit](#what-appears-in-homekit)
- [Recommended Home app setup](#recommended-home-app-setup)
- [Settings](#settings)
- [How ring and unlock work](#how-ring-and-unlock-work)
- [Migrating from homebridge-comelit-intercom](#migrating-from-homebridge-comelit-intercom) (and [updating from 2.0.x](#updating-from-20x))
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Development](#development)

## Tested hardware

Tested on a 6741W / 6701W Mini hands-free Wi-Fi (model id `MSVU`, firmware 2.1.0), with Homebridge on a Raspberry Pi (Homebridge image, ffmpeg 7.0.2), plugin 2.1.0:

| Feature | Works | Notes |
|---|---|---|
| Rings → HomeKit (ring sensor, doorbell notification) | ✅ | With in-place registration renewal every 2 minutes |
| Door release from HomeKit after a ring | ✅ | Refused outside the ring window. During a ring the plugin answers first (`answer-on-view`, `answer-on-open`) |
| Unlocking during a ring without opening the live view | ✅ | From Control Centre: answers, opens and hangs up; the lock shows Unlocked about 6 s after the tap (it waits for a refusal that doesn't come) |
| Visitor's picture in the ring notification | ✅ | Video before answering works; the first picture comes about 3 s after the ring, and HomeKit's picture requests wait for it (none timed out) |
| Doorbell camera: answering by opening the live view | ✅ | |
| Live video | ✅ | 640x240 from the intercom, shown as 4:3; picture after about 2.5 s, about 15–16 frames per second |
| Sound from the door | ✅ | Turned up 12 dB by default; no delay |
| Talk-back | ✅ | |
| Unlocking during the call | ✅ | The intercom ends the call about 13 s after the door opens |
| Last visitor's picture | ✅ | Taken at the ring or the start of the call; kept across restarts |
| Lock shows No Response when the intercom is unreachable | ❓ | Covered by the plugin's tests, not yet tried with a real outage |
| Doctor mode (always, or with its switch) | ✅ | |
| Next Visitor switch | ❓ | New in 2.2.0: the same open as doctor mode; covered by the plugin's tests |
| Recording rings (HomeKit Secure Video) | ✅ | 2.3.0-beta.2 and beta.3 at the door with a home hub: unanswered rings, calls, quick unlocks and Next Visitor rings (open after 5 s) recorded. Sound (beta.4): checked with recorded calls, not yet at the door; the intercom sends none before answering |
| Gate / actuator output | ❓ | Not tested |
| Phones stop ringing when HomeKit answers | ❓ | Expected (the intercom gives the call to whoever answers), not yet observed |

Other ViP devices may work. You'll find the model id and firmware on the intercom's web page, under **Device info**. Please open an issue with them, whether it works or not.

## Requirements

- Homebridge 2.0 (`2.0.0-beta.0` or later) and Node.js 20, 22 or 24
- The intercom on your local network, ideally with a fixed IP address
- **A Comelit user of its own for Homebridge.** If Homebridge shares a user with a phone, the intercom delivers each call to only one of them.
- For a HomeKit doorbell notification, one of:
  - the plugin's own **doorbell camera**, which needs ffmpeg with the `libfdk_aac` encoder. The Homebridge Raspberry Pi image has it (`/usr/local/bin/ffmpeg`, ffmpeg 7.0), and so does the ffmpeg-for-homebridge package (ffmpeg 7.0 or 8.0, depending on its version). Video is checked with ffmpeg 7.0.2 and 8.0.
  - a still-image doorbell camera from [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) (step 4 below)

## Setup

### 1. Create a Comelit user for Homebridge

1. Open the intercom's web page, `http://<intercom-ip>:8080`, and sign in with the installer password.
2. Open **Users** and add a user of type **Apps** for Homebridge. Note its row number (`#3`, for example). That number is the **sub-address**.
3. **Activate it once** with the Comelit app, on any phone or tablet, using the user's activation code. The intercom only creates the user's token at activation: a user that was never activated has none, and the plugin can't log in with it. Afterwards, delete the app from that device or sign out, but **don't deactivate or delete the user** on the intercom, or its token stops working. Nothing else may use this user: if a phone keeps it, the intercom delivers each call to only one of them.
4. Download a **backup** from the web page. Open the archive and find `users.cfg`. Your user is the line `mspUsersMap.0.<row number>`, and its token is the 32-character value in the `9:4:"…"` field.

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
  "subaddress": 3
}
```

Everything else has working defaults. Running the plugin as a **child bridge** is recommended.

### 4. Doorbell notification (recommended)

HomeKit only sends a proper doorbell notification for a doorbell camera. There are two ways to get one:

- **The plugin's own doorbell camera** (recommended): turn on **Doorbell camera with live video**. It rings in HomeKit by itself and, with `answerMode: answer-on-view`, shows the intercom's video during a ring. See [the doorbell camera](#doorbell-camera). Leave the trigger URL below empty, or each ring gives two notifications.
- **A still-image camera from homebridge-camera-ffmpeg**, triggered by this plugin:

1. In camera-ffmpeg, turn on its local HTTP server (`porthttp`, for example 8089, with `localhttp: true`), and add a camera named `Doorbell` with **doorbell** enabled.
2. Set this plugin's **Doorbell camera trigger URL** to `http://localhost:8089/doorbell?Doorbell`. It is empty by default, so nothing is called until you set it.
3. In the Home app, put the **door lock** in the same room as the **Doorbell** camera. When you expand the doorbell notification, the lock then appears under the picture and you can unlock from there.

## What appears in HomeKit

| Accessory | HomeKit type | Notes |
|---|---|---|
| One lock per door | Lock | Read from the intercom's door list, with the names set on the intercom. **Unlock** opens the door. After a tap the lock shows Unlocked for 3 seconds, then Locked again. Outside a call the intercom confirms the open; inside a call it doesn't reply, so Unlocked there means the open was sent and not refused (the log says which). Extra taps while an open is on its way are ignored. If the intercom refuses, it goes straight back to Locked and the log says why. If the intercom has been unreachable for more than 30 s, the lock shows **No Response** in Home until the connection is back. |
| Doorbell (named after **Name**) | Motion sensor | Detected for 5 seconds on every ring. Use it in automations. |
| RTSP cameras listed on the intercom, if any | Motion sensor | Placeholder only: no video yet. Their RTSP URL is written to the log. |
| Doctor mode switch (named **Name** + `Doctor Mode`), only with **Doctor mode** set to *With a HomeKit switch* | Switch | While on, every ring opens the door. Keeps its state across restarts. See [doctor mode](#doctor-mode). |
| Next Visitor switch (named **Name** + `Next Visitor`), only with **Next Visitor switch** on | Switch | While on, the next ring opens the door, then it turns itself off. See [next visitor](#next-visitor). |
| Doorbell camera (named **Name** + `Camera`), only with **Doorbell camera** on | Video doorbell | Rings in HomeKit and shows the intercom's video and audio during a call. See [the doorbell camera](#doorbell-camera). With **Record rings** on, it also has a motion sensor, which is on while a ring is recorded. |

Without the doorbell camera, the plugin's own doorbell accessory doesn't produce a HomeKit doorbell notification. Use the camera doorbell from step 4 for that.

## Recommended Home app setup

For the fewest taps when someone rings (with **Doorbell camera** on and **Answer the ring** set to `answer-on-view`):

- **Room:** put the doorbell camera and the Comelit lock in the same room, and keep other accessories out of it. The live view and the expanded notification show that room's accessories under the picture, so the lock is one tap away.
- **Notifications** (Home app → the camera → settings): keep the doorbell notification on. Turn off notifications for the plugin's ring sensor (the motion sensor named after **Name**), or each ring notifies twice.
- **Banners** (iPhone Settings → Notifications → Home): *Persistent* keeps the ring on screen until you act; *Time Sensitive* lets it through Focus modes.
- **Opening without the video:** add the Comelit lock to Control Centre or the Lock Screen, or use the Apple Watch or Siri ("unlock" followed by the lock's name). During a ring the plugin answers, opens and hangs up by itself.
- **Chime and TV:** a HomePod can play a chime when the doorbell rings, and an Apple TV can show the camera in a corner of the screen; both are turned on in the Home app's settings.
- **Expected visitors:** turn on the **Next Visitor switch** setting, then turn the switch on by hand, by Siri, or from a Home automation: the next ring opens the door and the switch turns itself off. For an afternoon of guests, set **Doctor mode** to *With a HomeKit switch* instead, and turn it off afterwards.

## Settings

In the config editor, settings are grouped as below: the first three groups are open, the others are folded away. Talk-back and the notification picture only show with the doorbell camera on, and the doctor mode delay only with doctor mode or the Next Visitor switch on. JSON keys are shown in brackets.

In JSON, numbers may also be written as plain text (`"subaddress": "3"`). A value that isn't valid (not a number, outside the limits the config editor allows, or not one of its choices) is replaced by its default, and the log says so at startup (`… is not valid, using …`). `true`/`false` may also be written as text. For **Unlock allowed for** that means the 90 s window is kept: only an explicit `0` allows unlocking at any time. At startup the log also shows a one-line summary of the settings in use (`Settings: …`), without the token.

### Intercom

| Setting | Default | Description |
|---|---|---|
| Name (`name`) | `Comelit Intercom` | Platform name in the log, and the Doorbell accessory's name when first created |
| Intercom IP address (`host`) | required | Local IP of the Comelit monitor or Extender |
| User token (`token`) | required | 32-character token of Homebridge's Comelit user |
| User row number (`subaddress`) | the device's default | Row number (#) of that user. Strongly recommended. |

### Doorbell camera and answering

| Setting | Default | Description |
|---|---|---|
| Doorbell camera with live video (`camera`) | `false` | Adds the doorbell camera. See [below](#doorbell-camera). |
| Answer the ring (`answerMode`) | `off` | See [below](#answering-the-ring). `off`, `handshake`, `answer-on-open` or `answer-on-view`. |
| Talk back from the Home app (`talkBack`) | `true` | Sends the Home app's microphone to the intercom's speaker during a live view (on by default since 2.1.0). Set to `false` to hide the microphone button. |
| Visitor's picture in the ring notification (`ringPreview`) | `true` | On a ring, gets the visitor's picture from the intercom before anyone answers, so the notification shows who is at the door instead of an older picture. It doesn't answer the call: the phones and the monitor keep ringing. The intercom's first picture comes about 3 s after the ring, so a picture HomeKit asks for in the first 4.5 s waits for it. If that first picture is empty (black, the camera not ready yet), the plugin waits for the next one, usually about 6 s after the ring, up to 7 s, rather than send a black picture; if none comes in time (or the scene is so dark that every picture is nearly empty), the notification shows the earlier visitor's picture. With debug mode on, the `Ring preview: …` lines say whether it worked, and which picture HomeKit got. Needs the doorbell camera, **Answer the ring** (or doctor mode) not `off`, since the plugin must follow the call, and **Show the last visitor for** above 0. If the intercom sends no picture before an answer, the log says so (`Ring preview: no video before answering`); turn this off then. |
| Record rings (`recording`) | `false` | Beta. Records each ring as a HomeKit Secure Video clip, with sound, from the intercom's first picture until the call ends or the video stops (rings that doctor mode or Next Visitor open: only up to the open). See [recording rings](#recording-rings-homekit-secure-video). Needs the doorbell camera, a home hub and iCloud+. Works with any **Answer the ring** setting: the plugin follows the call without answering it. |

### Door

| Setting | Default | Description |
|---|---|---|
| Unlock allowed for (`ringWindowSeconds`) | `90` | Seconds after a ring during which HomeKit may unlock. `0` allows unlocking at any time. |
| Doctor mode: open the door on every ring (`doctorMode`) | `off` | `off`, `always`, or `switch` (only while a HomeKit switch is on). See [doctor mode](#doctor-mode). |
| Doctor mode and Next Visitor: open after (`doctorModeDelaySeconds`) | `2` | Seconds between the ring and opening (0–30). Turning the switch off cancels the open until the door is actually opened (about 1 s after this delay; if the call was already answered for the open, it is then hung up, unless a live view is showing it). |
| Next Visitor switch (`nextVisitorSwitch`) | `false` | Adds a switch that lets the next visitor in, then turns itself off. See [next visitor](#next-visitor). |
| Next Visitor: turn off after (`nextVisitorMinutes`) | `120` | If nobody rings, the switch turns itself off after this long (1–1440 minutes). |

### Picture and sound

| Setting | Default | Description |
|---|---|---|
| Video quality (`videoQuality`) | `sd` | `sd` asks for 320x240, `hd` for up to 800x480. A 6741W sends 640x240 either way (its camera's format), which the plugin shows as 4:3. |
| Turn up the sound from the door by (`doorVolume`) | `12` | dB of gain on the intercom's audio (its microphone is quiet). 12 dB is about 4 times as loud; loud sounds are limited so they don't distort. `0`: as the intercom sends it. |
| Show the last visitor for (`lastVisitorMinutes`) | `5` | After a call, the camera's picture, and its live view outside a call, show the last visitor this long, then the idle picture. The picture is taken at the ring (with **Visitor's picture in the ring notification** on), or when a live view of the call starts, while the visitor waits at the panel. It is saved in Homebridge's storage folder (`comelit-last-visitor.h264`), so it survives a restart. `0`: always the idle picture. |
| Picture when there is no call (`snapshotImage`) | built-in picture | A JPEG shown when no call is in progress. Empty, or a file that doesn't exist: the picture that comes with the plugin (`assets/doorbell-idle.jpg`). A missing file is named in the log once. |

### Advanced

The intercom only routes rings to a registration for a few minutes, so the plugin refreshes it regularly. A refresh that needs a full reconnect waits while a call is answered (live view or `answer-on-open`), so it can't cut the call (for at most 10 minutes); in-place renewals carry on as usual.

| Setting | Default | Description |
|---|---|---|
| ViP port (`port`) | `64100` | Leave as is |
| Listen for rings (`enableNotifications`) | `true` | Keeps a connection open to receive rings. Turned off, no ring is seen, so the lock refuses to open unless **Unlock allowed for** is `0` (the log warns at startup). |
| Doorbell camera trigger URL (`doorbellTriggerUrl`) | empty | Called on every ring, e.g. `http://localhost:8089/doorbell?Doorbell` for a homebridge-camera-ffmpeg doorbell. Leave empty if you don't use one, or if you use this plugin's doorbell camera. |
| Register as a push device (`registerPush`) | `false` | Original behavior. Leave off: it diverts calls away from Homebridge. |
| Video encoder (`videoCodec`) | `libx264` | ffmpeg encoder for HomeKit, e.g. a hardware encoder your ffmpeg has. `copy` isn't possible: the intercom's video needs new timestamps and its 4:3 shape restored, so it is re-encoded; `copy` falls back to `libx264` with a warning. |
| ffmpeg path (`ffmpegPath`) | auto | Empty: ffmpeg-for-homebridge (on its own or inside homebridge-camera-ffmpeg), then `/usr/local/bin/ffmpeg` (Homebridge Raspberry Pi image), then `ffmpeg` from the path |
| Registration refresh mode (`leaseRefreshMode`) | `inplace` | `inplace`: renew on the open connection, with no gap (default since 2.1.0). `reconnect`: drop and reopen the connection, within 2 s (rings in that gap are missed; a ring during the few seconds of re-registration is kept). |
| Registration refresh interval (`leaseRefreshMinutes`) | `2` | Minutes between refreshes. 2 is proven; longer intervals may miss rings. |
| Full reconnect every (`leaseRecycleMinutes`) | `50` | In `inplace` mode, still reconnect fully this often. With **Listen for rings** off, the only reconnect. |
| Reconnect delay (`reconnectDelay`) | `10` | Seconds to wait after the connection drops. Planned reconnects for the registration wait at most 2 s. |
| Longest reconnect wait (`maxReconnectDelay`) | `300` | If the intercom can't be reached, the wait doubles after each failed attempt (10, 20, 40 … s) up to this many seconds. It goes back to the reconnect delay once connected. |

### Troubleshooting (settings)

The defaults follow what was measured on a 6741W; change them only to troubleshoot.

| Setting | Default | Description |
|---|---|---|
| Wait for the first video or audio (`mediaStartTimeoutSeconds`) | `10` | After answering, hang up if nothing arrives within this time |
| End the call after media stops for (`mediaSilenceSeconds`) | `5` | Treat the call as over when video and audio stop for this long |
| Repeat the video request every (`videoRefreshSeconds`) | `15` | The intercom stops sending video about 35 s after a request |
| Live view: wait for the intercom's video at most (`liveViewWaitSeconds`) | `8` | When the live view opens, wait this long for the intercom's media, then show the picture (the Home app gives up on slow streams) |
| Save each call's video and audio to (`mediaCaptureDir`) | empty | For troubleshooting only. A folder where each call's raw media is saved, once however many devices watch it: the intercom's video (`.h264`) and audio (`.alaw`), and your talk-back (`-talkback.alaw`). The last 10 calls are kept. About 3–5 MB per minute. It also keeps the picture each ring's notification got, as HomeKit received it (`ring-<time of the ring>.jpg`, last 10 rings; the log says whether it was this ring's picture, an earlier visitor's or the idle one). |

## How ring and unlock work

1. Someone rings. The intercom calls every registered receiver at once: the wall monitor, the Comelit apps and Homebridge.
2. The plugin activates the Doorbell motion sensor, and the HomeKit doorbell notification arrives: from the plugin's doorbell camera if it is on, or from the camera-ffmpeg doorbell through the trigger URL if that is set.
3. During **Unlock allowed for** (90 s by default), anyone in your Home can unlock from the notification or from the lock tile. Outside that window, HomeKit shows the unlock as failed and the log says `Open refused`.

### Answering the ring

While a call is ringing and nobody has answered, the intercom refuses a door release from any device that didn't answer (it replies *busy*). The Comelit app works because it answers first. `answerMode` lets the plugin do the same:

| Value | Behavior |
|---|---|
| `off` | The plugin never takes part in the call. Unlocking during a ring is refused as busy. |
| `handshake` | The plugin replies to the call without answering it, for testing. Phones keep ringing. |
| `answer-on-open` | Unlocking from Home answers the ring, opens the door inside the call, then hangs up. Like answering on a phone, the other devices should stop ringing. |
| `answer-on-view` | Opening the doorbell camera's live view answers the ring and shows the intercom's video and audio; unlocking then opens inside that call. Closing the view hangs up. Unlocking during a ring **without** the live view (from the notification, the Watch, Control Centre or Siri) answers the call, opens the door and hangs up. Needs the doorbell camera. |

Every message of the call is logged with the prefix `call:` at debug level: turn on **debug mode** for the child bridge to see them.

### Doctor mode

Like the door of a doctor's office: when someone rings, the plugin answers the call and opens the first door by itself, after **Doctor mode: open after** seconds (2 by default). **Anyone who rings gets in**, so use it only while you expect visitors.

- **Always on** (`"doctorMode": "always"`): every ring opens the door until you change the setting. The log warns about it at startup.
- **With a HomeKit switch** (`"doctorMode": "switch"`): adds a **Doctor Mode** switch. Every ring opens the door only while it is on, so you can turn it on by hand or with a HomeKit automation (for example during opening hours) and off again. It starts off and keeps its state across restarts.

How it works: during an unanswered ring the intercom refuses door opens (*busy*), so the plugin answers the call, opens the door inside it and hangs up, as the Comelit app does when you answer and open. The phones should stop ringing when it answers (not yet observed). If someone answers on a phone first, it doesn't open. It works with any **Answer the ring** setting, including `off`, and needs **Listen for rings**. The HomeKit doorbell notification and the ring sensor still fire, and the lock shows Unlocked for a moment. Turning the switch off during the seconds before the open cancels the open. Log lines start with `Doctor mode:`.

### Next visitor

For one expected visitor (a delivery, a cleaner, a guest), turn on the **Next Visitor switch** setting. It adds a **Next Visitor** switch to HomeKit, separate from doctor mode:

- **Turn it on** by hand, by Siri, or from a Home automation. Renaming it in the Home app to something short (for example *Next Visitor*) makes it easy to say: "Hey Siri, turn on Next Visitor". The log says until when it stays on.
- **The next ring after you turn it on opens the door**, the same way as doctor mode (answer, open, hang up, after **open after** seconds), and the switch **turns itself off**. Later rings ring normally. Turning it off during those seconds cancels the open.
- **If nobody rings**, it turns itself off after **Next Visitor: turn off after** minutes (2 hours by default).
- **If the open doesn't go through** (the intercom isn't reachable, or someone answered on a phone first), the switch **stays on** for the next ring.
- With **doctor mode** also on, a ring opens the door once, and the Next Visitor switch counts as used.
- It keeps its state and its time limit across restarts. Log lines start with `Next visitor` (`Doctor mode and Next visitor` with both on).

### Doorbell camera

With **Doorbell camera** on, the plugin adds a video doorbell to HomeKit:

- **It rings by itself.** You no longer need the homebridge-camera-ffmpeg doorbell, and you can clear the trigger URL.
- **Live video needs a call.** The intercom only sends video and audio inside a call, so set **Answer the ring** to `answer-on-view`. Opening the live view during a ring then answers it, like pressing Answer in the Comelit app, and the other devices stop ringing. Outside a call, the camera shows a still picture.
- **Talk-back** (on by default) sends the Home app's microphone to the intercom's speaker: tap the microphone button in the live view.
- **ffmpeg is required**, with the `libfdk_aac` encoder for HomeKit audio. The one bundled with homebridge-camera-ffmpeg (ffmpeg-for-homebridge) has it. Checked with ffmpeg 7.0.2 (Homebridge Raspberry Pi image) and 8.0.

The media setup follows what the Comelit app does for an outgoing call (two RTPC channels, audio and video requests, a voice-status message). Live video, the intercom's audio, talk-back and unlocking during the call work on a 6741W with the Homebridge Raspberry Pi image's ffmpeg 7.0.2. With debug mode on, the `call:` lines count the video and audio packets received. Every live view ends with a `Doorbell camera: live view summary` line at normal level.

What a call looks like:

- The picture appears about 2–3 s after you open the live view (answering and setting up the media take about 2 s). It starts clean, from the intercom's first keyframe.
- The picture is the intercom's own: 640x240 on a 6741W, shown as 640x480 (4:3), so it is softer than a modern camera. The camera offers the Home app at most 640x480. A Home app that knew the camera from an early 2.1.0 pre-release may still ask for 1280x720; the plugin then enlarges the picture, which works but is less sharp. See [updating from 2.0.x](#updating-from-20x) for how to refresh it.
- The intercom's microphone is quiet; the plugin turns it up by **Turn up the sound from the door by** (12 dB).
- The Home app starts live views muted: tap the speaker icon to hear the door.
- After the door opens, the intercom ends the call by itself after about 10–15 s, and the live view closes. That is the intercom's behavior, as in the Comelit app.
- Inside a call the intercom doesn't send a separate answer to the door open; the plugin takes "no refusal" as opened.

### Recording rings (HomeKit Secure Video)

Beta, new in 2.3.0-beta.1 (sound in beta.3). With **Record rings** (`recording`) on, every ring is saved as a clip in the Home app's camera timeline, answered or not:

- **What is recorded:** from the intercom's first picture, about 3 s after the button press, until the call ends or the intercom stops sending video for 5 s (at most 3 minutes). One clip per ring, whoever answers and however many phones there are. If the live view answers the call, the clip goes on with the live view's video.
- **Rings that doctor mode or the Next Visitor switch open** are recorded only up to the open: the intercom's first picture comes about 3 s after the ring, so with **open after** at 2 s there is no clip, and at 5 s a short one. A call that only opens the door sends no video. The same goes for a ring answered within about 3 s by unlocking from HomeKit (`answer-on-open`).
- **Sound** (new in 2.3.0-beta.3, working from beta.4), when **Record audio** is on in the camera's Recording Options: the door's sound during the call, turned up by **Door volume** as in the live view. During the ring itself, before anyone answers, the plugin asks the intercom for its sound too, but the 6741W doesn't send it then (tested 2026-11-11; the `Ring preview:` line says `sound before answering: none`), so the ring part of a clip is silent.
- **Timing:** each frame and piece of sound keeps the time it arrived from the intercom, so picture and sound stay together, and the clip plays at the right speed whatever the intercom's frame rate (it varies: 8 to 16 frames a second have been seen).
- **How it works:** HomeKit records when a camera's motion sensor turns on, so the camera gets its own motion sensor, which turns on at the intercom's first real picture and off at the end of the call. The ring sensor is unchanged. The live view and the notification picture work as before.

What you need:

1. A **home hub** (an Apple TV or HomePod) and an **iCloud+** plan.
2. **Doorbell camera** on. **Answer the ring** can be anything, `off` included: to get the video, the plugin follows each call (as with doctor mode) without answering it, and asks the intercom for the video during the ring, as **Visitor's picture in the ring notification** does. That setting can be on or off.
3. **Listen for rings** (`enableNotifications`) on: the plugin follows calls through it.
4. In the Home app, open the camera's settings, **Recording Options**, and choose **Stream & Allow Recording** (when home, when away, or both). Leave the activity detection on; the plugin's motion sensor is the only activity.
5. ffmpeg with the `libfdk_aac` encoder when the Home app records sound (the bundled ffmpeg-for-homebridge has it); without sound, any ffmpeg with `libx264` will do.

With the setting on, the startup line `Doorbell camera: ffmpeg …` ends with `recording rings (HomeKit Secure Video)`, the log says `Doorbell camera: HomeKit Secure Video recording on` when the Home app turns recording on, and `Doorbell camera: recording the ring` at each ring. With debug mode on, `recording N: sent the ring to HomeKit, … fragment(s)` says how many pieces went to the hub, then `recording N closed` (the hub usually doesn't confirm the end, and the stream is closed 12 s later: that is normal), or `no ring to record` when the hub asked and there was none (it also asks at the doorbell press itself, before the first picture, and for rings doctor mode opened). Changing this setting changes the camera's services, so the Home app may take a minute to show the recording options; if they don't appear, close the Home app fully and reopen it.

## Migrating from homebridge-comelit-intercom

1. Uninstall `homebridge-comelit-intercom`, but **keep its configuration** when asked.
2. Install `homebridge-comelit-doorbell` and restart Homebridge.
3. If you used a homebridge-camera-ffmpeg doorbell, check that **Doorbell camera trigger URL** is filled in. The old plugin and 2.0.x called `http://localhost:8089/doorbell?Doorbell` when the setting was missing; 2.1.0 and later call nothing.

The platform name stays `ComelitIntercom`, so your config block works unchanged, including the child bridge. Accessory IDs are also unchanged, so rooms and automations should carry over. Any local patches you applied to the old plugin are not needed.

### Updating from 2.0.x

Your config keeps working. What changes:

- **Node.js 20, 22 or 24** is required (2.0.x allowed 18). The Homebridge UI shows the version on its status page, or run `node -v`.
- **Registration refresh mode** defaults to `inplace` (no gap in which rings are missed). Set `leaseRefreshMode: reconnect` to keep the old behavior.
- **Doorbell camera trigger URL** has no default any more (see step 3 above).
- New: the doorbell camera with live video and talk-back, the visitor's picture in the ring notification, unlocking during a ring without the video, doctor mode, No Response on the lock, door volume, and a reconnect back-off. All are in the config editor; see the [changelog](CHANGELOG.md) for the full list.
- The settings screen is regrouped, and the normal log is shorter (protocol details need debug mode). No setting was renamed or removed.
- **If you ran an early 2.1.0 pre-release with the doorbell camera**, the Home app may keep asking for 1280x720 (the live view summary says `asked 1280x720`): it cached the camera's old list of sizes. To refresh it, set **Talk back from the Home app** off, restart the child bridge, open the Home app once, then turn it back on and restart again. Changing talk-back adds or removes a service, which makes the Home app read the camera again; checked on a 6741W setup on 2026-11-09 (1280x720 → 640x360).

## Troubleshooting

The normal log is short: the settings at startup, rings, door opens, doctor mode, one summary line per live view, and anything that goes wrong. Everything else (the connection's steps, registration renewals, the call's messages, the ring preview's details) appears with the child bridge's **debug mode** on; turn it on before testing or reporting a problem.

| Symptom | What to check |
|---|---|
| Rings stop reaching HomeKit after a few minutes | Use the default **Registration refresh interval** of 2 minutes. With debug mode on, the log shows `Registration renewed in place` every refresh; otherwise look for reconnects. |
| No rings at all, but the phones ring | Make sure `subaddress` is a user of its own, not shared with a phone, and that `registerPush` is off. On the intercom's Extender page, the Homebridge user should appear under **Registered slaves**. |
| Unlock shows as failed, or snaps back to Locked | Outside the ring window, this is expected (`Open refused` in the log). During a ring with **Answer the ring** `off`, the log shows `intercom refused (cause 8, busy…)`: see [answering the ring](#answering-the-ring). |
| The lock shows No Response | The intercom has been unreachable for more than 30 s: see the `Reconnecting in … s` lines and check the IP address and the intercom's Wi-Fi. |
| Rings arrive, but camera-ffmpeg's doorbell no longer rings (after updating from 2.0.x) | The trigger URL has no default any more. Set **Doorbell camera trigger URL** to `http://localhost:8089/doorbell?Doorbell`. |
| Live view ends with `video ffmpeg stopped` | ffmpeg failed; the lines before it in the log say why (often a missing encoder: check **Video encoder** and **ffmpeg path**). The plugin ends the view instead of leaving a frozen picture. |
| `… is not valid, using …` at startup | A setting has a value the plugin can't use (for example a negative number or a typo), so its default is used instead. Fix it in the config editor. |
| `The intercom closed channel CTPP` (debug) followed by `Reconnecting in … s` | The intercom ended the channel rings arrive on. The plugin reconnects after the reconnect delay (10 s by default) so rings keep coming. If it happens often, please open an issue with the log. |
| `Reconnecting in … s` with growing waits | The intercom can't be reached (powered off, Wi-Fi, IP changed). The plugin keeps trying, at most every **Longest reconnect wait**. Check the IP address. |
| `Doorbell camera trigger failed` in the log | camera-ffmpeg isn't reachable at the URL. Fix the URL, or set it to an empty string. |
| `Authentication failed` / `Token Not Found` | The token doesn't belong to an active user. Download a fresh backup and copy the token again. |
| Two doorbell notifications per ring | The doorbell camera and a camera-ffmpeg doorbell (trigger URL) both ring. Clear **Doorbell camera trigger URL**, or hide the camera-ffmpeg camera. The log warns about this at startup. |
| The live view shows a frozen, almost still or grey picture | Shouldn't happen since 2.1.0 (tested with ffmpeg 7.0.2 and 8.0). The summary line's `frames sent to the Home app` should grow by about 15–16 per second. |
| The live view stays blank for several seconds | The video can only start at the intercom's first keyframe. The live view's summary line shows `first picture …` and `first keyframe …`; please share it in an issue if it takes long. |
| Talk-back: the visitor doesn't hear you | In the live view's summary line, `microphone data` above zero means the Home app sent your voice, and `talk-back sent` above zero means it went on to the intercom. If both are zero, check the Home app's microphone permission (iPhone **Settings → Home → Microphone**). |
| The live view closes by itself shortly after unlocking | Expected: the intercom ends the call about 10–15 s after the door opens. |
| Live view shows only the picture during a ring | Check `answerMode` is `answer-on-view`. The summary line then says `still picture` instead of `live`; with debug mode on, the `call:` lines show whether the intercom answered. `took over … s; showing the picture` means its media was slow; raise **Live view: wait**. |
| No sound in the live view, or `Unknown encoder 'libfdk_aac'` | The ffmpeg in use lacks `libfdk_aac`. Check the `Doorbell camera: ffmpeg …` line at startup, and set **ffmpeg path** to one that has it (e.g. `/usr/local/bin/ffmpeg` on the Homebridge Pi image). |
| A ring right after a restart doesn't reach the Home app | After Homebridge or the child bridge restarts, the Home app needs up to a minute or two to reconnect. Rings in that time can be missed by HomeKit, though the plugin logs them (`Doorbell ring`). |
| The camera keeps showing a visitor from earlier | That's the last visitor, shown for **Show the last visitor for** minutes after a call. Set it to `0` to always show the idle picture. |

Turn on **debug mode** for the child bridge to see every protocol message (`VIP msg:`), the call's messages (`call:`), diagnostics (`diag:`) and the registration renewals. Without it, the log keeps to rings, door opens, warnings and one summary line per live view. The `call:` lines mentioned in this README need debug mode.

### What to send when reporting a doorbell camera problem

Every live view ends with one summary line, which answers most questions on its own:

```
Doorbell camera: live view summary: 48.6 s, live, asked 640x480 30 fps 299 kbps, first picture 2.5 s,
frames sent to the Home app=718, video units to ffmpeg=756, Home app reports=94, microphone data=187,
ended: the intercom ended the call; intercom: 640x240, first video 0.9 s, first keyframe 1.0 s,
keyframe every 3.1 s, packets video=5228 audio=2277 other=0, talk-back sent=299
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

- Unlocking from HomeKit **during** a ring needs the call to be answered, which the plugin does itself with `answerMode: answer-on-open` or `answer-on-view`, and in doctor mode. With `answerMode: off` or `handshake`, the intercom refuses an open during a ring as *busy*.
- The doorbell camera is tested on one 6741W with a Raspberry Pi: live video, the intercom's audio, talk-back and unlocking during the call.
- Only tested on one model and firmware (see above).
- Doctor mode lets in anyone who rings while it is on. Prefer the switch, turned off by an automation.
- In `reconnect` mode, a ring during the up to 2 s reconnect every refresh interval is missed. `inplace` mode has no such gap.
- Opening inside a call (`answer-on-open`, `answer-on-view`, doctor mode) uses the door's output, but an output of `0` is sent as `1`: tested only on a door with output 1.
- One intercom per Homebridge bridge: for two intercoms, run each in its own child bridge (the accessories' IDs and the saved visitor picture aren't separate per intercom).
- With **Listen for rings** off, each open sets up a door channel that is left open on the intercom until the next full reconnect (every **Full reconnect every** minutes).

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
| `call.ts` | Taking part in a ringing call (`answerMode`), the ring preview, and the call's media |
| `media.ts` | RTP, H.264 depacketizing, keyframes |
| `camera.ts` | Doorbell camera: HomeKit streaming through ffmpeg, talk-back, the visitor's picture |
| `door.ts` | Door release, waiting for the intercom's answer |
| `platform.ts` | Homebridge platform: connection lifecycle, accessories, ring window |
| `config.ts` | Settings and their defaults, the reconnect back-off |
| `protocol.ts` | ICONA frame headers, channel open/close commands, JSON messages, the CTPP registration |
| `channels.ts` | Channel state and the message queue each channel reads from |
| `ctpp.ts` | Registering on the CTPP channel after connecting |
| `auth.ts`, `configReader.ts`, `push.ts` | Login with the token, reading doors and cameras from the intercom, keepalive |
| `accessories/` | The HomeKit lock, ring sensor, doctor mode and Next Visitor switches, and (unused) RTSP camera placeholders |
| `settings.ts` | Names and fixed timings |

Releases are published to npm by GitHub Actions when a GitHub release is created. A pre-release is published under the `beta` tag. The release tag must be `v` followed by the version in `package.json` (e.g. `v2.1.0`, or `v2.1.0-beta.25` for a pre-release), and the release's **Set as a pre-release** box must be ticked exactly for a version with a `-`, or the publish stops.

## Credits

- danimal4326, for the original `homebridge-comelit-intercom`
- [jfmlima/comelit-vip](https://github.com/jfmlima/comelit-vip) and [ttmx/comelit-vip](https://github.com/ttmx/comelit-vip), for the protocol references

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
