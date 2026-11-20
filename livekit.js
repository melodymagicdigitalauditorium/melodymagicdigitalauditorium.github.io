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

// All live features stay inside the existing host-performance-control auditorium.
const IS_HOST_CONTROL_PAGE =
  location.pathname.toLowerCase().endsWith("host-performance-control.html");

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
let singerAutoJoinTimer = null;
let singerAutoJoinStarted = false;

let lastReactionTimes = [];

let audioEffects = null;
let programmeMixer = null;
let publishedProgrammeTrack = null;
let programmeMixerStarting = false;
const programmeRemoteInputs = new Map();
let rawMicrophoneTrack = null;
let processedMicrophoneTrack = null;
let publishedMicrophoneTrack = null;
let sharedAudioSettings = {
  echo: 0,
  delay: 280,
  feedback: 25,
  reverb: 0,
  mix: 0,
  volume: 80
};
let audioSettingsListener = null;
let audioSettingsSaveTimer = null;

let youtubePlayer = null;
let youtubePlayerReadyPromise = null;
let youtubeApiPromise = null;
let lastYoutubeVideoId = "";
let lastPlaybackSignature = "";
let playbackSyncTimer = null;
let sharedKaraokeTracks = [];
let sharedKaraokeStarting = false;
let sharedKaraokeStopping = false;

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
   DESKTOP HOST PROGRAMME MIXER
   Captures the host's Chrome tab audio and mixes it
   with the host microphone and active singer tracks.
========================================= */

