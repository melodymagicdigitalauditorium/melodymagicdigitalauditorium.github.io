import {
  Room,
  RoomEvent,
  Track
} from "https://esm.sh/livekit-client@2";

import { auth, db } from "./firebase.js";

import {
  ref,
  get,
  set,
  push,
  onValue,
  off
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

/* =========================================
   MELODY MAGIC DIGITAL AUDITORIUM
========================================= */

const LIVEKIT_URL =
  "wss://melody-magic-auditorium-wrgjlqio.livekit.cloud";

const TOKEN_SERVER =
  "https://lucky-night-b9bfmelody-magic-token-server.akbusinessenterprisess.workers.dev/";

const params = new URLSearchParams(location.search);

const showId = params.get("showId");
const registrationId = params.get("registrationId");
const requestedMode = (params.get("mode") || "audience").toLowerCase();

const IS_HOST_CONTROL_PAGE =
  location.pathname.toLowerCase().endsWith(
    "host-performance-control.html"
  );

const REACTION_TOPIC = "mm-reactions";

const ALLOWED_REACTIONS = [
  "👏", "❤️", "😂", "🔥", "🎤", "😍", "🎉"
];

let currentUser = null;
let currentShow = null;
let room = null;

let currentRole = null;
let isHost = false;
let isJoined = false;

let microphoneAllowed = false;
let cameraAllowed = false;

let localMicEnabled = false;
let localCameraEnabled = false;

let stageSingerUids = [];
let registrations = {};
let participantPermissions = {};

let permissionListener = null;
let stageListener = null;
let registrationListener = null;
let controlsListener = null;

let commentsListener = null;
let queueListener = null;
let playbackListener = null;
let showLifecycleListener = null;
let showLifecycleTimer = null;
let showLifecycleState = "Scheduled";

let joining = false;
let leaving = false;

let lastReactionTimes = [];

let audioEffects = null;
let rawMicrophoneTrack = null;
let processedMicrophoneTrack = null;
let publishedMicrophoneTrack = null;

let youtubePlayer = null;
let youtubeApiPromise = null;
let lastYoutubeVideoId = "";
let lastPlaybackSignature = "";
let playbackSyncTimer = null;

let liveComments = [];
let liveQueue = [];


/* =========================================
   AUDIO EFFECTS
========================================= */

class VirtualAudioEffects {
  constructor() {
    this.context = null;
    this.source = null;
    this.destination = null;
    this.processedTrack = null;

    this.dryGain = null;
    this.wetGain = null;
    this.delay = null;
    this.feedback = null;
    this.echoGain = null;
    this.convolver = null;
    this.reverbGain = null;
    this.outputGain = null;
    this.monitorGain = null;

    this.monitorEnabled = false;
  }

  async start(inputTrack) {
    this.stop();

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio is not supported by this browser.");
    }

    this.context = new AudioContextClass();

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    this.source = this.context.createMediaStreamSource(
      new MediaStream([inputTrack])
    );

    this.destination =
      this.context.createMediaStreamDestination();

    this.dryGain = this.context.createGain();
    this.dryGain.gain.value = 1;

    this.delay = this.context.createDelay(1.5);
    this.delay.delayTime.value = 0.28;

    this.feedback = this.context.createGain();
    this.feedback.gain.value = 0.25;

    this.echoGain = this.context.createGain();
    this.echoGain.gain.value = 0;

    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.echoGain);

    this.convolver = this.context.createConvolver();
    this.convolver.buffer = this.createReverbImpulse(2.5, 2.5);

    this.reverbGain = this.context.createGain();
    this.reverbGain.gain.value = 0;

    this.source.connect(this.convolver);
    this.convolver.connect(this.reverbGain);

    this.wetGain = this.context.createGain();
    this.wetGain.gain.value = 0;

    this.source.connect(this.dryGain);
    this.source.connect(this.delay);

    this.echoGain.connect(this.wetGain);
    this.reverbGain.connect(this.wetGain);

    this.outputGain = this.context.createGain();
    this.outputGain.gain.value = 0.8;

    this.dryGain.connect(this.outputGain);
    this.wetGain.connect(this.outputGain);

    this.outputGain.connect(this.destination);

    this.monitorGain = this.context.createGain();
    this.monitorGain.gain.value = 0;

    this.outputGain.connect(this.monitorGain);
    this.monitorGain.connect(this.context.destination);

    this.processedTrack =
      this.destination.stream.getAudioTracks()[0];

    this.processedTrack.enabled = false;

    return this.processedTrack;
  }

  createReverbImpulse(duration, decay) {
    const rate = this.context.sampleRate;
    const length = Math.floor(rate * duration);

    const impulse = this.context.createBuffer(2, length, rate);

    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);

      for (let i = 0; i < length; i++) {
        data[i] =
          (Math.random() * 2 - 1) *
          Math.pow(1 - i / length, decay);
      }
    }

    return impulse;
  }

  setMuted(muted) {
    if (this.processedTrack) {
      this.processedTrack.enabled = !muted;
    }
  }

  setEcho(value) {
    if (!this.echoGain || !this.context) return;

    const amount = Math.max(0, Math.min(100, Number(value))) / 100;

    this.echoGain.gain.setTargetAtTime(
      amount * 0.6,
      this.context.currentTime,
      0.03
    );
  }

  setDelayTime(value) {
    if (!this.delay || !this.context) return;

    const milliseconds = Math.max(
      50,
      Math.min(1000, Number(value))
    );

    this.delay.delayTime.setTargetAtTime(
      milliseconds / 1000,
      this.context.currentTime,
      0.03
    );
  }

  setFeedback(value) {
    if (!this.feedback || !this.context) return;

    const amount = Math.max(0, Math.min(85, Number(value))) / 100;

    this.feedback.gain.setTargetAtTime(
      amount,
      this.context.currentTime,
      0.03
    );
  }

  setReverb(value) {
    if (!this.reverbGain || !this.context) return;

    const amount = Math.max(0, Math.min(100, Number(value))) / 100;

    this.reverbGain.gain.setTargetAtTime(
      amount * 0.6,
      this.context.currentTime,
      0.03
    );
  }

  setMix(value) {
    if (!this.dryGain || !this.wetGain || !this.context) return;

    const mix = Math.max(0, Math.min(100, Number(value))) / 100;

    this.dryGain.gain.setTargetAtTime(
      1 - mix * 0.5,
      this.context.currentTime,
      0.03
    );

    this.wetGain.gain.setTargetAtTime(
      mix,
      this.context.currentTime,
      0.03
    );
  }

  setVolume(value) {
    if (!this.outputGain || !this.context) return;

    const volume = Math.max(0, Math.min(100, Number(value))) / 100;

    this.outputGain.gain.setTargetAtTime(
      volume,
      this.context.currentTime,
      0.03
    );
  }
    setMonitor(enabled) {
    if (!this.monitorGain || !this.context) return;

    this.monitorEnabled = Boolean(enabled);

    const volume = this.monitorEnabled
      ? Number(byId("mmMonitorVolume")?.value || 35) / 100
      : 0;

    this.monitorGain.gain.setTargetAtTime(
      volume,
      this.context.currentTime,
      0.03
    );
  }

  setMonitorVolume(value) {
    if (!this.monitorGain || !this.context) return;

    const volume = Math.max(0, Math.min(100, Number(value))) / 100;

    this.monitorGain.gain.setTargetAtTime(
      this.monitorEnabled ? volume : 0,
      this.context.currentTime,
      0.03
    );
  }

  stop() {
    if (this.processedTrack) {
      try {
        this.processedTrack.stop();
      } catch (error) {}
    }

    if (this.context) {
      this.context.close().catch(() => {});
    }

    this.context = null;
    this.source = null;
    this.destination = null;
    this.processedTrack = null;
    this.dryGain = null;
    this.wetGain = null;
    this.delay = null;
    this.feedback = null;
    this.echoGain = null;
    this.convolver = null;
    this.reverbGain = null;
    this.outputGain = null;
    this.monitorGain = null;
  }
}


