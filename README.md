# 📻 LAN Radio

Stream audio from your PC to any device on your local network with **sub-200ms latency** using WebRTC + Opus. No apps to install on listener devices — just open a browser.

```
Spotify / any audio  →  FFmpeg (capture)  →  Node.js (WebRTC)  →  Browser on any device
      on your PC           WASAPI loopback       Opus 32 kbps         phone / TV / tablet
```

---

## How it works

1. **FFmpeg** captures your PC's audio output using Windows DirectShow (WASAPI loopback) and pipes raw PCM to Node.js
2. **Node.js** feeds that PCM into a WebRTC `RTCAudioSource` via [`@roamhq/wrtc`](https://github.com/WonderInventions/node-webrtc)
3. **WebRTC** encodes the audio as stereo Opus at 96 kbps and streams it over RTP
4. A tiny **WebSocket signaling** layer exchanges the SDP offer/answer between server and each browser
5. Any browser on your LAN visits `http://<your-ip>:3000` and hits **Tune In** — no plugins, no apps

### Why WebRTC and not HTTP streaming?

| Method | Typical latency | Notes |
|---|---|---|
| HTTP + MP3 (`<audio>` tag) | 3–8 s | Browser buffers aggressively |
| WebSocket + PCM | 200–500 ms | You control scheduling |
| **WebRTC (this project)** | **50–200 ms** | Purpose-built for real-time audio |

### Why Opus and not MP3 at 320 kbps?

Opus is a different codec entirely — more efficient, lower latency, and better sounding at the same bitrate. Opus at 96 kbps is perceptually transparent (indistinguishable from lossless). MP3 at 320 kbps is not a meaningful comparison.

---

## Requirements

- Windows 11 (host PC)
- [Node.js](https://nodejs.org) v18 or later
- [FFmpeg](https://ffmpeg.org/download.html) — add to PATH or place `ffmpeg.exe` in the server folder
- An audio capture device (see setup below)

---

## Audio capture setup

You have two options. **VB-Cable is recommended.**

### Option A — VB-Cable (recommended)

**What it is:** A virtual audio cable. Spotify routes its audio into the cable's input, and FFmpeg reads it back from the cable's output — cleanly, at full signal level, completely independent of your system volume.

**Install:**
1. Download and install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free)
2. Reboot

**Configure Windows audio:**

*Playback tab (Sound Settings → More sound settings → Playback):*
| Device | Role |
|---|---|
| CABLE Input (VB-Audio Virtual Cable) | ✅ Default Device |
| Your speakers / headphones | Default Communication Device |

*Recording tab:*
| Device | Role |
|---|---|
| CABLE Output (VB-Audio Virtual Cable) | ✅ Default Device |
| Your microphone | Default Communication Device |

**To hear audio on your own speakers while broadcasting:**
1. Recording tab → right-click **CABLE Output** → Properties
2. **Listen** tab → check "Listen to this device"
3. Select your real speakers/headphones in the dropdown
4. Click OK

**Effect on broadcast:** System volume and mute on the host PC have **no effect** on the broadcast. The signal is captured before Windows applies hardware volume. Listeners always hear full-level audio.

---

### Option B — Stereo Mix

**What it is:** A loopback device built into many Realtek audio drivers. Captures whatever is playing through your speakers.

**Enable it:**
1. Sound Settings → More sound settings → Recording tab
2. Right-click in empty area → **Show Disabled Devices**
3. Right-click **Stereo Mix** → **Enable**

**No Playback changes needed** — your speakers keep working normally.

**Effect on broadcast:** System volume **does** affect the broadcast level. If you mute your PC, the broadcast goes silent. To compensate, set `VOLUME_BOOST` in your environment:
```cmd
set VOLUME_BOOST=6
node index.js
```

This multiplies the captured signal so it stays loud even at lower system volumes. It cannot recover from true mute (digital silence).

---

## Installation

<<<<<<< HEAD
**1. Clone and install dependencies:**
```cmd
git clone https://github.com/your-username/lan-radio.git
cd lan-radio\server
=======
```cmd
cd server
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
npm install
```

> `@roamhq/wrtc` downloads a prebuilt native binary — no compilation needed. Takes ~30 seconds.

<<<<<<< HEAD
**2. Configure your environment:**
```cmd
cd ..
copy .env.example .env
```

Open `.env` in any text editor and set your audio device name. To find the exact name:
```cmd
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | findstr "audio"
```

You'll see something like:
```
"CABLE Output (VB-Audio Virtual Cable)" (audio)
"Stereo Mix (Realtek(R) Audio)" (audio)
```

Copy the name exactly into `.env`:
```env
# VB-Cable (recommended):
AUDIO_DEVICE=CABLE Output (VB-Audio Virtual Cable)

# OR Stereo Mix:
# AUDIO_DEVICE=Stereo Mix (Realtek(R) Audio)
# VOLUME_BOOST=6
```

=======
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
---

## Running

<<<<<<< HEAD
```cmd
cd server
=======
**With VB-Cable (default):**
```cmd
node index.js
```

**With Stereo Mix:**
```cmd
set AUDIO_DEVICE=Stereo Mix (Realtek(R) Audio)
set VOLUME_BOOST=6
node index.js
```

**Custom port:**
```cmd
set PORT=8080
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
node index.js
```

You'll see:
```
🎙  LAN Radio

   http://192.168.1.50:3000

[ffmpeg] capturing: "CABLE Output (VB-Audio Virtual Cable)"
[ffmpeg] ✓ audio stream started
```

---

## Listening

Open `http://<your-ip>:3000` in any browser on your WiFi and press **Tune In**.

Works on: Chrome, Firefox, Safari, Edge — on phones, tablets, smart TVs, laptops.

---

## Client stats display

The browser UI shows live stats updated every second:

| Field | Description |
|---|---|
| **E2E LAG** | Estimated end-to-end latency (jitter buffer delay + RTT/2) |
| **RTT** | Round-trip time between server and browser |
| **JITTER** | Packet arrival variance |
| **JITTER BUF** | WebRTC jitter buffer delay |
| **CODEC** | Negotiated audio codec (should show OPUS) |
| **BITRATE** | Actual received bitrate in kbps |
| **PKTS RX / LOST** | Total packets received and lost |
| **LOSS %** | Packet loss percentage |
| **DECODED** | Total audio samples decoded |
| **ENERGY** | Audio energy level |

The **L/R VU meter** shows separate left and right channel levels in real time.

---

## Firewall

If listener devices can't connect, allow Node.js through Windows Firewall:

```cmd
netsh advfirewall firewall add rule name="LAN Radio" dir=in action=allow protocol=TCP localport=3000
```

---

## Troubleshooting

**No audio / silence on client:**
- Make sure something is actually playing on Spotify
- Verify the audio device name exactly matches. Run this to list devices:
  ```cmd
  ffmpeg -list_devices true -f dshow -i dummy 2>&1 | findstr "audio"
  ```
- Test FFmpeg capture directly:
  ```cmd
  ffmpeg -f dshow -i "audio=CABLE Output (VB-Audio Virtual Cable)" -f s16le -ar 48000 -ac 2 pipe:1 | ffplay -f s16le -ar 48000 -ac 2 -
  ```
  You should hear audio in ffplay. If not, the issue is with your audio device setup, not this project.

**Static / distortion:**
- If using VB-Cable, make sure `VOLUME_BOOST` is not set (or set to `1`). High boost causes clipping.
- If using Stereo Mix, try reducing `VOLUME_BOOST` to `4` or `3`.

**Browser shows "WS ERROR":**
- Make sure the server is running
- Check your firewall (see above)
- Ensure you're on the same WiFi network as the host PC

**`wrtc` install fails:**
- Make sure you're using `@roamhq/wrtc` version `0.10.0` exactly (as in `package.json`)
- Earlier/later versions may fail to install prebuilt binaries on Windows

---

## Project structure

```
lan-radio/
<<<<<<< HEAD
├── .env.example          config template — copy to .env and edit
├── .env                  your local config (gitignored)
├── .gitignore
├── README.md
=======
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
├── server/
│   ├── index.js          Node.js WebRTC broadcast server
│   └── package.json
└── client/
<<<<<<< HEAD
    └── index.html        browser tuner UI (served by the server)
=======
    └── index.html        Browser tuner UI (served by the server)
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
```

---

## Tech stack

| Component | Technology |
|---|---|
| Audio capture | FFmpeg + DirectShow (WASAPI loopback) |
| Audio encoding | Opus 96 kbps stereo via WebRTC |
| Server runtime | Node.js |
| WebRTC in Node | [@roamhq/wrtc](https://github.com/WonderInventions/node-webrtc) |
| Signaling | WebSocket (ws) |
| HTTP server | Express |
<<<<<<< HEAD
| Client | Vanilla JS + Web Audio API |
=======
| Client | Vanilla JS + Web Audio API |
>>>>>>> 444fcd688f3c4146899582557ce18d4dfd2cf32b