class ProfessionalProgrammeMixer {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.context = null;
    this.destination = null;
    this.master = null;
    this.inputs = new Map();
    this.captureStream = null;
    this.hostMicStream = null;
    this.outputTrack = null;
    this.monitorGain = null;
    this.delaySend = null;
    this.delay = null;
    this.delayFeedback = null;
    this.echoWet = null;
    this.reverbSend = null;
    this.reverb = null;
    this.reverbWet = null;
  }

  async initialize() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not supported in this browser.");
    this.context = new AudioContextClass();
    if (this.context.state === "suspended") await this.context.resume();
    this.destination = this.context.createMediaStreamDestination();
    this.master = this.context.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.destination);
    this.monitorGain = this.context.createGain();
    this.monitorGain.gain.value = 0;
    this.master.connect(this.monitorGain);
    this.monitorGain.connect(this.context.destination);

    // Shared programme-bus echo and reverb sends. Each channel feeds the
    // dry master plus these effects, so the audience receives one mixed track.
    this.delaySend = this.context.createGain();
    this.delaySend.gain.value = 0;
    this.delay = this.context.createDelay(1.5);
    this.delay.delayTime.value = 0.28;
    this.delayFeedback = this.context.createGain();
    this.delayFeedback.gain.value = 0.22;
    this.echoWet = this.context.createGain();
    this.echoWet.gain.value = 0;
    this.delaySend.connect(this.delay);
    this.delay.connect(this.echoWet);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.echoWet.connect(this.master);

    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 0;
    this.reverb = this.context.createConvolver();
    const impulseLength = Math.floor(this.context.sampleRate * 1.7);
    const impulse = this.context.createBuffer(2, impulseLength, this.context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < impulseLength; i++) {
        const decay = Math.pow(1 - i / impulseLength, 2.8);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    this.reverb.buffer = impulse;
    this.reverbWet = this.context.createGain();
    this.reverbWet.gain.value = 0;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbWet);
    this.reverbWet.connect(this.master);

    this.outputTrack = this.destination.stream.getAudioTracks()[0];
    if (!this.outputTrack) throw new Error("The mixer could not create an output audio track.");
  }

  addInput(key, track, initialVolume = 1) {
    if (!this.context || !track || track.kind !== "audio" || track.readyState === "ended") return false;
    this.removeInput(key);
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    const alignmentDelay = this.context.createDelay(2.5);
    alignmentDelay.delayTime.value = 0;
    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(2, Number(initialVolume)));
    source.connect(alignmentDelay);
    alignmentDelay.connect(gain);
    gain.connect(this.master);
    gain.connect(this.delaySend);
    gain.connect(this.reverbSend);
    this.inputs.set(key, { source, alignmentDelay, gain, track });
    return true;
  }

  removeInput(key) {
    const input = this.inputs.get(key);
    if (!input) return;
    try { input.source.disconnect(); } catch (error) {}
    try { input.alignmentDelay?.disconnect(); } catch (error) {}
    try { input.gain.disconnect(); } catch (error) {}
    this.inputs.delete(key);
  }

  setVolume(key, value) {
    const input = this.inputs.get(key);
    if (input && this.context) {
      input.gain.gain.setTargetAtTime(
        Math.max(0, Math.min(2, Number(value) / 100)),
        this.context.currentTime,
        0.025
      );
    }
  }

  setInputDelay(key, milliseconds) {
    const input = this.inputs.get(key);
    if (input?.alignmentDelay && this.context) {
      const seconds = Math.max(0, Math.min(2.5, Number(milliseconds) / 1000));
      input.alignmentDelay.delayTime.setTargetAtTime(seconds, this.context.currentTime, 0.04);
    }
  }

  setMasterVolume(value) {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        Math.max(0, Math.min(1.5, Number(value) / 100)),
        this.context.currentTime,
        0.025
      );
    }
  }

  async captureCurrentTab(capturePromise) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("This browser does not support tab-audio capture. Use desktop Chrome.");
    }
    this.captureStream = await capturePromise;
    const tabAudio = this.captureStream.getAudioTracks()[0];
    this.captureStream.getVideoTracks().forEach(track => track.stop());
    if (!tabAudio) {
      this.captureStream.getTracks().forEach(track => track.stop());
      this.captureStream = null;
      throw new Error("Chrome did not provide tab audio. Select the Melody Magic tab and enable Share tab audio.");
    }
    this.addInput("youtube", tabAudio, 1);
    tabAudio.addEventListener("ended", () => {
      this.onStatus("Tab audio capture ended. Stopping the programme mixer.");
      stopProfessionalProgrammeMixer().catch(error => console.warn("Mixer auto-stop:", error));
    }, { once: true });
  }

  async captureHostMicrophone() {
    this.hostMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    const mic = this.hostMicStream.getAudioTracks()[0];
    if (!mic) throw new Error("No host microphone was found.");
    this.addInput("host-mic", mic, 0.8);
  }

  setEcho(value) {
    if (!this.delaySend || !this.echoWet || !this.context) return;
    const amount = Math.max(0, Math.min(100, Number(value))) / 100;
    this.delaySend.gain.setTargetAtTime(amount * 0.65, this.context.currentTime, 0.04);
    this.echoWet.gain.setTargetAtTime(amount * 0.8, this.context.currentTime, 0.04);
  }

  setDelayTime(value) {
    if (!this.delay || !this.context) return;
    const seconds = Math.max(0.05, Math.min(1.2, Number(value) / 1000));
    this.delay.delayTime.setTargetAtTime(seconds, this.context.currentTime, 0.04);
  }

  setEchoFeedback(value) {
    if (!this.delayFeedback || !this.context) return;
    const amount = Math.max(0, Math.min(85, Number(value))) / 100;
    this.delayFeedback.gain.setTargetAtTime(amount, this.context.currentTime, 0.04);
  }

  setReverb(value) {
    if (!this.reverbSend || !this.reverbWet || !this.context) return;
    const amount = Math.max(0, Math.min(100, Number(value))) / 100;
    this.reverbSend.gain.setTargetAtTime(amount * 0.45, this.context.currentTime, 0.04);
    this.reverbWet.gain.setTargetAtTime(amount * 0.75, this.context.currentTime, 0.04);
  }

  setMonitoring(enabled, volume = 25) {
    if (!this.monitorGain || !this.context) return;
    this.monitorGain.gain.setTargetAtTime(
      enabled ? Math.max(0, Math.min(0.5, Number(volume) / 100)) : 0,
      this.context.currentTime,
      0.03
    );
  }

  async stop() {
    for (const key of [...this.inputs.keys()]) this.removeInput(key);
    this.captureStream?.getTracks().forEach(track => { try { track.stop(); } catch (error) {} });
    this.hostMicStream?.getTracks().forEach(track => { try { track.stop(); } catch (error) {} });
    if (this.outputTrack) {
      try { this.outputTrack.stop(); } catch (error) {}
    }
    if (this.context && this.context.state !== "closed") {
      try { await this.context.close(); } catch (error) {}
    }
    this.captureStream = null;
    this.hostMicStream = null;
    this.outputTrack = null;
    this.context = null;
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

function setSingerVisibleStatus(statusText, detailText) {
  if (requestedMode !== "singer") return;
  const status = byId("singerConnectionStatus");
  const detail = byId("singerStatusText");
  if (status) status.textContent = statusText;
  if (detail && detailText) detail.textContent = detailText;
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
  if (requestedMode === "singer") {
    const singerOnlyStyle = document.createElement("style");
    singerOnlyStyle.textContent = "#mmLiveKitPanel{display:none!important}";
    document.head.appendChild(singerOnlyStyle);
  }
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

      /* Main-stage singer is prominent; waiting singers stay compact. */
      #mmLiveKitPanel .mm-video-box.mm-main-stage {
        grid-column:1 / -1;
        border-color:#d7ad4c;
        box-shadow:0 0 0 1px rgba(215,173,76,.25);
      }
      #mmLiveKitPanel .mm-video-box.mm-main-stage video {
        min-height:300px;
        max-height:68vh;
        object-fit:contain;
      }
      #mmLiveKitPanel .mm-video-box.mm-waiting-stage {
        min-height:110px;
      }
      #mmLiveKitPanel .mm-video-box.mm-waiting-stage video {
        min-height:100px;
        max-height:170px;
      }
      @media(max-width:600px) {
        #mmLiveKitPanel .mm-video-box.mm-main-stage video {
          min-height:210px;
          max-height:48vh;
        }
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
      <h3>🎚️ Auditorium Master Singer Audio Mixer</h3>
      <div class="mm-note">
        Host-only master controls. These settings are applied to every singer's
        microphone before it is published to the auditorium. Changes are shared live.
        Use headphones when monitoring your own microphone.
      </div>

      <div class="mm-effect-control">
        <label>Master Echo: <strong id="mmEchoValue">0%</strong></label>
        <input id="mmEcho" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Master Delay Time: <strong id="mmDelayValue">280 ms</strong></label>
        <input id="mmDelay" type="range" min="50" max="1000" value="280">
      </div>

      <div class="mm-effect-control">
        <label>Master Echo Feedback: <strong id="mmFeedbackValue">25%</strong></label>
        <input id="mmFeedback" type="range" min="0" max="85" value="25">
      </div>

      <div class="mm-effect-control">
        <label>Master Reverb: <strong id="mmReverbValue">0%</strong></label>
        <input id="mmReverb" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Master Wet / Dry Mix: <strong id="mmMixValue">0%</strong></label>
        <input id="mmMix" type="range" min="0" max="100" value="0">
      </div>

      <div class="mm-effect-control">
        <label>Singer Microphone Master Volume: <strong id="mmVolumeValue">80%</strong></label>
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

      <div class="mm-section" id="mmProgrammeMixer" hidden style="border:1px solid #b58b2c;border-radius:10px;padding:14px;margin-top:14px">
        <h3>🎚️ Professional YouTube + Microphone Mixer</h3>
        <p class="mm-note">Desktop Chrome only. Select this host-control tab in Chrome's share picker and turn on “Share tab audio”. YouTube ads, if shown, are included in the captured audio. Use headphones to prevent feedback.</p>
        <button type="button" id="mmStartProgrammeMixer">▶ START PROFESSIONAL MIXER</button>
        <button type="button" id="mmStopProgrammeMixer" disabled>■ STOP MIXER</button>
        <div id="mmProgrammeMixerStatus" class="mm-note">Mixer is OFF. Join the auditorium before starting.</div>
        <label>YouTube tab audio: <strong id="mmYoutubeMixValue">100%</strong></label>
        <input id="mmYoutubeMix" type="range" min="0" max="150" value="100">
        <div class="mm-effect-control">
          <label>Karaoke audio alignment (delay YouTube): <strong id="mmProgrammeSyncDelayValue">0 ms</strong></label>
          <input id="mmProgrammeSyncDelay" type="range" min="0" max="1500" step="10" value="0">
          <p class="mm-note">Increase this if the singer's incoming voice is late. This delays karaoke audio only; it does not delay the video.</p>
        </div>
        <label>Host microphone: <strong id="mmHostMicMixValue">80%</strong></label>
        <input id="mmHostMicMix" type="range" min="0" max="150" value="80">
        <label>Singer microphones: <strong id="mmSingerMixValue">100%</strong></label>
        <input id="mmSingerMix" type="range" min="0" max="150" value="100">
        <label>Programme master: <strong id="mmProgrammeMasterValue">90%</strong></label>
        <input id="mmProgrammeMaster" type="range" min="0" max="150" value="90">
        <div class="mm-effect-control">
          <label>Programme echo: <strong id="mmProgrammeEchoValue">0%</strong></label>
          <input id="mmProgrammeEcho" type="range" min="0" max="100" value="0">
        </div>
        <div class="mm-effect-control">
          <label>Echo delay: <strong id="mmProgrammeDelayValue">280 ms</strong></label>
          <input id="mmProgrammeDelay" type="range" min="50" max="1200" value="280">
        </div>
        <div class="mm-effect-control">
          <label>Echo feedback: <strong id="mmProgrammeFeedbackValue">22%</strong></label>
          <input id="mmProgrammeFeedback" type="range" min="0" max="85" value="22">
        </div>
        <div class="mm-effect-control">
          <label>Programme reverb: <strong id="mmProgrammeReverbValue">0%</strong></label>
          <input id="mmProgrammeReverb" type="range" min="0" max="100" value="0">
        </div>
        <label><input type="checkbox" id="mmProgrammeMonitor"> Monitor mixed programme audio (headphones only)</label>
        <p class="mm-note">Audience members receive the programme mix instead of separate singer microphone playback.</p>
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

    <!-- Karaoke player is rendered once by the host page's dedicated Karaoke Performance section. -->

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
      <h3>🎥 Host Camera</h3>
      <div id="mmHostVideoGrid" class="mm-video-grid"></div>
    </div>

    <div class="mm-section">
      <h2 id="mmPerformersHeading">🎤 SHOW NAME — PERFORMERS</h2>
      <div id="mmVideoGrid" class="mm-video-grid"></div>
      <div class="mm-note">All connected singers' cameras appear together in this performers gallery.</div>
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

  byId("mmStartProgrammeMixer")?.addEventListener("click", startProfessionalProgrammeMixer);
  byId("mmStopProgrammeMixer")?.addEventListener("click", stopProfessionalProgrammeMixer);
  ["mmYoutubeMix","mmHostMicMix","mmSingerMix","mmProgrammeMaster"].forEach(id => {
    byId(id)?.addEventListener("input", updateProfessionalMixerVolumes);
  });
  byId("mmProgrammeSyncDelay")?.addEventListener("input", updateProfessionalMixerVolumes);
  byId("mmProgrammeMonitor")?.addEventListener("change", event => {
    programmeMixer?.setMonitoring(event.target.checked, 20);
  });
  [
    ["mmProgrammeEcho","mmProgrammeEchoValue",value => programmeMixer?.setEcho(value),"%"],
    ["mmProgrammeDelay","mmProgrammeDelayValue",value => programmeMixer?.setDelayTime(value), " ms"],
    ["mmProgrammeFeedback","mmProgrammeFeedbackValue",value => programmeMixer?.setEchoFeedback(value),"%"],
    ["mmProgrammeReverb","mmProgrammeReverbValue",value => programmeMixer?.setReverb(value),"%"]
  ].forEach(([inputId,labelId,apply,suffix]) => {
    byId(inputId)?.addEventListener("input", event => {
      const value = Number(event.target.value);
      const label = byId(labelId);
      if (label) label.textContent = value + suffix;
      apply(value);
    });
  });

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
    ["mmEcho", "mmDelay", "mmFeedback", "mmReverb", "mmMix", "mmVolume"].forEach(id => {
      byId(id).addEventListener("input", () => {
        updateAudioControlLabels();
        applySharedAudioSettingsToEffects();
        scheduleSharedAudioSettingsSave();
      });
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

  const showTitle =
    currentShow.showName ||
    currentShow.title ||
    currentShow.name ||
    "SHOW NAME";

  const performersHeading = byId("mmPerformersHeading");
  if (performersHeading) {
    performersHeading.textContent = "🎤 " + showTitle + " — PERFORMERS";
  }

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
  // A singer link must always request singer access first.
  // Host-account detection must not override an explicit singer entry.
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

  if (isHost) {
    return workerRequest({
      action: "joinHost",
      name: currentUser.displayName || "Host"
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
    const name = data.currentPerformerName || data.singerName || "";
    const song = data.currentSongName || "";
    const movie = data.currentMovieName || "";
    const status = data.performanceStatus || data.status || "";
    if (!name && !song && !movie) {
      container.textContent = "Waiting for the host to start a performance.";
      return;
    }
    container.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = name || "Performer";
    const details = document.createElement("div");
    details.textContent = [song, movie].filter(Boolean).join(" • ") || "Performance details not added";
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

async function createYouTubePlayer(initialVideoId = "") {
  const container = byId("mmYoutubePlayer");
  if (!container) return null;

  if (youtubePlayerReadyPromise) return youtubePlayerReadyPromise;

  youtubePlayerReadyPromise = (async () => {
    await loadYouTubeAPI();

    // Do not create an empty YouTube iframe. Start with the actual video
    // received from Firebase so the singer never gets a blank player shell.
    container.style.minHeight = "240px";
    container.innerHTML = '<div id="mmYoutubeFrame"></div>';

    const playerWidth = Math.max(320, container.clientWidth || 640);
    const playerHeight = Math.max(240, Math.round(playerWidth * 9 / 16));

    return await new Promise((resolve, reject) => {
      let settled = false;

      try {
        youtubePlayer = new window.YT.Player("mmYoutubeFrame", {
          width: playerWidth,
          height: playerHeight,
          videoId: initialVideoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            enablejsapi: 1,
            origin: location.origin
          },
          events: {
            onReady: event => {
              if (settled) return;
              settled = true;
              const iframe = container.querySelector("iframe");
              if (iframe) {
                iframe.style.width = "100%";
                iframe.style.height = "100%";
                iframe.style.minHeight = "240px";
                iframe.style.display = "block";
              }
              const status = byId("mmPlaybackStatus");
              if (status) status.textContent =
                "Karaoke screen connected. Syncing the host's video...";
              resolve(event.target);
            },
            onError: event => {
              console.warn("YouTube player error:", event.data);
              const messages = {
                2: "The host's YouTube video ID is invalid.",
                5: "This YouTube video cannot play in the HTML5 player.",
                100: "The host's YouTube video was removed or is private.",
                101: "This YouTube video owner does not allow embedding.",
                150: "This YouTube video owner does not allow embedding."
              };
              const message = messages[event.data] ||
                ("YouTube player error (" + event.data + ").");
              const status = byId("mmPlaybackStatus");
              if (status) status.textContent = message;
              if (!settled) {
                settled = true;
                reject(new Error(message));
              }
            },
            onAutoplayBlocked: () => {
              const status = byId("mmPlaybackStatus");
              if (status) status.textContent =
                "Your browser blocked automatic playback. Tap the video once, then ask the host to press PLAY FOR EVERYONE again.";
            }
          }
        });
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  })().catch(error => {
    youtubePlayerReadyPromise = null;
    youtubePlayer = null;
    console.error("YouTube setup error:", error);
    container.innerHTML =
      '<p style="padding:16px;color:#ddd">Unable to load the YouTube player. Refresh the page and try again.</p>';
    throw error;
  });

  return youtubePlayerReadyPromise;
}

function playbackPosition(data) {
  const base = Number(data.basePosition || 0);

  if (safeText(data.state).toLowerCase() !== "playing") {
    return Math.max(0, base);
  }

  const startedAt = Number(data.startedAt || 0);

  if (!startedAt) return Math.max(0, base);

  return Math.max(0, base + (Date.now() - startedAt) / 1000);
}

async function applyPlayback(data) {
  const statusElement = byId("mmPlaybackStatus");
  if (!data) data = {};

  // Singer and audience devices no longer create separate YouTube embeds.
  // They receive one cropped host video track and one matching tab-audio track.
  if (!IS_HOST_CONTROL_PAGE) {
    if (statusElement) {
      statusElement.textContent = "Waiting for the host to share the common karaoke video and audio...";
    }
    return;
  }

  const videoId = safeText(data.videoId).trim();
  const state = safeText(data.state).toLowerCase();

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    if (statusElement) {
      statusElement.textContent =
        "Waiting for the host to select a karaoke video.";
    }
    return;
  }

  try {
    // Wait until the YouTube iframe reports onReady before sending commands.
    const player = await createYouTubePlayer(videoId);
    if (!player) return;

    const sharedVolume = Math.max(0, Math.min(100, Number(
      data.volume === undefined ? 100 : data.volume
    )));

    // The host-control page uses its own YouTube player. Singer/audience
    // pages use this shared, Firebase-synchronised player and must hear it.
    // Each device plays its own YouTube stream, so ads may still differ.
    player.setVolume(sharedVolume);
    if (sharedVolume === 0) player.mute();
    else player.unMute();

    const signature = [
      videoId,
      state,
      data.basePosition || 0,
      data.startedAt || 0,
      data.updatedAt || 0
    ].join("|");

    if (signature === lastPlaybackSignature) return;

    const position = playbackPosition(data);
    const isNewVideo = videoId !== lastYoutubeVideoId;

    if (isNewVideo) lastYoutubeVideoId = videoId;

    // A selected/stopped video must be cued, not loaded (loadVideoById
    // starts playback and can race the player's onReady event).
    if (isNewVideo || state === "stopped" || state === "selected") {
      if (state === "playing") {
        player.loadVideoById({
          videoId,
          startSeconds: position
        });
      } else {
        player.cueVideoById({
          videoId,
          startSeconds: position
        });
      }
    } else if (state === "playing") {
      const currentTime =
        typeof player.getCurrentTime === "function"
          ? player.getCurrentTime()
          : 0;

      if (Math.abs(currentTime - position) > 3) {
        player.seekTo(position, true);
      }
      player.playVideo();
    } else if (state === "paused") {
      player.seekTo(position, true);
      player.pauseVideo();
    }

    lastPlaybackSignature = signature;

    if (statusElement) {
      statusElement.textContent =
        state === "playing"
          ? "Host is playing the karaoke video."
          : state === "paused"
            ? "Karaoke video paused by host."
            : state === "stopped"
              ? "Video selected. Waiting for the host to press PLAY."
              : "Karaoke video selected.";
    }
  } catch (error) {
    console.warn("Playback sync error:", error);
    if (statusElement) {
      statusElement.textContent =
        "Karaoke player could not start: " + error.message;
    }
  }
}

function listenToKaraokePlayback() {
  if (!showId) return;

  const playbackRef = ref(db, "karaokePlayback/" + showId);

  if (playbackListener) {
    off(playbackRef, "value", playbackListener);
  }

  playbackListener = snapshot => {
    const data = snapshot.val() || {};
    if (!data.videoId) {
      const playerBox = byId("mmYoutubePlayer");
      const status = byId("mmPlaybackStatus");
      if (playerBox && !youtubePlayer) {
        playerBox.innerHTML =
          '<div style="height:100%;min-height:240px;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#bbb;background:#050505">Waiting for the host to select a karaoke video...</div>';
      }
      if (status) {
        status.textContent =
          "Waiting for the host to share the common karaoke video and audio.";
      }
      return;
    }
    applyPlayback(data);
  };

  onValue(
    playbackRef,
    playbackListener,
    error => {
      console.error("Karaoke Firebase listener error:", error);
      const status = byId("mmPlaybackStatus");
      if (status) {
        status.textContent =
          "Cannot receive the host's karaoke video: " + error.message;
      }
    }
  );
}
function isShowLive(data = currentShow) {
  return !!data && (
    safeText(data.liveStatus).toLowerCase() === "live" ||
    data.isLive === true
  );
}

function listenToShowLifecycle() {
  if (!showId || requestedMode !== "singer") return;

  const lifecycleRef = ref(db, "shows/" + showId);

  if (showLifecycleListener) {
    off(lifecycleRef, "value", showLifecycleListener);
  }

  showLifecycleListener = snapshot => {
    if (!snapshot.exists()) return;

    currentShow = snapshot.val();

    const liveNow = isShowLive();
    const ended = safeText(currentShow.liveStatus).toLowerCase() === "ended";

    if (liveNow) {
      setSingerVisibleStatus(
        "Show has started!",
        "Connecting you to the live auditorium and adding you to the show queue automatically..."
      );

      showMessage("Show started. Connecting automatically...", "success");

      // No Enter button or singer action is required. The approved singer
      // joins the LiveKit room automatically when the host starts the show.
      if (!isJoined && !joining && !singerAutoJoinStarted) {
        singerAutoJoinStarted = true;
        joinAuditorium();
      }
    } else {
      singerAutoJoinStarted = false;

      setSingerVisibleStatus(
        ended ? "Show ended" : "Waiting for host",
        ended
          ? "This show has ended."
          : "Your registration is confirmed. You will join automatically when the host starts the show."
      );
    }
  };

  onValue(lifecycleRef, showLifecycleListener);
}

/* =========================================
   JOIN AUDITORIUM
========================================= */

async function joinAuditorium() {
  if (joining || isJoined) return;
  if (requestedMode === "singer" && !isShowLive()) {
    showMessage("The host has not started this show yet.");
    setSingerVisibleStatus("Waiting for host", "You will be notified here when the host starts the show.");
    setButtonState("mmJoinBtn", true, "Waiting for host");
    return;
  }
  joining = true;
  setButtonState("mmJoinBtn", true, "Connecting...");
  setSingerVisibleStatus("Connecting...", "Checking singer login, show registration, token server, and LiveKit connection.");

  try {
    await waitForAuth();
    await loadShow();
    isHost = await verifyHost();

    const tokenData = await getAccessToken();
    currentRole = safeText(tokenData.role).toLowerCase();

    if (!["host", "singer", "audience"].includes(currentRole)) {
      throw new Error("Invalid auditorium role returned by server.");
    }
    if (requestedMode === "singer" && currentRole !== "singer") {
      throw new Error("Singer access was not confirmed.");
    }
    if (!isHost && requestedMode !== "singer" && currentRole !== "audience") {
      throw new Error("Audience access was not confirmed.");
    }

    microphoneAllowed = currentRole === "host" && tokenData.microphoneAllowed === true;
    cameraAllowed = currentRole === "host" && tokenData.cameraAllowed === true;
    if (currentRole === "singer") {
      microphoneAllowed = tokenData.microphoneAllowed === true;
      cameraAllowed = tokenData.cameraAllowed === true;
    }
    if (currentRole === "audience") {
      microphoneAllowed = false;
      cameraAllowed = false;
    }

    const performer = currentRole === "host" || currentRole === "singer";
    if (byId("mmMyControls")) byId("mmMyControls").hidden = !performer;
    const hostEffects = currentRole === "host" && isHost && IS_HOST_CONTROL_PAGE;
    if (byId("mmAudioEffects")) byId("mmAudioEffects").hidden = !hostEffects;
    if (byId("mmHostControls")) byId("mmHostControls").hidden = true;

    room = new Room({ adaptiveStream: true, dynacast: true });
    registerRoomEvents();
    await room.connect(tokenData.url || LIVEKIT_URL, tokenData.token);
    isJoined = true;
    updateSharedKaraokeButton();
    listenToSharedAudioSettings();

    setButtonState("mmJoinBtn", true, "Connected");
    setButtonState("mmLeaveBtn", false, "Leave Auditorium");
    if (byId("mmRoleInfo")) {
      byId("mmRoleInfo").textContent = "Connected as: " + currentRole.toUpperCase();
    }
    showMessage("Connected to the live auditorium.", "success");
    setSingerVisibleStatus("LIVE", "You are connected to the auditorium. Camera is starting; microphone will activate when the host assigns your stage and grants permission.");

    updateControlButtons();
    updateReactionButtons();
    updateCommentControls();
    updateAudienceCount();
    await createVideoTile(room.localParticipant, true);
    for (const participant of room.remoteParticipants.values()) {
      await createVideoTile(participant, false);
    }

    if (currentRole === "singer") {
      try {
        await room.localParticipant.setCameraEnabled(true);
        localCameraEnabled = true;
        showMessage("Connected live. Camera is ON. Microphone will turn ON when the host assigns you and grants permission.", "success");
      } catch (cameraError) {
        localCameraEnabled = false;
        showMessage("Connected live, but camera permission needs attention: " + cameraError.message, "warning");
      }
    }

    if (currentRole === "host" && isHost && IS_HOST_CONTROL_PAGE) {
      if (byId("mmHostControls")) byId("mmHostControls").hidden = false;
      if (byId("mmAudioEffects")) byId("mmAudioEffects").hidden = false;
      await loadHostRegistrations();
      listenToParticipantControls();
      listenToStage();
    } else {
      if (byId("mmHostControls")) byId("mmHostControls").hidden = true;
      if (byId("mmAudioEffects")) byId("mmAudioEffects").hidden = true;
      listenToMyPermissions();
      listenToStage();
    }

    listenToLiveComments();
    listenToQueue();
    listenToCurrentPerformance();

    // Karaoke playback listener is started during Firebase initialization,
    // independently of LiveKit connection success.
    updateControlButtons();
    updateAudienceCount();

  } catch (error) {
    console.error("Join error:", error);
    showMessage(error.message || "Unable to enter auditorium.", "error");
    setSingerVisibleStatus("Connection failed", (error.message || "Unable to enter auditorium.") + " Retrying automatically in 8 seconds.");
    if (requestedMode === "singer" && !leaving) {
      const singerStatus = byId("singerConnectionStatus");
      if (singerStatus) singerStatus.textContent = "Retrying automatically";
      if (singerAutoJoinTimer) clearTimeout(singerAutoJoinTimer);
      singerAutoJoinTimer = setTimeout(() => { if (!isJoined && !joining && !leaving) joinAuditorium(); }, 8000);
    }
    if (room) {
      try { await room.disconnect(); } catch (disconnectError) {
        console.warn("Room cleanup error:", disconnectError);
      }
    }
    room = null;
    isJoined = false;
    localMicEnabled = false;
    localCameraEnabled = false;
    updateReactionButtons();
    updateCommentControls();
    updateAudienceCount();
  } finally {
    joining = false;
    setButtonState("mmJoinBtn", isJoined, isJoined ? "Connected" : "Enter Live Auditorium");
    const singerStatus = byId("singerConnectionStatus");
    if (requestedMode === "singer" && singerStatus) singerStatus.textContent = isJoined ? "LIVE" : "Connecting...";
  }
}

/* =========================================
   ROOM EVENTS
========================================= */

function registerRoomEvents() {
  if (!room) return;

  room.on(
    RoomEvent.TrackSubscribed,
    async (track, publication, participant) => {
      const source = publication?.source || track?.source;
      if (source === Track.Source.ScreenShare) {
        attachTrackToTile(track, "mmSharedKaraokeVideo");
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Host is sharing the karaoke video. Waiting for shared audio...";
        return;
      }
      if (source === Track.Source.ScreenShareAudio) {
        attachTrackToTile(track, "mmSharedKaraokeAudio");
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "LIVE — the same karaoke video and audio are being shared with everyone.";
        return;
      }
      await attachRemoteTrack(track, participant);
    }
  );

  room.on(
    RoomEvent.TrackUnsubscribed,
    track => {
      removeRemoteSingerFromProgrammeMixer(track);
      detachTrackElements(track);
    }
  );

  room.on(
    RoomEvent.ParticipantConnected,
    async participant => {
      await createVideoTile(participant, false);
      updateAudienceCount();

      showMessage(
        (participant.name || "A participant") +
        " joined the auditorium."
      );
    }
  );

  room.on(
    RoomEvent.ParticipantDisconnected,
    participant => {
      removeParticipantTile(participant.identity);
      updateAudienceCount();
    }
  );

  room.on(
    RoomEvent.DataReceived,
    (payload, participant, kind, topic) => {
      receiveReaction(payload, participant, kind, topic);
    }
  );

  room.on(RoomEvent.Disconnected, () => {
    if (!leaving) {
      isJoined = false;
      localMicEnabled = false;
      localCameraEnabled = false;

      microphoneAllowed = false;
      cameraAllowed = false;

      stopMicrophoneEffects();
      stopProfessionalProgrammeMixer();
      stopSharedKaraokeCapture("Disconnected from the live auditorium.");

      showMessage("Disconnected from the auditorium.", "warning");

      resetButtons();
      updateReactionButtons();
      updateCommentControls();
      updateAudienceCount();
    }
  });

  room.on(
    RoomEvent.LocalTrackPublished,
    async publication => {
      if (publication.track) {
        await attachLocalTrack(publication.track, publication);
      }
    }
  );

  room.on(
    RoomEvent.LocalTrackUnpublished,
    publication => {
      if (publication.track) {
        detachTrackElements(publication.track);
      }
    }
  );
}


/* =========================================
   VIDEO AND AUDIO TILES
========================================= */

function getTileId(identity) {
  return "mmTile_" +
    safeText(identity).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function createVideoTile(participant, isLocal) {
  const identity = safeText(
    participant.identity || "participant"
  );

  // Never label the local singer as the host, even if the singer
  // is signed in with the same Firebase account used to create the show.
  // On a singer page, only a REMOTE participant matching hostUid is host.
  const isHostParticipant = requestedMode === "singer"
    ? (!isLocal &&
       !!currentShow?.hostUid &&
       identity === safeText(currentShow.hostUid) &&
       identity !== safeText(currentUser?.uid))
    : ((isLocal && currentRole === "host") ||
       (!isLocal &&
        !!currentShow?.hostUid &&
        identity === safeText(currentShow.hostUid)));

  const grid = byId(isHostParticipant ? "mmHostVideoGrid" : "mmVideoGrid");
  if (!grid) return;

  const tileId = getTileId(identity);

  let tile = byId(tileId);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "mm-video-box";
    tile.id = tileId;

    const name = document.createElement("div");
    name.className = "mm-video-name";

    name.textContent = isHostParticipant
      ? "HOST — " + (participant.name || "Host")
      : (isLocal ? "You (" + currentRole + ")" : (participant.name || identity));

    tile.dataset.participantIdentity = identity;
    const media = document.createElement("div");
    media.id = tileId + "_media";

    tile.append(name, media);
    grid.appendChild(tile);
  }

  const isOnMainStage = stageSingerUids.includes(identity);
  tile.classList.toggle("mm-main-stage", isOnMainStage);
  tile.classList.toggle("mm-waiting-stage", !isOnMainStage && !isHostParticipant);
  // A singer waiting in the queue sees their own camera as a small corner preview.
  // Other viewers keep that singer in the compact performers gallery.
  tile.classList.toggle(
    "mm-local-singer-preview",
    isLocal && currentRole === "singer" && !isOnMainStage
  );

  if (participant.trackPublications) {
    participant.trackPublications.forEach(publication => {
      if (
        publication.track &&
        publication.source !== Track.Source.ScreenShare &&
        publication.source !== Track.Source.ScreenShareAudio
      ) {
        attachTrackToTile(
          publication.track,
          tileId + "_media"
        );
      }
    });
  }
}

async function attachRemoteTrack(track, participant) {
  await createVideoTile(participant, false);
  attachTrackToTile(track, getTileId(participant.identity) + "_media");
}

function attachLocalTrack(track, publication) {
  if (!room) return;
  const source = publication?.source || track?.source;
  if (source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio) return;

  attachTrackToTile(
    track,
    getTileId(room.localParticipant.identity) + "_media"
  );
}

function attachTrackToTile(track, targetId) {
  const target = byId(targetId);
  if (!target || !track) return;

  if (track.kind === Track.Kind.Audio) {
    // Normal auditorium mode: play each remote participant microphone once.
    // The tab-capture programme mixer is not required for singers or audience.
    // Ignore any legacy mixed programme track to prevent duplicate audio.
    if (track.name === "Melody Magic Programme Audio") return;
  }

  const attached = track.attach();

  const elements = Array.isArray(attached)
    ? attached
    : [attached];

  elements.forEach(element => {
    if (!element) return;

    element.style.width = "100%";

    if (track.kind === Track.Kind.Video) {
      element.style.maxHeight = "360px";
      element.autoplay = true;
      element.playsInline = true;
    }

    if (track.kind === Track.Kind.Audio) {
      element.autoplay = true;
      element.controls = false;
    }

    if (!target.contains(element)) {
      target.appendChild(element);
    }

    const playResult = element.play?.();

    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => {
        showMessage(
          "Your browser may require a click to start live audio.",
          "warning"
        );
      });
    }
  });
}

function detachTrackElements(track) {
  if (!track) return;

  try {
    const elements = track.detach();

    const list = Array.isArray(elements)
      ? elements
      : [elements];

    list.forEach(element => element?.remove());

  } catch (error) {
    console.warn("Track detach error:", error);
  }
}

function removeParticipantTile(identity) {
  const tile = byId(getTileId(identity));
  if (tile) tile.remove();
}


/* =========================================
   SHARED AUDITORIUM AUDIO SETTINGS
   Stored inside karaokePlayback so the existing
   host write / singer read path and rules are reused.
========================================= */

function normalizeSharedAudioSettings(value = {}) {
  return {
    echo: Math.max(0, Math.min(100, Number(value.echo ?? 0))),
    delay: Math.max(50, Math.min(1000, Number(value.delay ?? 280))),
    feedback: Math.max(0, Math.min(85, Number(value.feedback ?? 25))),
    reverb: Math.max(0, Math.min(100, Number(value.reverb ?? 0))),
    mix: Math.max(0, Math.min(100, Number(value.mix ?? 0))),
    volume: Math.max(0, Math.min(100, Number(value.volume ?? 80)))
  };
}

function updateAudioControlLabels() {
  const values = {
    mmEchoValue: [byId("mmEcho")?.value, "%"],
    mmDelayValue: [byId("mmDelay")?.value, " ms"],
    mmFeedbackValue: [byId("mmFeedback")?.value, "%"],
    mmReverbValue: [byId("mmReverb")?.value, "%"],
    mmMixValue: [byId("mmMix")?.value, "%"],
    mmVolumeValue: [byId("mmVolume")?.value, "%"]
  };

  Object.entries(values).forEach(([id, pair]) => {
    const element = byId(id);
    if (element && pair[0] !== undefined) {
      element.textContent = pair[0] + pair[1];
    }
  });
}

function readAudioSettingsFromControls() {
  return normalizeSharedAudioSettings({
    echo: byId("mmEcho")?.value,
    delay: byId("mmDelay")?.value,
    feedback: byId("mmFeedback")?.value,
    reverb: byId("mmReverb")?.value,
    mix: byId("mmMix")?.value,
    volume: byId("mmVolume")?.value
  });
}

function applySharedAudioSettingsToEffects() {
  sharedAudioSettings = normalizeSharedAudioSettings(sharedAudioSettings);
  if (!audioEffects) return;

  audioEffects.setEcho(sharedAudioSettings.echo);
  audioEffects.setDelayTime(sharedAudioSettings.delay);
  audioEffects.setFeedback(sharedAudioSettings.feedback);
  audioEffects.setReverb(sharedAudioSettings.reverb);
  audioEffects.setMix(sharedAudioSettings.mix);
  audioEffects.setVolume(sharedAudioSettings.volume);
}

function displaySharedAudioSettings() {
  const pairs = [
    ["mmEcho", sharedAudioSettings.echo],
    ["mmDelay", sharedAudioSettings.delay],
    ["mmFeedback", sharedAudioSettings.feedback],
    ["mmReverb", sharedAudioSettings.reverb],
    ["mmMix", sharedAudioSettings.mix],
    ["mmVolume", sharedAudioSettings.volume]
  ];

  pairs.forEach(([id, value]) => {
    const input = byId(id);
    if (input) input.value = String(value);
  });

  updateAudioControlLabels();
  applySharedAudioSettingsToEffects();
}

function scheduleSharedAudioSettingsSave() {
  if (!hostCanUseAudioEffects()) return;

  sharedAudioSettings = readAudioSettingsFromControls();

  if (audioSettingsSaveTimer) {
    clearTimeout(audioSettingsSaveTimer);
  }

  audioSettingsSaveTimer = setTimeout(async () => {
    try {
      await set(
        ref(db, "karaokePlayback/" + showId + "/audioSettings"),
        {
          ...sharedAudioSettings,
          updatedAt: Date.now(),
          updatedBy: currentUser.uid
        }
      );
      if (byId("mmEffectsStatus")) {
        byId("mmEffectsStatus").textContent =
          "Master microphone settings are live for all singers.";
      }
    } catch (error) {
      console.error("Shared audio settings save failed:", error);
      showMessage("Could not share audio settings: " + error.message, "error");
    }
  }, 180);
}

function listenToSharedAudioSettings() {
  if (!showId) return;

  const settingsRef = ref(
    db,
    "karaokePlayback/" + showId + "/audioSettings"
  );

  if (audioSettingsListener) {
    off(settingsRef, "value", audioSettingsListener);
  }

  audioSettingsListener = snapshot => {
    const value = snapshot.val();

    if (value) {
      sharedAudioSettings = normalizeSharedAudioSettings(value);
      displaySharedAudioSettings();
    } else {
      sharedAudioSettings = normalizeSharedAudioSettings();
      displaySharedAudioSettings();

      // Only the verified host initializes the shared defaults.
      if (hostCanUseAudioEffects()) {
        set(settingsRef, {
          ...sharedAudioSettings,
          updatedAt: Date.now(),
          updatedBy: currentUser.uid
        }).catch(error => {
          console.warn("Could not initialize shared audio settings:", error);
        });
      }
    }
  };

  onValue(settingsRef, audioSettingsListener);
}


/* =========================================
   HOST AND SINGER MICROPHONE AUDIO EFFECTS
========================================= */

function hostCanUseAudioEffects() {
  return (
    isJoined &&
    (
      (currentRole === "host" && isHost && IS_HOST_CONTROL_PAGE) ||
      (currentRole === "singer" && microphoneAllowed)
    )
  );
}

async function startMicrophoneEffects() {
  if (!hostCanUseAudioEffects()) {
    throw new Error("Microphone processing is not currently permitted.");
  }

  if (!microphoneAllowed) {
    throw new Error("The host has not granted microphone permission.");
  }

  if (!room || !isJoined) {
    throw new Error("Join the auditorium first.");
  }

  if (publishedMicrophoneTrack) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });

  rawMicrophoneTrack = stream.getAudioTracks()[0];

  if (!rawMicrophoneTrack) {
    throw new Error("No microphone was found.");
  }

  audioEffects = new VirtualAudioEffects();

  processedMicrophoneTrack =
    await audioEffects.start(rawMicrophoneTrack);

  applySharedAudioSettingsToEffects();

  if (currentRole === "host") {
    audioEffects.setMonitorVolume(
      Number(byId("mmMonitorVolume")?.value || 35)
    );
    audioEffects.setMonitor(Boolean(byId("mmMonitor")?.checked));
  }

  audioEffects.setMuted(false);

  await room.localParticipant.publishTrack(
    processedMicrophoneTrack,
    {
      name: currentRole === "host"
        ? "Melody Magic Host Processed Microphone"
        : "Melody Magic Singer Processed Microphone",
      source: Track.Source.Microphone
    }
  );

  publishedMicrophoneTrack = processedMicrophoneTrack;
  localMicEnabled = true;

  if (byId("mmEffectsStatus")) {
    byId("mmEffectsStatus").textContent =
      currentRole === "host"
        ? "Host microphone active. Master sound is shared with all singers."
        : "Your microphone is live with the host's master audio effects.";
  }

  updateControlButtons();
}



/* =========================================
   PROFESSIONAL PROGRAMME MIXER CONTROL
========================================= */

function mixerStatus(message) {
  const el = byId("mmProgrammeMixerStatus");
  if (el) el.textContent = message;
}

function updateProfessionalMixerVolumes() {
  const controls = [
    ["mmYoutubeMix","mmYoutubeMixValue","youtube"],
    ["mmHostMicMix","mmHostMicMixValue","host-mic"],
    ["mmSingerMix","mmSingerMixValue","singers"]
  ];
  controls.forEach(([inputId,labelId,key]) => {
    const value = Number(byId(inputId)?.value ?? 100);
    const label = byId(labelId);
    if (label) label.textContent = value + "%";
    if (!programmeMixer) return;
    if (key === "singers") {
      programmeRemoteInputs.forEach((inputKey) => programmeMixer.setVolume(inputKey, value));
    } else {
      programmeMixer.setVolume(key, value);
    }
  });
  const syncDelay = Number(byId("mmProgrammeSyncDelay")?.value ?? 0);
  const syncLabel = byId("mmProgrammeSyncDelayValue");
  if (syncLabel) syncLabel.textContent = syncDelay + " ms";
  programmeMixer?.setInputDelay("youtube", syncDelay);

  const master = Number(byId("mmProgrammeMaster")?.value ?? 90);
  const masterLabel = byId("mmProgrammeMasterValue");
  if (masterLabel) masterLabel.textContent = master + "%";
  programmeMixer?.setMasterVolume(master);
}

function addRemoteSingerToProgrammeMixer(track, participant) {
  if (!track || track.kind !== Track.Kind.Audio || track.name === "Melody Magic Programme Audio") return;
  const mediaTrack = track.mediaStreamTrack;
  if (!mediaTrack) return;
  const key = "singer:" + safeText(participant?.identity) + ":" + safeText(mediaTrack.id);
  programmeRemoteInputs.set(mediaTrack.id, key);
  if (programmeMixer) {
    programmeMixer.addInput(key, mediaTrack, Number(byId("mmSingerMix")?.value ?? 100) / 100);
    updateProfessionalMixerVolumes();
  }
}

function removeRemoteSingerFromProgrammeMixer(track) {
  const mediaTrack = track?.mediaStreamTrack;
  if (!mediaTrack) return;
  const key = programmeRemoteInputs.get(mediaTrack.id);
  if (key && programmeMixer) programmeMixer.removeInput(key);
  programmeRemoteInputs.delete(mediaTrack.id);
}

async function startProfessionalProgrammeMixer() {
  if (programmeMixerStarting || programmeMixer) return;
  if (!isJoined || currentRole !== "host" || !isHost || !IS_HOST_CONTROL_PAGE) {
    mixerStatus("Only the approved host can start the programme mixer from the host control room.");
    return;
  }
  if (!microphoneAllowed) {
    mixerStatus("Host microphone permission is required. Ask the auditorium server to grant microphone access.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.getDisplayMedia) {
    mixerStatus("This feature requires desktop Chrome with tab-audio capture support.");
    return;
  }

  programmeMixerStarting = true;
  const startButton = byId("mmStartProgrammeMixer");
  if (startButton) startButton.disabled = true;
  mixerStatus("Choose the Melody Magic host-control tab and enable Share tab audio in Chrome.");

  try {
    // Request tab capture synchronously inside the button gesture.
    const displayCapturePromise = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: true
    });
    const mixer = new ProfessionalProgrammeMixer(mixerStatus);
    programmeMixer = mixer;
    await mixer.initialize();
    await mixer.captureCurrentTab(displayCapturePromise);
    await mixer.captureHostMicrophone();

    // Include singers who were already connected before the mixer started.
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track && publication.track.kind === Track.Kind.Audio) {
            addRemoteSingerToProgrammeMixer(publication.track, participant);
          }
        }
      }
    }

    updateProfessionalMixerVolumes();
    const output = mixer.outputTrack;
    await room.localParticipant.publishTrack(output, {
      name: "Melody Magic Programme Audio",
      source: Track.Source.Microphone
    });
    publishedProgrammeTrack = output;

    const stopButton = byId("mmStopProgrammeMixer");
    if (stopButton) stopButton.disabled = false;
    if (startButton) startButton.disabled = true;
    mixerStatus("LIVE — YouTube tab, host microphone and connected singer microphones are mixed into one programme audio track.");
    showMessage("Professional programme mixer is live.", "success");
  } catch (error) {
    console.error("Professional mixer start failed:", error);
    await stopProfessionalProgrammeMixer();
    mixerStatus("Mixer could not start: " + error.message);
    showMessage("Professional mixer error: " + error.message, "error");
  } finally {
    programmeMixerStarting = false;
    if (!programmeMixer && startButton) startButton.disabled = false;
  }
}

