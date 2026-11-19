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
        font-size:11px;
      }

      #mmLiveKitPanel .mm-input {
        width:100%;
        padding:11px;
        border-radius:7px;
        border:1px solid #777;
        background:#202020;
        color:white;
        margin:5px 0;
      }

      #mmLiveKitPanel .mm-comment-compose {
        display:flex;
        gap:7px;
        flex-wrap:wrap;
      }

      #mmLiveKitPanel .mm-comment-compose input {
        flex:1;
        min-width:180px;
      }

      #mmLiveKitPanel #mmYoutubeFrame {
        width:100%;
        aspect-ratio:16/9;
        min-height:220px;
        border:0;
        background:#000;
        border-radius:8px;
      }

      #mmLiveKitPanel .mm-count {
        display:inline-block;
        background:#282117;
        border:1px solid #806126;
        border-radius:20px;
        padding:6px 12px;
        color:#e9bd57;
        margin:4px 0;
      }

      #mmLiveKitPanel .mm-queue-item {
        padding:9px;
        border-bottom:1px solid #333;
      }

      #mmLiveKitPanel .mm-queue-item.current {
        border:1px solid #b58a35;
        border-radius:7px;
        background:#292319;
      }
    </style>

    <h2>Melody Magic Live Auditorium</h2>

    <div id="mmLiveStatus" class="mm-status">
      Checking auditorium connection...
    </div>

    <div id="mmRoleInfo" class="mm-note"></div>

    <div>
      <button id="mmJoinBtn">Enter Live Auditorium</button>
      <button id="mmLeaveBtn" disabled>Leave Auditorium</button>
    </div>

    <div class="mm-section" id="mmMyControls" hidden>
      <h3>My Controls</h3>
      <button id="mmMicBtn" disabled>Microphone OFF</button>
      <button id="mmCameraBtn" disabled>Camera OFF</button>
      <div id="mmPermissionInfo" class="mm-note">
        Waiting for host permission.
      </div>
    </div>

    <div class="mm-section" id="mmAudioEffects" hidden>
      <h3>🎚️ Host Microphone Audio Effects</h3>
      <div class="mm-note">
        These controls are exclusively for the verified host.
        Headphones are recommended when monitoring your voice.
      </div>

      <div class="mm-effect-control">
        <label>Echo: <strong id="mmEchoValue">0%</strong></label>
        <input id="mmEcho" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Delay Time: <strong id="mmDelayValue">280 ms</strong></label>
        <input id="mmDelay" type="range" min="50" max="1000" value="280">
      </div>

      <div class="mm-effect-control">
        <label>Echo Feedback: <strong id="mmFeedbackValue">25%</strong></label>
        <input id="mmFeedback" type="range" min="0" max="85" value="25">
      </div>

      <div class="mm-effect-control">
        <label>Reverb: <strong id="mmReverbValue">0%</strong></label>
        <input id="mmReverb" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Wet / Dry Mix: <strong id="mmMixValue">0%</strong></label>
        <input id="mmMix" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Microphone Output: <strong id="mmVolumeValue">80%</strong></label>
        <input id="mmVolume" type="range" min="0" max="100" value="80">
      </div>

      <div class="mm-effect-control">
        <label>
          <input id="mmMonitor" type="checkbox">
          Monitor my voice through this device
        </label>

        <label>Monitor Volume: <strong id="mmMonitorValue">35%</strong></label>
        <input id="mmMonitorVolume" type="range" min="0" max="100" value="35">

        <div class="mm-note">Use headphones to avoid feedback.</div>
      </div>

      <div id="mmEffectsStatus" class="mm-note">
        Host microphone effects are ready.
      </div>
    </div>

    <div class="mm-section" id="mmReactionSection">
      <h3>💛 Send Your Reactions</h3>
      <div id="mmReactionButtons">
        ${ALLOWED_REACTIONS.map(emoji =>
          `<button type="button"
            class="mm-reaction-button"
            data-reaction="${emoji}"
            disabled>${emoji}</button>`
        ).join("")}
      </div>
      <div id="mmReactionOverlay">
        <span class="mm-note">Live reactions will appear here.</span>
      </div>
      <div id="mmReactionHint" class="mm-note">
        Enter the auditorium to send reactions.
      </div>
    </div>

    <div class="mm-section" id="mmHostControls" hidden>
      <h3>👑 Host Stage Controls</h3>

      <label for="mmStageMode">Stage format:</label>
      <select id="mmStageMode">
        <option value="solo">Solo performance</option>
        <option value="duet">Duet performance</option>
      </select>

      <div>
        <label for="mmSingerOne">Singer 1:</label>
        <select id="mmSingerOne">
          <option value="">Select approved singer</option>
        </select>
      </div>

      <div>
        <label for="mmSingerTwo">Singer 2:</label>
        <select id="mmSingerTwo">
          <option value="">Select second singer</option>
        </select>
      </div>

      <button id="mmSetStageBtn">Assign Main Stage</button>

      <div class="mm-note">
        Singers can keep their cameras on while waiting.
        Microphone access is controlled separately.
      </div>

      <div class="mm-section">
              <h3>🎙️ Singer Microphone Permissions</h3>
        <div id="mmSingerPermissions">
          No approved singers found.
        </div>
      </div>
    </div>

    <div class="mm-section">
      <h3>🎵 Common Karaoke Screen</h3>
      <div id="mmYoutubeContainer" class="mm-card">
        <div id="mmYoutubePlayer">
          <div class="mm-note">
            The host's selected karaoke video will appear here.
          </div>
        </div>
        <div id="mmPlaybackStatus" class="mm-note">
          Waiting for host playback.
        </div>
      </div>
    </div>

    <div class="mm-section mm-two-column">
      <div class="mm-card">
        <h3>👥 Live Audience</h3>
        <div class="mm-count">
          Connected participants: <strong id="mmAudienceCount">0</strong>
        </div>
        <div class="mm-note">
          Count includes connected host, singers and audience members.
        </div>
      </div>

      <div class="mm-card">
        <h3>🎤 Current Performance</h3>
        <div id="mmCurrentPerformer">Waiting for the host to start a performance.</div>
      </div>
    </div>

    <div class="mm-section">
      <h3>📋 Upcoming Performers</h3>
      <div id="mmQueueList" class="mm-card mm-list">
        <span class="mm-note">Waiting for the performer queue.</span>
      </div>
    </div>

    <div class="mm-section">
      <h3>💬 Live Auditorium Comments</h3>
      <div id="mmCommentsList" class="mm-card mm-list">
        <span class="mm-note">Comments will appear here.</span>
      </div>

      <div class="mm-comment-compose">
        <input
          id="mmCommentInput"
          class="mm-input"
          type="text"
          maxlength="300"
          placeholder="Write a comment (maximum 300 characters)"
        >
        <button id="mmSendCommentBtn" disabled>Send Comment</button>
      </div>

      <div class="mm-note" id="mmCommentHint">
        Enter the auditorium to post a comment.
      </div>
    </div>

    <div class="mm-section">
      <h3>Live Stage Camera & Audio</h3>
      <div id="mmVideoGrid" class="mm-video-grid"></div>
    </div>
  `;

  target.appendChild(panel);

  if (!IS_HOST_CONTROL_PAGE) {
    byId("mmHostControls")?.remove();
    byId("mmAudioEffects")?.remove();
  }

  byId("mmJoinBtn").addEventListener("click", joinAuditorium);
  byId("mmLeaveBtn").addEventListener("click", leaveAuditorium);

  byId("mmMicBtn").addEventListener("click", toggleMicrophone);
  byId("mmCameraBtn").addEventListener("click", toggleCamera);

  byId("mmSetStageBtn")?.addEventListener(
    "click",
    selectMainSingers
  );

  byId("mmReactionButtons").addEventListener("click", event => {
    const button = event.target.closest("[data-reaction]");
    if (button) sendReaction(button.dataset.reaction);
  });

  byId("mmSendCommentBtn").addEventListener(
    "click",
    sendLiveComment
  );

  byId("mmCommentInput").addEventListener("keydown", event => {
    if (event.key === "Enter") sendLiveComment();
  });

  if (IS_HOST_CONTROL_PAGE && byId("mmAudioEffects")) {
    byId("mmEcho").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmEchoValue").textContent = value + "%";
      audioEffects?.setEcho(value);
          });

    byId("mmDelay").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmDelayValue").textContent = value + " ms";
      audioEffects?.setDelayTime(value);
    });

    byId("mmFeedback").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmFeedbackValue").textContent = value + "%";
      audioEffects?.setFeedback(value);
    });

    byId("mmReverb").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmReverbValue").textContent = value + "%";
      audioEffects?.setReverb(value);
    });

    byId("mmMix").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmMixValue").textContent = value + "%";
      audioEffects?.setMix(value);
    });

    byId("mmVolume").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmVolumeValue").textContent = value + "%";
      audioEffects?.setVolume(value);
    });

    byId("mmMonitor").addEventListener("change", event => {
      audioEffects?.setMonitor(event.target.checked);
    });

    byId("mmMonitorVolume").addEventListener("input", event => {
      const value = Number(event.target.value);
      byId("mmMonitorValue").textContent = value + "%";
      audioEffects?.setMonitorVolume(value);
    });
  }
}


/* =========================================
   AUTHENTICATION
========================================= */

function waitForAuth() {
  return new Promise((resolve, reject) => {
    if (auth.currentUser) {
      currentUser = auth.currentUser;
      resolve(currentUser);
      return;
    }

    let unsubscribe;

    const timeout = setTimeout(() => {
      if (!currentUser) {
        unsubscribe?.();
        reject(new Error("Please sign in before entering the auditorium."));
      }
    }, 20000);

    unsubscribe = onAuthStateChanged(auth, user => {
      if (user) {
        currentUser = user;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(user);
      }
    });
  });
}


/* =========================================
   LOAD SHOW
========================================= */

async function loadShow() {
  if (!showId) {
    throw new Error("Show ID is missing from the page URL.");
  }

  const snapshot = await get(ref(db, "shows/" + showId));

  if (!snapshot.exists()) {
    throw new Error("This auditorium show does not exist.");
  }

  currentShow = snapshot.val();

  const status = safeText(currentShow.status).toLowerCase();

  if (!["published", "live"].includes(status)) {
    throw new Error("This show is not currently available.");
  }

  return currentShow;
}


/* =========================================
   VERIFY HOST
========================================= */

async function verifyHost() {
  if (!currentUser || !currentShow) return false;

  if (safeText(currentShow.hostUid) !== currentUser.uid) {
    return false;
  }

  const snapshot = await get(
    ref(db, "hostApplications/" + currentUser.uid)
  );

  if (!snapshot.exists()) return false;

  const host = snapshot.val();

  if (safeText(host.status).toLowerCase() !== "approved") {
    return false;
  }

  const now = Date.now();
  const start = Number(host.subscriptionStartAt || 0);
  const end = Number(host.subscriptionEndAt || 0);

  return start > 0 && end > now && start <= now;
}
/* =========================================
   CLOUDFLARE WORKER REQUEST
========================================= */

async function workerRequest(data) {
  if (!currentUser) {
    throw new Error("Please sign in before entering the auditorium.");
  }

  const idToken = await currentUser.getIdToken(true);

  const response = await fetch(TOKEN_SERVER, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + idToken
    },
    body: JSON.stringify({
      ...data,
      showId
    })
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error("The token server returned an invalid response.");
  }

  if (!response.ok || result.error) {
    throw new Error(
      result.error ||
      result.message ||
      "Auditorium access was denied."
    );
  }

  if (
    ["joinHost", "joinSinger", "joinAudience"].includes(data.action)
  ) {
    if (!result.token || !result.url) {
      throw new Error("The token server did not return a LiveKit token.");
    }
  }

  return result;
}


/* =========================================
   GET ACCESS TOKEN
========================================= */

async function getAccessToken() {
  if (isHost) {
    return workerRequest({
      action: "joinHost",
      name: currentUser.displayName || "Host"
    });
  }

  if (requestedMode === "singer") {
    if (!registrationId) {
      throw new Error("Singer registration ID is missing.");
    }

    return workerRequest({
      action: "joinSinger",
      registrationId,
      name: currentUser.displayName || "Singer"
    });
  }

  return workerRequest({
    action: "joinAudience",
    name: currentUser.displayName || "Audience"
  });
}


/* =========================================
   REACTIONS
========================================= */

function updateReactionButtons() {
  document.querySelectorAll(
    "#mmReactionButtons [data-reaction]"
  ).forEach(button => {
    button.disabled = !isJoined || !room;
  });

  const hint = byId("mmReactionHint");

  if (hint) {
    hint.textContent = isJoined
      ? "You are connected. Reactions are visible to everyone."
      : "Enter the auditorium to send and receive reactions.";
  }
}

function showReaction(emoji, senderName) {
  if (!ALLOWED_REACTIONS.includes(emoji)) return;

  const overlay = byId("mmReactionOverlay");
  if (!overlay) return;

  const empty = overlay.querySelector(".mm-note");
  if (empty) empty.remove();

  const item = document.createElement("span");
  item.className = "mm-reaction-item";

  const emojiSpan = document.createElement("span");
  emojiSpan.className = "mm-reaction-emoji";
  emojiSpan.textContent = emoji;

  const nameSpan = document.createElement("span");
  nameSpan.textContent =
    safeText(senderName || "Participant").slice(0, 60);

  item.append(emojiSpan, nameSpan);
  overlay.appendChild(item);

  while (overlay.children.length > 18) {
    overlay.firstElementChild.remove();
  }

  setTimeout(() => {
    if (item.isConnected) item.remove();

    if (!overlay.children.length) {
      const message = document.createElement("span");
      message.className = "mm-note";
      message.textContent = "Live reactions will appear here.";
      overlay.appendChild(message);
    }
  }, 12000);
}

function canSendReactionNow() {
  const now = Date.now();

  lastReactionTimes = lastReactionTimes.filter(
    time => now - time < 3000
  );

  if (lastReactionTimes.length >= 5) {
    showMessage("Please wait before sending more reactions.", "warning");
    return false;
  }

  lastReactionTimes.push(now);
  return true;
}

async function sendReaction(emoji) {
  if (!room || !isJoined) {
    showMessage("Enter the auditorium before sending a reaction.", "warning");
    return;
  }

  if (!ALLOWED_REACTIONS.includes(emoji)) return;
  if (!canSendReactionNow()) return;

  try {
    const message = {
      version: 1,
      type: "reaction",
      emoji,
      senderName: safeText(
        room.localParticipant.name ||
        currentUser?.displayName ||
        currentRole ||
        "Participant"
      ).slice(0, 60),
      sentAt: Date.now()
    };

    const bytes = new TextEncoder().encode(JSON.stringify(message));

    await room.localParticipant.publishData(bytes, {
      reliable: true,
            topic: REACTION_TOPIC
    });

    showReaction(emoji, "You");

  } catch (error) {
    console.error("Reaction error:", error);
    showMessage("Could not send reaction.", "error");
  }
}

function receiveReaction(payload, participant, kind, topic) {
  try {
    if (!payload || payload.byteLength > 1024) return;
    if (topic && topic !== REACTION_TOPIC) return;

    const message = JSON.parse(
      new TextDecoder().decode(payload)
    );

    if (
      !message ||
      message.version !== 1 ||
      message.type !== "reaction" ||
      !ALLOWED_REACTIONS.includes(message.emoji)
    ) return;

    showReaction(
      message.emoji,
      participant?.name ||
      participant?.identity ||
      message.senderName ||
      "Participant"
    );

  } catch (error) {
    console.warn("Invalid reaction ignored:", error);
  }
}


/* =========================================
   LIVE COMMENTS
========================================= */

function listenToLiveComments() {
  if (!showId) return;

  const commentsRef = ref(db, "liveComments/" + showId);

  if (commentsListener) {
    off(commentsRef, "value", commentsListener);
  }

  commentsListener = snapshot => {
    const data = snapshot.val() || {};

    liveComments = Object.entries(data)
      .map(([id, item]) => ({ id, ...item }))
      .filter(item =>
        item &&
        typeof item.message === "string" &&
        typeof item.name === "string"
      )
      .sort((a, b) =>
        Number(a.createdAt || 0) - Number(b.createdAt || 0)
      )
      .slice(-80);

    renderLiveComments();
  };

  onValue(commentsRef, commentsListener);
}

function renderLiveComments() {
  const container = byId("mmCommentsList");
  if (!container) return;

  container.innerHTML = "";

  if (!liveComments.length) {
    const empty = document.createElement("span");
    empty.className = "mm-note";
    empty.textContent = "Be the first to comment.";
    container.appendChild(empty);
    return;
  }

  liveComments.forEach(comment => {
    const item = document.createElement("div");
    item.className = "mm-comment";

    const name = document.createElement("strong");
    name.textContent = safeText(comment.name).slice(0, 60);

    const message = document.createElement("div");
    message.textContent = safeText(comment.message).slice(0, 300);

    const time = document.createElement("div");
    time.className = "mm-comment-time";

    const date = new Date(Number(comment.createdAt || 0));
    time.textContent = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleTimeString();

    item.append(name, message, time);
    container.appendChild(item);
  });

  container.scrollTop = container.scrollHeight;
}

async function sendLiveComment() {
  const input = byId("mmCommentInput");
  const button = byId("mmSendCommentBtn");

  if (!currentUser || !isJoined || !room) {
    showMessage("Enter the auditorium before commenting.", "warning");
        return;
  }

  const message = safeText(input?.value).trim();

  if (!message) {
    showMessage("Please type a comment first.", "warning");
    return;
  }

  if (message.length > 300) {
    showMessage("Comments must be 300 characters or fewer.", "warning");
    return;
  }

  button.disabled = true;

  try {
    const commentsRef = ref(db, "liveComments/" + showId);

    await push(commentsRef, {
      uid: currentUser.uid,
      name: displayName(),
      message,
      createdAt: Date.now()
    });

    input.value = "";
    showMessage("Comment sent.", "success");

  } catch (error) {
    console.error("Comment error:", error);

    showMessage(
      "Could not post comment. Check that the liveComments Firebase rules have been published.",
      "error"
    );

  } finally {
    button.disabled = !isJoined;
  }
}

function updateCommentControls() {
  const button = byId("mmSendCommentBtn");
  const hint = byId("mmCommentHint");

  if (button) button.disabled = !isJoined || !currentUser;

  if (hint) {
    hint.textContent = isJoined
      ? "Your comment is visible to everyone in this show."
      : "Enter the auditorium to post a comment.";
  }
}


/* =========================================
   LIVE QUEUE AND CURRENT PERFORMER
========================================= */

function listenToQueue() {
  if (!showId) return;

  const queueRef = ref(db, "performanceQueue/" + showId);

  if (queueListener) {
    off(queueRef, "value", queueListener);
  }

  queueListener = snapshot => {
    const data = snapshot.val() || {};

    liveQueue = Object.entries(data)
      .map(([id, item]) => ({ id, ...item }))
      .filter(item => item && typeof item === "object")
      .sort((a, b) =>
        Number(a.createdAt || 0) - Number(b.createdAt || 0)
      );

    renderQueue();
  };

  onValue(queueRef, queueListener);
}

function listenToCurrentPerformance() {
  if (!showId) return;

  const performanceRef = ref(db, "livePerformance/" + showId);

  onValue(performanceRef, snapshot => {
    const data = snapshot.val() || {};
    const container = byId("mmCurrentPerformer");

    if (!container) return;

    const name =
      data.currentPerformerName ||
      data.singerName ||
      "";

    const song =
      data.currentSongName ||
      "";

    const movie =
      data.currentMovieName ||
      "";

    const status =
      data.performanceStatus ||
      data.status ||
      "";

    if (!name && !song && !movie) {
      container.textContent =
        "Waiting for the host to start a performance.";
      return;
    }
        }

    container.innerHTML = "";

    const title = document.createElement("strong");
    title.textContent = name || "Performer";

    const details = document.createElement("div");
    details.textContent =
      [song, movie].filter(Boolean).join(" • ") ||
      "Performance details not added";

    const state = document.createElement("div");
    state.className = "mm-note";
    state.textContent = status ? "Status: " + status : "";

    container.append(title, details, state);
  });
}

function renderQueue() {
  const container = byId("mmQueueList");
  if (!container) return;

  container.innerHTML = "";

  const waiting = liveQueue.filter(item => {
    const status = safeText(item.status).toLowerCase();
    return ["queued", "approved", "playing"].includes(status);
  });

  if (!waiting.length) {
    const empty = document.createElement("span");
    empty.className = "mm-note";
    empty.textContent = "No performers are currently waiting in the queue.";
    container.appendChild(empty);
    return;
  }

  waiting.forEach((item, index) => {
    const status = safeText(item.status).toLowerCase();

    const row = document.createElement("div");
    row.className =
      "mm-queue-item" + (status === "playing" ? " current" : "");

    const name = document.createElement("strong");
    name.textContent =
      (index + 1) + ". " +
      safeText(item.name || item.singerName || "Performer");

    const details = document.createElement("div");
    details.className = "mm-note";

    details.textContent = [
      item.songName || item.song || "",
      item.language || "",
      status.toUpperCase()
    ].filter(Boolean).join(" • ");

    row.append(name, details);
    container.appendChild(row);
  });
}


/* =========================================
   AUDIENCE COUNT
========================================= */

function updateAudienceCount() {
  const countElement = byId("mmAudienceCount");
  if (!countElement) return;

  let count = 0;

  if (room && isJoined) {
    count = 1 + room.remoteParticipants.size;
  }

  countElement.textContent = String(count);
}


/* =========================================
   YOUTUBE KARAOKE PLAYER
========================================= */

function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === "function") {
        try {
          previousCallback();
        } catch (error) {}
      }

      resolve(window.YT);
    };

    let script = document.querySelector(
      'script[src="https://www.youtube.com/iframe_api"]'
    );

    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }

    setTimeout(() => {
      if (!(window.YT && window.YT.Player)) {
                reject(new Error("YouTube player could not be loaded."));
      }
    }, 20000);
  });

  return youtubeApiPromise;
}


/* =========================================
   EXTRACT YOUTUBE VIDEO ID
========================================= */

function extractYouTubeId(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);

    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "").split("/")[0];
    }

    if (parsed.hostname.includes("youtube.com")) {
      if (parsed.searchParams.get("v")) {
        return parsed.searchParams.get("v");
      }

      const parts = parsed.pathname.split("/").filter(Boolean);

      if (
        parts[0] === "embed" ||
        parts[0] === "shorts" ||
        parts[0] === "live"
      ) {
        return parts[1] || "";
      }
    }

  } catch (error) {
    console.warn("Invalid YouTube URL:", error);
  }

  return "";
}


/* =========================================
   CREATE YOUTUBE PLAYER
========================================= */

async function createYouTubePlayer(videoId) {
  if (!videoId) return;

  await loadYouTubeAPI();

  const container = byId("mmYoutubePlayer");
  if (!container) return;

  if (youtubePlayer) {
    try {
      youtubePlayer.destroy();
    } catch (error) {}

    youtubePlayer = null;
  }

  container.innerHTML = '<div id="mmYoutubeFrame"></div>';

  youtubePlayer = new window.YT.Player("mmYoutubeFrame", {
    videoId,
    playerVars: {
      autoplay: 0,
      controls: 1,
      playsinline: 1,
      rel: 0,
      modestbranding: 1
    },
    events: {
      onReady: () => {
        lastYoutubeVideoId = videoId;
        updatePlaybackStatus("Karaoke video loaded.");
      },
      onStateChange: event => {
        if (event.data === window.YT.PlayerState.PLAYING) {
          updatePlaybackStatus("Karaoke is playing.");
        } else if (event.data === window.YT.PlayerState.PAUSED) {
          updatePlaybackStatus("Karaoke is paused.");
        } else if (event.data === window.YT.PlayerState.ENDED) {
          updatePlaybackStatus("Karaoke video ended.");
        }
      },
      onError: event => {
        console.error("YouTube player error:", event.data);
        updatePlaybackStatus(
          "YouTube could not play this video. Try another karaoke link."
        );
      }
    }
  });
}


/* =========================================
   PLAYBACK STATUS
========================================= */

function updatePlaybackStatus(message) {
  const status = byId("mmPlaybackStatus");
  if (status) status.textContent = message;
}
