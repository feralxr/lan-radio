const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard } = require('@roamhq/wrtc');
const { RTCAudioSource } = nonstandard;
const { spawn } = require('child_process');
const path = require('path');
const { networkInterfaces } = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT        = process.env.PORT        || 3000;
const AUDIO_DEV   = process.env.AUDIO_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';
const SAMPLE_RATE = 48000;
const CHANNELS    = 2;
const FRAME_MS    = 10;   // Opus frame size — valid: 2.5 5 10 20 40 60 ms
const VOLUME_BOOST = 8;   // multiply gain — keeps broadcast loud regardless of host volume

const SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_MS) / 1000;  // 480
const BYTES_PER_FRAME     = SAMPLES_PER_CHANNEL * CHANNELS * 2; // 1920

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../client')));

// ---------------------------------------------------------------------------
// WebRTC audio source — single source shared across all peers
// ---------------------------------------------------------------------------
const audioSource = new RTCAudioSource();
const audioTrack  = audioSource.createTrack();

const peers = new Map();
let   peerId = 0;

// ---------------------------------------------------------------------------
// PCM carry buffer — FFmpeg sends arbitrary chunk sizes;
// wrtc requires exactly BYTES_PER_FRAME bytes per onData() call.
// ---------------------------------------------------------------------------
let carryBuffer = Buffer.alloc(0);

function pushPCM(chunk) {
  carryBuffer = Buffer.concat([carryBuffer, chunk]);

  while (carryBuffer.length >= BYTES_PER_FRAME) {
    const frame = carryBuffer.slice(0, BYTES_PER_FRAME);
    carryBuffer = carryBuffer.slice(BYTES_PER_FRAME);

    // Must use a fresh ArrayBuffer — Buffer slices share a pooled backing
    // buffer whose byteLength is 8192, which wrtc rejects.
    const ab = new ArrayBuffer(BYTES_PER_FRAME);
    new Uint8Array(ab).set(frame);
    const samples = new Int16Array(ab); // 960 Int16 elements for stereo 10ms

    try {
      audioSource.onData({
        samples,
        sampleRate:     SAMPLE_RATE,
        bitsPerSample:  16,
        channelCount:   CHANNELS,
        numberOfFrames: SAMPLES_PER_CHANNEL, // frames per channel = 480
      });
    } catch (e) {
      // Swallow — happens briefly when no peers are connected
    }
  }
}

// ---------------------------------------------------------------------------
// FFmpeg — WASAPI loopback → raw PCM → stdout
// ---------------------------------------------------------------------------
function startFFmpeg() {
  console.log(`[ffmpeg] capturing from: "${AUDIO_DEV}"`);

  const ff = spawn('ffmpeg', [
    // Low-latency input flags
    '-fflags',          'nobuffer',
    '-flags',           'low_delay',
    '-probesize',       '32',
    '-analyzeduration', '0',

    // DirectShow input — 20ms capture buffer (default is 500ms)
    '-f',                'dshow',
    '-audio_buffer_size', '20',
    '-i',                `audio=${AUDIO_DEV}`,

    // Boost volume so host system volume doesn't affect broadcast level
    '-af', `volume=${VOLUME_BOOST}`,

    // Raw signed 16-bit little-endian PCM output
    '-f',  's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  ff.stdout.on('data', chunk => {
    if (!started) {
      console.log('[ffmpeg] ✓ audio stream started');
      started = true;
    }
    pushPCM(chunk);
  });

  ff.stderr.on('data', d => {
    const line = d.toString();
    // Suppress spammy progress lines
    if (!line.includes('size=') && !line.includes('time=') && !line.includes('speed=')) {
      process.stdout.write('[ffmpeg] ' + line);
    }
  });

  ff.on('close', code => {
    console.log(`[ffmpeg] exited (${code}) — restarting in 2 s`);
    carryBuffer = Buffer.alloc(0);
    setTimeout(startFFmpeg, 2000);
  });
}

// ---------------------------------------------------------------------------
// WebSocket signaling
// ---------------------------------------------------------------------------
wss.on('connection', ws => {
  const id = ++peerId;
  console.log(`[ws] client ${id} connected  (total: ${peers.size + 1})`);

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── offer-request ────────────────────────────────────────────────────
    if (msg.type === 'offer-request') {
      const pc = new RTCPeerConnection({ iceServers: [] }); // LAN — no STUN needed
      peers.set(id, pc);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'candidate', candidate }));
        }
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        console.log(`[peer ${id}] ${s}`);
        if (['disconnected', 'failed', 'closed'].includes(s)) {
          pc.close();
          peers.delete(id);
        }
      };

      // Attach shared audio track
      const stream = new MediaStream([audioTrack]);
      pc.addTrack(audioTrack, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Patch SDP: force 96 kbps stereo Opus
      // Opus at 96 kbps is perceptually transparent — well above MP3 320 in quality.
      const sdp = pc.localDescription.sdp.replace(
        /a=fmtp:(\d+) useinbandfec=1/g,
        'a=fmtp:$1 useinbandfec=1;maxaveragebitrate=96000;stereo=1;sprop-stereo=1'
      );

      ws.send(JSON.stringify({ type: 'offer', sdp: { type: pc.localDescription.type, sdp } }));
    }

    // ── answer ───────────────────────────────────────────────────────────
    if (msg.type === 'answer') {
      const pc = peers.get(id);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }

    // ── ICE candidate ────────────────────────────────────────────────────
    if (msg.type === 'candidate') {
      const pc = peers.get(id);
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    }
  });

  ws.on('close', () => {
    console.log(`[ws] client ${id} disconnected`);
    const pc = peers.get(id);
    if (pc) { pc.close(); peers.delete(id); }
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙  LAN Radio\n`);
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`   http://${iface.address}:${PORT}`);
      }
    }
  }
  console.log('');
  startFFmpeg();
});