async function stopProfessionalProgrammeMixer() {
  const mixer = programmeMixer;
  programmeMixer = null;
  if (room && publishedProgrammeTrack) {
    try { await room.localParticipant.unpublishTrack(publishedProgrammeTrack, true); }
    catch (error) { console.warn("Programme track unpublish failed:", error); }
  }
  publishedProgrammeTrack = null;
  if (mixer) await mixer.stop();
  programmeRemoteInputs.clear();
  const stopButton = byId("mmStopProgrammeMixer");
  const startButton = byId("mmStartProgrammeMixer");
  if (stopButton) stopButton.disabled = true;
  if (startButton) startButton.disabled = !isJoined || currentRole !== "host";
  if (byId("mmProgrammeMonitor")) byId("mmProgrammeMonitor").checked = false;
  mixerStatus("Mixer is OFF.");
}


/* =========================================
   STOP MICROPHONE EFFECTS
========================================= */

async function stopMicrophoneEffects() {
  if (room && publishedMicrophoneTrack) {
    try {
      await room.localParticipant.unpublishTrack(publishedMicrophoneTrack, true);
    } catch (error) {
      console.warn("Microphone unpublish:", error);
    }
  }
  publishedMicrophoneTrack = null;
  processedMicrophoneTrack = null;
  if (audioEffects) {
    audioEffects.stop();
    audioEffects = null;
  }
  if (rawMicrophoneTrack) {
    try { rawMicrophoneTrack.stop(); } catch (error) {}
  }
  rawMicrophoneTrack = null;
  localMicEnabled = false;
  if (byId("mmEffectsStatus")) byId("mmEffectsStatus").textContent = "Microphone is OFF.";
  updateControlButtons();
}