/* =========================================
   HELPERS
========================================= */

function byId(id) {
  return document.getElementById(id);
}

function safeText(value) {
  return String(value ?? "");
}

function showMessage(message, type = "info") {
  const status = byId("mmLiveStatus");

  if (status) {
    status.textContent = message;
    status.dataset.type = type;
  }

  console.log("[Melody Magic]", message);
}

function setButtonState(id, disabled, text) {
  const button = byId(id);
  if (!button) return;

  button.disabled = disabled;

  if (text) button.textContent = text;
}

function isApproved(value) {
  return ["approved", "queued", "playing"].includes(
    safeText(value).toLowerCase()
  );
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === "object") {
    return Object.values(value);
  }

  return [];
}

function escapeHTML(value) {
  return safeText(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function displayName() {
  return safeText(
    currentUser?.displayName ||
    currentUser?.email?.split("@")[0] ||
    (currentRole === "host" ? "Host" : "Participant")
  ).slice(0, 60);
}


/* =========================================
   CREATE PANEL
========================================= */

function createPanel() {
  if (!IS_HOST_CONTROL_PAGE) {
    byId("mmAudioEffects")?.remove();
    byId("mmHostControls")?.remove();
  }

  if (byId("mmLiveKitPanel")) return;
    const target =
    byId("livekitArea") ||
    byId("livekitPanel") ||
    document.body;

  const panel = document.createElement("section");
  panel.id = "mmLiveKitPanel";

  panel.innerHTML = `
    <style>
      #mmLiveKitPanel {
        width:100%;
        max-width:1100px;
        margin:20px auto;
        padding:18px;
        box-sizing:border-box;
        color:#fff;
        background:#111;
        border:1px solid #9b7628;
        border-radius:14px;
        font-family:Arial,sans-serif;
      }

      #mmLiveKitPanel h2,
      #mmLiveKitPanel h3 {
        color:#e9bd57;
      }

      #mmLiveKitPanel button,
      #mmLiveKitPanel select,
      #mmLiveKitPanel input,
      #mmLiveKitPanel textarea {
        box-sizing:border-box;
        font:inherit;
      }

      #mmLiveKitPanel button,
      #mmLiveKitPanel select {
        padding:10px 13px;
        margin:5px 4px 5px 0;
        border-radius:7px;
        border:1px solid #b58a35;
        background:#252525;
        color:#fff;
        cursor:pointer;
      }

      #mmLiveKitPanel button:disabled {
        opacity:.45;
        cursor:not-allowed;
      }

      #mmLiveKitPanel input[type=range] {
        width:100%;
        accent-color:#d7ad4c;
      }

      #mmLiveKitPanel input[type=checkbox] {
        accent-color:#d7ad4c;
      }

      #mmLiveKitPanel .mm-status {
        background:#202020;
        border-radius:8px;
        padding:12px;
        margin:10px 0;
        overflow-wrap:anywhere;
      }

      #mmLiveKitPanel .mm-video-grid {
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
        gap:12px;
        margin-top:15px;
      }

      #mmLiveKitPanel .mm-video-box {
        min-height:150px;
        background:#050505;
        border:1px solid #555;
        border-radius:9px;
        overflow:hidden;
      }

      #mmLiveKitPanel .mm-video-box video {
        width:100%;
        max-height:360px;
        min-height:150px;
        object-fit:contain;
        background:#000;
      }

      #mmLiveKitPanel .mm-video-box audio {
        width:100%;
      }

      #mmLiveKitPanel .mm-video-name {
        padding:7px;
        background:#222;
        color:#e9bd57;
        font-size:13px;
      }

      #mmLiveKitPanel .mm-section {
        margin-top:18px;
        padding-top:12px;
        border-top:1px solid #444;
      }

      #mmLiveKitPanel .mm-note {
        font-size:13px;
        color:#bbb;
        line-height:1.5;
      }

      #mmReactionButtons {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin:12px 0;
      }

      #mmLiveKitPanel .mm-reaction-button {
        min-width:52px;
        min-height:48px;
        font-size:25px;
        padding:7px 12px;
        background:#24201a;
        border:1px solid #9b7628;
        border-radius:12px;
      }

      #mmReactionOverlay {
        min-height:60px;
        overflow:hidden;
        border:1px solid #51401e;
        border-radius:10px;
        background:#080808;
        margin-top:10px;
        padding:8px;
      }

      #mmLiveKitPanel .mm-reaction-item {
        display:inline-flex;
        align-items:center;
        gap:7px;
        margin:5px;
        padding:7px 11px;
        border-radius:20px;
        background:#292319;
        border:1px solid #806126;
        color:#fff;
        font-size:14px;
      }

      #mmLiveKitPanel .mm-reaction-emoji {
        font-size:25px;
      }

      #mmLiveKitPanel .mm-singer-control {
        background:#1c1c1c;
        border:1px solid #51401e;
        border-radius:9px;
        padding:12px;
        margin:9px 0;
      }

      #mmLiveKitPanel .mm-permission-status {
        color:#e9bd57;
        font-size:13px;
        margin:5px 0;
      }

      #mmLiveKitPanel .mm-effect-control {
        margin:12px 0;
        padding:10px;
        background:#1b1b1b;
        border-radius:8px;
      }

      #mmLiveKitPanel .mm-effect-control label {
        display:block;
        margin-bottom:7px;
      }

      #mmLiveKitPanel [hidden] {
        display:none !important;
      }

      #mmLiveKitPanel .mm-two-column {
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
        gap:14px;
      }

      #mmLiveKitPanel .mm-card {
        background:#1b1b1b;
        border:1px solid #51401e;
        border-radius:10px;
        padding:12px;
        margin:8px 0;
      }

      #mmLiveKitPanel .mm-list {
        max-height:260px;
        overflow-y:auto;
      }

      #mmLiveKitPanel .mm-comment {
        padding:9px;
        border-bottom:1px solid #333;
        overflow-wrap:anywhere;
      }

      #mmLiveKitPanel .mm-comment strong {
        color:#e9bd57;
      }

      #mmLiveKitPanel .mm-comment-time {
        color:#888;
