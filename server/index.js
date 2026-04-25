require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard } = require('@roamhq/wrtc');
const { RTCAudioSource } = nonstandard;
const { spawn } = require('child_process');
const path = require('path');
const { networkInterfaces } = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Config — override any of these with environment variables
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AUDIO_DEV = process.env.AUDIO_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';
// Set VOLUME_BOOST > 1 only when using Stereo Mix (which is affected by system volume).
// Leave at 1 (default) when using VB-Cable — signal is always at full level.
const VOL_BOOST = parseFloat(process.env.VOLUME_BOOST || '1');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 10; // Opus frame size — valid: 2.5 5 10 20 40 60
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_MS) / 1000; // 480
const BYTES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS * 2; // 1920

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../client')));

// ─────────────────────────────────────────────────────────────────────────────
// WebRTC audio source — one shared source, all peers receive the same track
// ─────────────────────────────────────────────────────────────────────────────
const audioSource = new RTCAudioSource();
const audioTrack = audioSource.createTrack();

const peers = new Map();
let peerId = 0;

// ─────────────────────────────────────────────────────────────────────────────
// PCM carry buffer
// FFmpeg sends chunks of arbitrary size. wrtc requires exactly
// BYTES_PER_FRAME (1920) bytes per onData() call. We accumulate incoming
// bytes and drain in exact frame-sized slices.
// ─────────────────────────────────────────────────────────────────────────────
let carryBuffer = Buffer.alloc(0);

function pushPCM(chunk) {
  carryBuffer = Buffer.concat([carryBuffer, chunk]);

  while (carryBuffer.length >= BYTES_PER_FRAME) {
    const frame = carryBuffer.slice(0, BYTES_PER_FRAME);
    carryBuffer = carryBuffer.slice(BYTES_PER_FRAME);

    // Buffer.slice shares Node's pooled backing ArrayBuffer (byteLength = 8192).
    // wrtc validates: samples.buffer.byteLength === numberOfFrames * channels * 2
    // so we must copy into a fresh isolated ArrayBuffer first.
    const ab = new ArrayBuffer(BYTES_PER_FRAME);
    new Uint8Array(ab).set(frame);

    try {
      audioSource.onData({
        samples: new Int16Array(ab), // 960 Int16 elements
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNELS,
        numberOfFrames: SAMPLES_PER_CHANNEL, // 480 — per channel
      });
    } catch {
      // Silently ignore — thrown briefly when no peers are connected
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg — capture audio device → raw PCM → stdout pipe
// ─────────────────────────────────────────────────────────────────────────────
function startFFmpeg() {
  console.log(`[ffmpeg] capturing: "${AUDIO_DEV}"`);

  const ff = spawn('ffmpeg', [
    // Minimise internal buffering
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',

    // DirectShow capture — 20 ms buffer (dshow default is 500 ms)
    '-f', 'dshow',
    '-audio_buffer_size', '20',
    '-i', `audio=${AUDIO_DEV}`,

    // Optional volume boost — only needed for Stereo Mix
    ...(VOL_BOOST !== 1 ? ['-af', `volume=${VOL_BOOST}`] : []),

    // Output: raw signed 16-bit little-endian PCM
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  ff.stdout.on('data', chunk => {
    if (!started) { console.log('[ffmpeg] ✓ audio stream started'); started = true; }
    pushPCM(chunk);
  });

  ff.stderr.on('data', d => {
    const line = d.toString();
    // Suppress spammy progress lines and the benign non-monotonic DTS warning
    // (dshow clock occasionally resets mid-stream — harmless for PCM pipe output)
    if (
      line.includes('size=') ||
      line.includes('time=') ||
      line.includes('speed=') ||
      line.includes('non monotonically increasing dts')
    ) return;
    process.stdout.write('[ffmpeg] ' + line);
  });

  ff.on('close', code => {
    console.log(`[ffmpeg] exited (${code}) — restarting in 2 s`);
    carryBuffer = Buffer.alloc(0);
    setTimeout(startFFmpeg, 2000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket signaling
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const id = ++peerId;
  console.log(`[ws] client ${id} connected (peers: ${peers.size + 1})`);

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── offer-request ──────────────────────────────────────────────────────
    if (msg.type === 'offer-request') {
      const pc = new RTCPeerConnection({ iceServers: [] }); // LAN — no STUN needed
      peers.set(id, pc);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'candidate', candidate }));
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s !== 'new') console.log(`[peer ${id}] ${s}`); // skip noisy 'new' state
        if (['disconnected', 'failed', 'closed'].includes(s)) {
          pc.close();
          peers.delete(id);
        }
      };

      const stream = new MediaStream([audioTrack]);
      const sender = pc.addTrack(audioTrack, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Patch SDP: force 96 kbps stereo Opus.
      // Opus at 96 kbps is perceptually transparent — far exceeds MP3 320 kbps in quality.
      // Patch Opus SDP params for minimum latency on LAN:
      // - stereo=1 / sprop-stereo=1: enable actual stereo (default is mono)
      // - useinbandfec=0: disable in-band FEC (wastes bandwidth, pointless on LAN)
      // - usedtx=1: discontinuous tx — skip encoding silence (saves CPU, no latency effect)
      const sdp = pc.localDescription.sdp.replace(
        /a=fmtp:111 minptime=10;useinbandfec=1/,
        'a=fmtp:111 minptime=10;useinbandfec=0;usedtx=1;stereo=1;sprop-stereo=1'
      );

      ws.send(JSON.stringify({ type: 'offer', sdp: { type: pc.localDescription.type, sdp } }));
    }

    // ── answer ─────────────────────────────────────────────────────────────
    if (msg.type === 'answer') {
      const pc = peers.get(id);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }

    // ── ICE candidate ──────────────────────────────────────────────────────
    if (msg.type === 'candidate') {
      const pc = peers.get(id);
      if (pc && msg.candidate) try { await pc.addIceCandidate(msg.candidate); } catch { }
    }
  });

  ws.on('close', () => {
    console.log(`[ws] client ${id} disconnected`);
    const pc = peers.get(id);
    if (pc) { pc.close(); peers.delete(id); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎙 LAN Radio\n');
  for (const ifaces of Object.values(networkInterfaces()))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal)
        console.log(` http://${iface.address}:${PORT}`);
  console.log('');
  startFFmpeg();
});