/* =========================================
   ONE SHARED KARAOKE VIDEO + AUDIO
========================================= */

function setSharedKaraokeStatus(message) {
  const status = byId("mmShareKaraokeStatus");
  if (status) status.textContent = message;
}

function updateSharedKaraokeButton() {
  const button = byId("mmShareKaraokeBtn");
  if (!button) return;
  const sharing = sharedKaraokeTracks.length > 0;
  button.disabled = !isJoined || sharedKaraokeStarting;
  button.textContent = sharing
    ? "■ STOP SHARING KARAOKE"
    : "▶ SHARE KARAOKE WITH EVERYONE";
}

async function startSharedKaraokeCapture() {
  if (!room || !isJoined || !isHost || currentRole !== "host" || !IS_HOST_CONTROL_PAGE) {
    throw new Error("The approved host must enter the live auditorium before sharing karaoke.");
  }
  if (sharedKaraokeStarting) return;
  if (sharedKaraokeTracks.length) return;

  sharedKaraokeStarting = true;
  updateSharedKaraokeButton();
  setSharedKaraokeStatus("Opening Chrome's sharing picker...");

  let tracks = [];
  try {
    // The host must select THIS Chrome tab and tick Share tab audio.
    tracks = await room.localParticipant.createScreenTracks({
      audio: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude"
    });

    const videoTrack = tracks.find(track => track.kind === Track.Kind.Video);
    const audioTrack = tracks.find(track => track.kind === Track.Kind.Audio);
    if (!videoTrack || !audioTrack) {
      throw new Error("Chrome did not provide tab audio. Start again, choose This tab, and tick Share tab audio.");
    }

    const videoElement = byId("videoPlayer");
    if (!videoElement || videoElement.offsetWidth < 1 || videoElement.offsetHeight < 1) {
      throw new Error("Load the YouTube karaoke video first, then start sharing.");
    }
    if (!window.CropTarget || typeof videoTrack.mediaStreamTrack?.cropTo !== "function") {
      throw new Error("This Chrome version cannot crop the karaoke area. Use the latest desktop Chrome and share This tab.");
    }

    // Crop the shared tab to the YouTube player only, keeping host controls private.
    try {
      const cropTarget = await window.CropTarget.fromElement(videoElement);
      await videoTrack.mediaStreamTrack.cropTo(cropTarget);
    } catch (cropError) {
      throw new Error("In Chrome sharing options, choose This tab (not Window or Entire screen), then try again.");
    }

    const publishedTracks = [];
    await room.localParticipant.publishTrack(videoTrack, {
      name: "Melody Magic Shared Karaoke Video",
      source: Track.Source.ScreenShare
    });
    publishedTracks.push(videoTrack);
    await room.localParticipant.publishTrack(audioTrack, {
      name: "Melody Magic Shared Karaoke Audio",
      source: Track.Source.ScreenShareAudio
    });
    publishedTracks.push(audioTrack);

    sharedKaraokeTracks = tracks;
    videoTrack.mediaStreamTrack.addEventListener("ended", () => {
      if (!sharedKaraokeStopping) {
        stopSharedKaraokeCapture("Screen sharing was stopped in Chrome.");
      }
    }, { once: true });

    setSharedKaraokeStatus("LIVE — everyone is receiving the same karaoke video and tab audio.");
  } catch (error) {
    for (const track of tracks) {
      try { await room?.localParticipant?.unpublishTrack(track); } catch (unpublishError) {}
      try { track.stop(); } catch (stopError) {}
    }
    throw error;
  } finally {
    sharedKaraokeStarting = false;
    updateSharedKaraokeButton();
  }
}

async function stopSharedKaraokeCapture(statusMessage = "Karaoke sharing stopped.") {
  sharedKaraokeStopping = true;
  const tracks = sharedKaraokeTracks.slice();
  sharedKaraokeTracks = [];
  if (room?.localParticipant) {
    for (const track of tracks) {
      try { await room.localParticipant.unpublishTrack(track); } catch (error) {}
    }
  }
  for (const track of tracks) {
    try { track.stop(); } catch (error) {}
  }
  setSharedKaraokeStatus(statusMessage);
  updateSharedKaraokeButton();
  sharedKaraokeStopping = false;
}

function wireSharedKaraokeButton() {
  const soundButton = byId("mmEnableKaraokeSound");
  if (soundButton && soundButton.dataset.mmWired !== "true") {
    soundButton.dataset.mmWired = "true";
    soundButton.addEventListener("click", async () => {
      const audioBox = byId("mmSharedKaraokeAudio");
      const audioElements = audioBox ? audioBox.querySelectorAll("audio") : [];
      if (!audioElements.length) {
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Waiting for the host to start sharing karaoke audio.";
        return;
      }
      try {
        for (const audio of audioElements) await audio.play();
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Karaoke sound enabled. Enjoy the show!";
      } catch (error) {
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Sound is still blocked. Check your browser sound permission and tap again.";
      }
    });
  }
  const button = byId("mmShareKaraokeBtn");
  if (!button || button.dataset.mmWired === "true") return;
  button.dataset.mmWired = "true";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (sharedKaraokeTracks.length) {
        await stopSharedKaraokeCapture();
      } else {
        await startSharedKaraokeCapture();
      }
    } catch (error) {
      console.error("Shared karaoke error:", error);
      setSharedKaraokeStatus("Could not share: " + error.message);
      showMessage(error.message, "error");
    } finally {
      updateSharedKaraokeButton();
    }
  });
  updateSharedKaraokeButton();
}

/* =========================================
   TOGGLE MICROPHONE
========================================= */

async function toggleMicrophone() {
  if (!room || !isJoined) return;

  if (!microphoneAllowed) {
    showMessage("The host has not granted microphone permission.", "warning");
    return;
  }

  try {
    if (localMicEnabled) {
      await stopMicrophoneEffects();
      showMessage("Microphone OFF.");
      updateControlButtons();
      return;
    }

    if (currentRole === "host" || currentRole === "singer") {
      await startMicrophoneEffects();
    }

    updateControlButtons();
    showMessage("Microphone ON.", "success");

  } catch (error) {
    console.error("Microphone error:", error);

    if (currentRole === "host") {
      await stopMicrophoneEffects();
    }

    showMessage("Microphone error: " + error.message, "error");
  }
}


/* =========================================
   CAMERA
========================================= */

async function toggleCamera() {
  if (!room || !isJoined) return;

  if (!cameraAllowed) {
    showMessage("Camera access is not available.", "warning");
    return;
  }

  try {
    const nextState = !localCameraEnabled;

    if (nextState) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not supported.");
      }

      const devices = await navigator.mediaDevices.enumerateDevices();

      if (!devices.some(device => device.kind === "videoinput")) {
        throw new Error("No camera device was found.");
      }
    }

    await room.localParticipant.setCameraEnabled(nextState);

    localCameraEnabled = nextState;
    updateControlButtons();

  } catch (error) {
    localCameraEnabled = false;
    updateControlButtons();

    showMessage("Camera error: " + error.message, "error");
  }
}


/* =========================================
   UPDATE BUTTONS
========================================= */

function updateControlButtons() {
  const mic = byId("mmMicBtn");
  const camera = byId("mmCameraBtn");
  const info = byId("mmPermissionInfo");
  if (!mic || !camera) return;

  mic.disabled = !isJoined || !microphoneAllowed ||
    (currentRole === "host" && IS_HOST_CONTROL_PAGE);
  camera.disabled = !isJoined || !cameraAllowed;
  mic.textContent = currentRole === "host" && IS_HOST_CONTROL_PAGE
    ? "Use Professional Mixer"
    : (localMicEnabled ? "Microphone ON" : "Microphone OFF");
  camera.textContent = localCameraEnabled ? "Camera ON" : "Camera OFF";

  if (info) {
    if (currentRole === "audience") {
      info.textContent = "Audience mode: microphone and camera are disabled.";
    } else if (currentRole === "singer") {
      info.textContent = "Camera: available while waiting and performing. Microphone: " +
        (microphoneAllowed ? "Host has granted permission." : "OFF — waiting for host permission.");
    } else {
      info.textContent = "Host microphone: " +
        (microphoneAllowed ? "Allowed" : "Not allowed") +
        " | Camera: " + (cameraAllowed ? "Allowed" : "Not allowed");
    }
  }
}

/* =========================================
   MY PERMISSION LISTENER
========================================= */

function listenToMyPermissions() {
  if (!currentUser || !showId) return;

  const permissionRef = ref(
    db,
    "participantControls/" + showId + "/" + currentUser.uid
  );

  if (permissionListener) {
    off(permissionRef, "value", permissionListener);
  }

  permissionListener = snapshot => {
    const controls = snapshot.val() || {};

    if (currentRole !== "singer") {
      microphoneAllowed = false;
      cameraAllowed = false;
      updateControlButtons();
      return;
    }

    const selected =
      stageSingerUids.includes(currentUser.uid);

    microphoneAllowed = selected && controls.microphoneAllowed === true;
    cameraAllowed = true;
    enforceCurrentPermissions();
    autoEnableSingerMicrophone();
    updateControlButtons();
  };

  onValue(permissionRef, permissionListener);
}


/* =========================================
   ENFORCE PERMISSIONS
========================================= */

async function autoEnableSingerMicrophone() {
  if (currentRole !== "singer" || !room || !isJoined || !microphoneAllowed || localMicEnabled) return;
  try {
    await startMicrophoneEffects();
    showMessage("Main stage assigned. Host master audio effects are ON.", "success");
    updateControlButtons();
  } catch (error) {
    localMicEnabled = false;
    showMessage("Stage assigned, but microphone permission is needed in browser settings: " + error.message, "warning");
    updateControlButtons();
  }
}

async function enforceCurrentPermissions() {
  if (!room) return;

  if (!microphoneAllowed && localMicEnabled) {
    await stopMicrophoneEffects();
  }

  // Do not turn off a singer's camera when they are removed from the stage.
  // Camera access is available to approved singers while they wait.

  updateControlButtons();
}


/* =========================================
   STAGE LISTENER
========================================= */

function listenToStage() {
  if (!showId) return;

  const stageRef = ref(db, "liveStage/" + showId);

  if (stageListener) {
    off(stageRef, "value", stageListener);
  }

  stageListener = snapshot => {
    const stage = snapshot.val() || {};

    stageSingerUids = normalizeArray(stage.singerUids);

    // Reclassify existing camera tiles when the host changes the main stage.
    document.querySelectorAll(".mm-video-box[data-participant-identity]").forEach(tile => {
      const identity = tile.dataset.participantIdentity || "";
      const isHostTile = tile.id === getTileId(currentShow?.hostUid || "");
      const selected = stageSingerUids.includes(identity);
      tile.classList.toggle("mm-main-stage", selected);
      tile.classList.toggle("mm-waiting-stage", !selected && !isHostTile);
      tile.classList.toggle(
        "mm-local-singer-preview",
        currentRole === "singer" && !!currentUser && identity === safeText(currentUser.uid) && !selected
      );
    });

    if (currentRole === "singer" && currentUser) {
      const selected = stageSingerUids.includes(currentUser.uid);

      if (!selected) {
        microphoneAllowed = false;
      }
      // When selected, microphone permission comes from the singer's own controls listener.
      cameraAllowed = true;
      enforceCurrentPermissions();
      autoEnableSingerMicrophone();
    }

    updateControlButtons();
  };

  onValue(stageRef, stageListener);
}


/* =========================================
   HOST: LOAD APPROVED REGISTRATIONS
========================================= */

async function loadHostRegistrations() {
  if (!isHost || !IS_HOST_CONTROL_PAGE || !showId) return;

  const registrationsRef = ref(
    db,
    "showRegistrations/" + showId
  );

  if (registrationListener) {
    off(registrationsRef, "value", registrationListener);
  }

  registrationListener = snapshot => {
    registrations = snapshot.val() || {};
    populateSingerSelectors();
    renderSingerPermissionControls();
  };

  onValue(registrationsRef, registrationListener);
}

function getApprovedRegistrations() {
  return Object.entries(registrations)
    .map(([id, item]) => ({ id, ...(item || {}) }))
    .filter(item => item.singerUid && isApproved(item.status));
}

function populateSingerSelectors() {
  if (!IS_HOST_CONTROL_PAGE) return;

  const first = byId("mmSingerOne");
  const second = byId("mmSingerTwo");

  if (!first || !second) return;

  const approved = getApprovedRegistrations();

  const buildOptions = (select, label) => {
    const previous = select.value;

    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = label;
    select.appendChild(placeholder);

    approved.forEach(item => {
      const option = document.createElement("option");

      option.value = item.singerUid;
      option.textContent =
        item.singerName || item.name || "Singer";

      select.appendChild(option);
    });

    if (approved.some(item => item.singerUid === previous)) {
      select.value = previous;
    }
  };

  buildOptions(first, "Select approved singer");
  buildOptions(second, "Select second singer");
}


/* =========================================
   HOST: PERMISSION LISTENER
========================================= */

function listenToParticipantControls() {
  if (!isHost || !IS_HOST_CONTROL_PAGE || !showId) return;

  const controlsRef = ref(
    db,
    "participantControls/" + showId
  );

  if (controlsListener) {
    off(controlsRef, "value", controlsListener);
  }

  controlsListener = snapshot => {
    participantPermissions = snapshot.val() || {};
    renderSingerPermissionControls();
  };

  onValue(controlsRef, controlsListener);
}


/* =========================================
   HOST: RENDER SINGER PERMISSIONS
========================================= */

function renderSingerPermissionControls() {
  if (!IS_HOST_CONTROL_PAGE || !isHost) return;

  const container = byId("mmSingerPermissions");
  if (!container) return;

  const approved = getApprovedRegistrations();

  if (!approved.length) {
    container.textContent =
      "No approved singers with linked accounts were found.";
    return;
  }

  container.innerHTML = "";

  approved.forEach(item => {
    const controls =
      participantPermissions[item.singerUid] || {};

    const micOn = controls.microphoneAllowed === true;
    const selected = stageSingerUids.includes(item.singerUid);

    const card = document.createElement("div");
    card.className = "mm-singer-control";

    const name = document.createElement("strong");
    name.textContent =
      item.singerName || item.name || "Singer";

    const status = document.createElement("div");
    status.className = "mm-permission-status";

    status.textContent =
      (selected ? "On main stage" : "Waiting in queue") +
      " | Microphone: " + (micOn ? "Allowed" : "OFF") +
      " | Camera: Available to approved singer";

    const micButton = document.createElement("button");

    micButton.textContent = micOn
      ? "Revoke Microphone"
      : "Grant Microphone";

    micButton.addEventListener("click", () => {
      changeSingerPermission(item.singerUid, !micOn);
    });

    card.append(name, status, micButton);
    container.appendChild(card);
  });
}


/* =========================================
   HOST: CHANGE SINGER MICROPHONE PERMISSION
========================================= */

async function changeSingerPermission(singerUid, microphone) {
  if (!isHost || !IS_HOST_CONTROL_PAGE || !isJoined) {
    showMessage("Only the verified host can change permissions.", "error");
    return;
  }

  if (!stageSingerUids.includes(singerUid)) {
    showMessage(
      "Assign this singer to the main stage first.",
      "warning"
    );
    return;
  }

  try {
    await workerRequest({
      action: "syncPermissions",
      uid: singerUid,
      microphoneAllowed: microphone === true,
      cameraAllowed: true
    });

    showMessage(
      "Singer microphone permission updated.",
      "success"
    );

  } catch (error) {
    console.error("Permission update error:", error);

    showMessage(
      "Could not update singer permission: " + error.message,
      "error"
    );
  }
}


/* =========================================
   HOST: ASSIGN MAIN STAGE
========================================= */

async function selectMainSingers() {
  if (!isHost || !IS_HOST_CONTROL_PAGE || !isJoined || !currentUser) {
    showMessage("Only the verified host can assign the main stage.", "error");
    return;
  }

  const mode = byId("mmStageMode").value;
  const singerOne = byId("mmSingerOne").value;
  const singerTwo = byId("mmSingerTwo").value;
    if (!singerOne) {
    showMessage("Please select the first singer.", "warning");
    return;
  }

  if (mode === "duet" && !singerTwo) {
    showMessage("Please select the second singer for duet.", "warning");
    return;
  }

  if (mode === "solo" && singerTwo) {
    showMessage("For solo mode, select only one singer.", "warning");
    return;
  }

  if (singerOne === singerTwo && singerTwo) {
    showMessage("Please select two different singers.", "warning");
    return;
  }

  const selectedUids = mode === "duet"
    ? [singerOne, singerTwo]
    : [singerOne];

  const approved = getApprovedRegistrations();

  const selected = selectedUids.map(uid =>
    approved.find(item => item.singerUid === uid)
  );

  if (selected.some(item => !item)) {
    showMessage("One or more selected singers are not approved.", "error");
    return;
  }

  const registrationIds = selected.map(item => item.id);

  const singerNames = selected.map(item =>
    item.singerName || item.name || "Singer"
  );

  const stageButton = byId("mmSetStageBtn");

  stageButton.disabled = true;
  stageButton.textContent = "Assigning...";

  try {
    const stageData = {
      mode,
      registrationIds,
      singerUids: selectedUids,
      singerNames,
      registrationId: registrationIds[0],
      singerUid: selectedUids[0],
      singerName: singerNames[0],
      updatedAt: Date.now()
    };

    await set(
      ref(db, "liveStage/" + showId),
      stageData
    );

    for (const item of approved) {
      await workerRequest({
        action: "syncPermissions",
        uid: item.singerUid,
        microphoneAllowed: false,
        cameraAllowed: true
      });
    }

    showMessage(
      mode.toUpperCase() +
      " stage assigned. Grant microphone permission separately.",
      "success"
    );

  } catch (error) {
    console.error("Stage assignment error:", error);

    showMessage(
      "Unable to assign stage: " + error.message,
      "error"
    );

  } finally {
    stageButton.disabled = false;
    stageButton.textContent = "Assign Main Stage";
  }
}


/* =========================================
   FIREBASE LISTENER CLEANUP
========================================= */

function stopFirebaseListeners() {
  if (permissionListener && currentUser && showId) {
    off(
      ref(db, "participantControls/" + showId + "/" + currentUser.uid),
      "value",
      permissionListener
    );
  }

  if (stageListener && showId) {
    off(
      ref(db, "liveStage/" + showId),
      "value",
      stageListener
    );
  }

  if (registrationListener && showId) {
    off(
      ref(db, "showRegistrations/" + showId),
      "value",
      registrationListener
    );
  }

  if (controlsListener && showId) {
    off(
      ref(db, "participantControls/" + showId),
      "value",
      controlsListener
    );
  }

  if (commentsListener && showId) {
    off(
      ref(db, "liveComments/" + showId),
      "value",
      commentsListener
    );
  }

  if (queueListener && showId) {
    off(
      ref(db, "performanceQueue/" + showId),
      "value",
      queueListener
    );
  }

  if (playbackListener && showId) {
    off(
      ref(db, "karaokePlayback/" + showId),
      "value",
      playbackListener
    );
  }

  if (audioSettingsListener && showId) {
    off(
      ref(db, "karaokePlayback/" + showId + "/audioSettings"),
      "value",
      audioSettingsListener
    );
  }

  if (showLifecycleListener && showId) {
    off(
      ref(db, "shows/" + showId),
      "value",
      showLifecycleListener
    );
  }

  showLifecycleListener = null;
  permissionListener = null;
  stageListener = null;
  registrationListener = null;
  controlsListener = null;
  commentsListener = null;
  queueListener = null;
  playbackListener = null;
  audioSettingsListener = null;
}


/* =========================================
   LEAVE AUDITORIUM
========================================= */

async function leaveAuditorium() {
  if (leaving) return;
  leaving = true;
  if (singerAutoJoinTimer) clearTimeout(singerAutoJoinTimer);
  try {
    await stopProfessionalProgrammeMixer();
    if (publishedMicrophoneTrack || audioEffects || rawMicrophoneTrack) {
      await stopMicrophoneEffects();
    } else if (room && localMicEnabled) {
      try { await room.localParticipant.setMicrophoneEnabled(false); } catch (error) {}
    }
    if (room && localCameraEnabled) {
      try { await room.localParticipant.setCameraEnabled(false); } catch (error) {}
    }
    if (room) {
      try { await room.disconnect(); } catch (error) {
        console.warn("Room disconnect error:", error);
      }
    }
  } catch (error) {
    console.warn("Leave error:", error);
  } finally {
    stopFirebaseListeners();
    if (audioEffects) {
      audioEffects.stop();
      audioEffects = null;
    }
    room = null;
    isJoined = false;
    localMicEnabled = false;
    localCameraEnabled = false;
    microphoneAllowed = false;
    cameraAllowed = false;
    resetButtons();
    updateReactionButtons();
    updateCommentControls();
    updateAudienceCount();
    const grid = byId("mmVideoGrid");
    if (grid) grid.innerHTML = "";
    showMessage("You have left the auditorium.");
    leaving = false;
  }
}

/* =========================================
   RESET BUTTONS
========================================= */

function resetButtons() {
  setButtonState(
    "mmJoinBtn",
    false,
    "Enter Live Auditorium"
  );

  setButtonState(
    "mmLeaveBtn",
    true,
    "Leave Auditorium"
  );

  setButtonState("mmMicBtn", true, "Microphone OFF");
  setButtonState("mmCameraBtn", true, "Camera OFF");

  if (byId("mmRoleInfo")) {
    byId("mmRoleInfo").textContent = "";
  }

  if (byId("mmHostControls")) {
    byId("mmHostControls").hidden = true;
  }

  if (byId("mmAudioEffects")) {
    byId("mmAudioEffects").hidden = true;
  }

  if (byId("mmMyControls")) {
    byId("mmMyControls").hidden = true;
  }
}


/* =========================================
   PUBLIC COMMENT AND REACTION CONTROLS
========================================= */

function wirePublicInteractionControls() {
  // The singer page has its own visible controls outside the hidden
  // LiveKit panel. Rebind those visible elements explicitly.
  const sendButton = byId("mmSendCommentBtn");
  if (sendButton) {
    const freshButton = sendButton.cloneNode(true);
    freshButton.disabled = !isJoined || !currentUser;
    sendButton.replaceWith(freshButton);
    freshButton.addEventListener("click", sendLiveComment);
  }

  const commentInput = byId("mmCommentInput");
  if (commentInput) {
    const freshInput = commentInput.cloneNode(true);
    commentInput.replaceWith(freshInput);
    freshInput.addEventListener("keydown", event => {
      if (event.key === "Enter") sendLiveComment();
    });
  }

  const reactionButtons = byId("mmReactionButtons");
  if (reactionButtons) {
    const freshReactions = reactionButtons.cloneNode(true);
    reactionButtons.replaceWith(freshReactions);
    freshReactions.addEventListener("click", event => {
      const button = event.target.closest("[data-reaction]");
      if (button && !button.disabled) sendReaction(button.dataset.reaction);
    });
  }

  updateCommentControls();
  updateReactionButtons();
}

/* =========================================
   INITIALIZE
========================================= */

async function initializeShow() {
  createPanel();
  wirePublicInteractionControls();
  wireSharedKaraokeButton();
  updateReactionButtons();
  updateCommentControls();

  if (!showId) {
    showMessage(
      "Show ID is missing. Please open the correct show link.",
      "error"
    );

    setButtonState("mmJoinBtn", true);
    return;
  }

  if (requestedMode === "singer" && !registrationId) {
    showMessage(
      "Singer registration ID is missing from the entry link.",
      "error"
    );

    setButtonState("mmJoinBtn", true);
    return;
  }

  try {
    await waitForAuth();
    await loadShow();

    // Start the shared karaoke listener as soon as Firebase is ready.
    // It must not depend on the LiveKit camera/microphone connection:
    // a singer should still receive the host's video if LiveKit is delayed.
    if (requestedMode === "singer" || requestedMode === "audience") {
      listenToKaraokePlayback();
    }

    isHost = await verifyHost();

    if (byId("mmHostControls")) {
      byId("mmHostControls").hidden = true;
    }

    if (byId("mmAudioEffects")) {
      byId("mmAudioEffects").hidden = true;
    }

    if (isHost) {
      byId("mmRoleInfo").textContent =
        IS_HOST_CONTROL_PAGE
          ? "Host verified. Enter the auditorium to manage the stage and audio."
          : "Host account detected. Host controls are available only in the Host Control Room.";

      showMessage("Host verified. Enter the auditorium when ready.");

    } else if (requestedMode === "singer") {
      byId("mmRoleInfo").textContent =
        "Singer entry requested. Your registration will be checked.";

      showMessage("Singer registration confirmed. Waiting for the host to start the show.");

    } else {
      byId("mmRoleInfo").textContent =
        "Audience entry. Microphone and camera are disabled.";

      showMessage("Audience entry ready. Click Enter Live Auditorium.");
    }

    listenToStage();
    if (requestedMode === "singer") {
      listenToShowLifecycle();
      setSingerVisibleStatus(
        "Waiting for host",
        "Your registration is approved. You will join automatically when the host starts this show."
      );
    }

  } catch (error) {
    console.error("Initialization error:", error);

    showMessage(
      error.message || "Unable to initialize auditorium.",
      "error"
    );

    setButtonState("mmJoinBtn", true);
  }
}


/* =========================================
   START
========================================= */

initializeShow();

window.addEventListener("beforeunload", () => {
  stopFirebaseListeners();

  if (room) {
    room.disconnect();
  }

  if (audioEffects) {
    audioEffects.stop();
  }

  if (youtubePlayer && typeof youtubePlayer.destroy === "function") {
    youtubePlayer.destroy();
  }
});
