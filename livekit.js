import {
  Room,
  RoomEvent,
  Track
} from "https://esm.sh/livekit-client@2";

import { auth, db, connectAuditorium } from "./firebase.js";

import {
  ref,
  get,
  set,
  push,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  limitToFirst
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
let requestedMode = (params.get("mode") || (location.pathname.toLowerCase().endsWith("live-performance.html") ? "singer" : "audience")).toLowerCase();
let singerMobile = "";
let preauthorizedSingerToken = null;

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
let hostSingerMonitorEnabled = true;

let stageSingerUids = [];
let registrations = {};
let participantPermissions = {};

let permissionListener = null;
let stageListener = null;
let registrationListener = null;
let singerRegistrationListener = null;
let singerRegistration = null;
let controlsListener = null;

let commentsListener = null;
let queueListener = null;
let playbackListener = null;
let singerKaraokeListener = null;
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
let hostDirectMonitorElement = null;
// One host-controlled master effects profile is shared by the host and every singer.
let sharedAudioSettings = {
  echo: 0,
  delay: 0,
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
let playbackStartTimer = null;
let playbackSyncTimer = null;
let sharedKaraokeTracks = [];
let sharedKaraokeStarting = false;
let sharedKaraokeStopping = false;
let singerKaraokeCaptureStream = null;
let singerKaraokeAudioContext = null;
let singerKaraokeMixTrack = null;

let liveComments = [];
let liveQueue = [];
let activePerformanceData = {};


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
    this.monitorUsesProcessed = false;
    this.monitorEffectValues = { echo: 0, delay: 0, reverb: 0 };
  }

  async start(inputTrack) {
    this.stop();

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Web Audio is not supported by this browser.");
    }

    // Request the browser's lowest practical audio buffering for live headphone monitoring.
    this.context = new AudioContextClass({ latencyHint: "interactive" });

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
    this.delay.delayTime.value = 0;

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

    // Start with a direct, low-latency headphone monitor when all effects are zero.
    // Switch to the processed output only when the host enables an effect.
    this.source.connect(this.monitorGain);
    this.monitorGain.connect(this.context.destination);
    this.monitorUsesProcessed = false;

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

    this.monitorEffectValues.echo = Number(value) || 0;
    this.updateMonitorRoute();
    const amount = Math.max(0, Math.min(100, Number(value))) / 100;

    this.echoGain.gain.setTargetAtTime(
      amount * 0.6,
      this.context.currentTime,
      0.03
    );
  }

  setDelayTime(value) {
    if (!this.delay || !this.context) return;

    this.monitorEffectValues.delay = Number(value) || 0;
    this.updateMonitorRoute();
    const milliseconds = Math.max(0, Math.min(1000, Number(value)));
    this.delay.delayTime.setTargetAtTime(milliseconds / 1000, this.context.currentTime, 0.03);
    // A zero delay must never leave a feedback loop running.
    if (milliseconds === 0) {
      this.feedback.gain.setTargetAtTime(0, this.context.currentTime, 0.01);
      this.echoGain?.gain.setTargetAtTime(0, this.context.currentTime, 0.01);
    }
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

    this.monitorEffectValues.reverb = Number(value) || 0;
    this.updateMonitorRoute();
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
  updateMonitorRoute() {
    if (!this.source || !this.outputGain || !this.monitorGain) return;
    const needsEffects = Object.values(this.monitorEffectValues)
      .some(value => Number(value) > 0);
    if (needsEffects === this.monitorUsesProcessed) return;
    try {
      if (needsEffects) {
        this.source.disconnect(this.monitorGain);
        this.outputGain.connect(this.monitorGain);
      } else {
        this.outputGain.disconnect(this.monitorGain);
        this.source.connect(this.monitorGain);
      }
      this.monitorUsesProcessed = needsEffects;
    } catch (error) {
      console.warn("Could not switch microphone monitor route:", error);
    }
  }

  setMonitor(enabled, volumeValue = null) {
    if (!this.monitorGain || !this.context) return;

    this.monitorEnabled = Boolean(enabled);
    const requestedVolume = volumeValue === null
      ? Number(byId("mmMonitorVolume")?.value || 35)
      : Number(volumeValue);
    const volume = this.monitorEnabled
      ? Math.max(0, Math.min(50, requestedVolume)) / 100
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

function getSingerParticipantUid() {
  return requestedMode === "singer" && singerRegistration?.singerUid
    ? singerRegistration.singerUid
    : currentUser?.uid;
}

function getHostParticipantUid() {
  const hostUid = safeText(currentShow?.hostUid);
  return hostUid ? "host-" + hostUid : "";
}

function showSingerMobileEntry(message = "") {
  const panel = byId("mmSingerMobileEntry");
  const messageNode = byId("mmSingerMobileMessage");
  if (panel) panel.hidden = false;
  if (messageNode) messageNode.textContent = message;
  setSingerVisibleStatus("Mobile number required", "Enter the mobile number used for this show's singer registration.");
}

async function activateSingerMobileRegistration(value) {
  const mobile = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(mobile)) {
    throw new Error("Please enter a valid 10-digit mobile number.");
  }

  const result = await workerRequest({
    action: "checkSingerRegistration",
    mobile,
    ...(registrationId ? { registrationId } : {}),
    name: currentUser?.displayName || "Singer"
  });

  singerMobile = mobile;
  singerRegistration = {
    id: result.registrationId,
    registrationId: result.registrationId,
    singerUid: result.singerUid,
    singerName: result.singerName,
    status: result.status || result.registrationStatus,
    mobile
  };
  requestedMode = "singer";

  try { localStorage.setItem("mmSingerMobile:" + showId, mobile); } catch (error) {}

  const panel = byId("mmSingerMobileEntry");
  if (panel) panel.hidden = true;

  listenToSingerKaraokeVideo();
  if (!showLifecycleListener) listenToShowLifecycle();

  setSingerVisibleStatus(
    "Approved singer",
    "Your registration is approved. You will join automatically when the host starts this show."
  );

  if (isShowLive() && !isJoined && !joining) {
    singerAutoJoinStarted = true;
    joinAuditorium();
  }
}

window.MelodyMagicSingerEntry = async function () {
  const input = byId("mmSingerMobileInput");
  const message = byId("mmSingerMobileMessage");
  const button = byId("mmSingerMobileContinue");
  if (button) { button.disabled = true; button.textContent = "CHECKING..."; }
  if (message) message.textContent = "Checking registration...";
  try {
    if (message) message.textContent = "Signing in securely...";
    await waitForAuth();
    if (message) message.textContent = "Checking registration...";
    await activateSingerMobileRegistration(input?.value || "");
  } catch (error) {
    if (message) message.textContent = error?.message || "Registration check failed.";
    setSingerVisibleStatus("Registration check failed", error?.message || "Please try again.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "CONTINUE TO LIVE STAGE"; }
  }
};

function wireSingerMobileEntry() {
  const button = byId("mmSingerMobileContinue");
  const input = byId("mmSingerMobileInput");
  if (!button || button.dataset.mmWired === "true") return;
  button.dataset.mmWired = "true";

  button.addEventListener("click", async () => {
    const message = byId("mmSingerMobileMessage");
    button.disabled = true;
    button.textContent = "CHECKING...";
    if (message) message.textContent = "";

    try {
      await activateSingerMobileRegistration(input?.value || "");
    } catch (error) {
      if (message) message.textContent = error.message || "Could not verify this number.";
      setSingerVisibleStatus("Registration check failed", error.message || "Please try again.");
    } finally {
      button.disabled = false;
      button.textContent = "CONTINUE TO LIVE STAGE";
    }
  });
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
    singerOnlyStyle.textContent = "#mmLiveKitPanel{display:block!important;width:100%!important;max-width:100%!important;margin:8px 0!important;padding:10px!important;background:#151515!important;border:1px solid #9b7628!important;border-radius:10px!important} #mmLiveKitPanel #mmJoinBtn,#mmLiveKitPanel #mmLeaveBtn,#mmLiveKitPanel #mmReactionSection,#mmLiveKitPanel #mmCommentsList,#mmLiveKitPanel #mmCommentInput,#mmLiveKitPanel #mmSendCommentBtn,#mmLiveKitPanel #mmCommentHint{display:none!important} #mmLiveKitPanel #mmMyControls{display:block!important} #mmLiveKitPanel #mmMyControls button{padding:12px 14px!important;font-size:15px!important;font-weight:bold!important;margin:5px 5px 5px 0!important} #mmLiveKitPanel #mmPermissionInfo{margin-top:8px!important;color:#e9bd57!important}";
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
        max-width:940px;
        margin:9px auto;
        padding:10px;
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
        margin:7px 0;
        padding:7px;
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
      <h3>🎙️ Main-stage Microphone Effects</h3>
      <p class="mm-note">Echo, delay and reverb are shared live and applied to every main-stage singer microphone, including duet singers.</p>
      <button id="mmHostMicToggle" type="button" disabled>🎙️ HOST MIC: OFF — RETRY / TURN ON</button>
      <p id="mmHostMicStatus" class="mm-note">Host microphone is starting…</p>
      <div class="mm-effect-control">
        <label>Echo: <strong id="mmEchoValue">0%</strong></label>
        <input id="mmEcho" type="range" min="0" max="100" value="0">
      </div>
      <div class="mm-effect-control">
        <label>Echo delay: <strong id="mmDelayValue">0 ms</strong></label>
        <input id="mmDelay" type="range" min="0" max="1000" value="0">
      </div>
      <div class="mm-effect-control">
        <label>Reverb: <strong id="mmReverbValue">0%</strong></label>
        <input id="mmReverb" type="range" min="0" max="100" value="0">
      </div>
      <div class="mm-effect-control">
        <label><input id="mmHostSingerMonitor" type="checkbox" checked> 🎧 Hear singer's voice on this device</label>
        <p class="mm-note">This only turns singer audio on or off for the host. Audience audio is unchanged. Headphones recommended.</p>
      </div>
      <div class="mm-effect-control">
        <label><input id="mmHostSelfMonitor" type="checkbox"> 🎤 Host Self-Monitor — hear my own microphone</label>
        <p class="mm-note">This plays your raw microphone only in your headphones. Phone-based monitoring can have a small delay. Turn it OFF if you hear an echo. Audience audio is unchanged.</p>
      </div>
      <div class="mm-effect-control">
        <label><input id="mmHostKaraokeMonitor" type="checkbox"> 🎵 Host: hear YouTube karaoke on this device</label>
        <p class="mm-note">Turn this on when the host is singing. It changes only the host's local player audio.</p>
      </div>
      <div class="mm-note">Host can sing solo with HOST MIC, or sing a duet while an assigned singer is on stage. The host microphone is sent to the auditorium.</div>
      <div id="mmEffectsStatus" class="mm-note">Test the sound with your host microphone. These master effects automatically apply to the host and all assigned singers.</div>
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
          Only connected audience viewers are counted. Host and main-stage singers are excluded.
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
  byId("mmHostMicToggle")?.addEventListener("click", toggleMicrophone);
  byId("mmHostSelfMonitor")?.addEventListener("change", event => {
    setHostDirectMonitor(event.target.checked);
  });
  byId("mmCameraBtn").addEventListener("click", toggleCamera);

  // Simple host controls only: echo, delay and reverb.

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
    ["mmEcho", "mmDelay", "mmReverb"].forEach(id => {
      byId(id).addEventListener("input", () => {
        updateAudioControlLabels();
        applySharedAudioSettingsToEffects();
        scheduleSharedAudioSettingsSave();
      });
    });
    byId("mmHostSingerMonitor")?.addEventListener("change", event => {
      setHostSingerMonitor(event.target.checked);
      if (event.target.checked) unlockHostRemoteAudio();
    });
    byId("mmHostKaraokeMonitor")?.addEventListener("change", event => {
      const player = youtubePlayer;
      if (!player) {
        showMessage("Load the YouTube karaoke video first.", "warning");
        event.target.checked = false;
        return;
      }
      try {
        if (event.target.checked) {
          player.unMute();
          player.setVolume(100);
          player.playVideo();
          showMessage("YouTube karaoke audio is ON for the host device.", "success");
        } else {
          player.mute();
          showMessage("YouTube karaoke audio is muted on the host device.", "success");
        }
      } catch (error) {
        showMessage("Could not change host karaoke audio: " + error.message, "error");
      }
    });
  }
}


/* =========================================
   AUTHENTICATION
========================================= */

async function waitForAuth() {
  currentUser = await connectAuditorium();
  return currentUser;
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

  if (["joinHost", "joinSinger", "joinAudience"].includes(data.action)) {
    console.info("[Melody Magic] LiveKit identity diagnostic:", {
      action: data.action,
      workerVersion: result.workerVersion || "missing",
      role: result.role || "missing",
      authenticatedUid: result.authenticatedUid || "missing",
      participantIdentity: result.participantIdentity || "missing",
      singerUid: result.singerUid || "not-applicable",
      showId: showId || "missing"
    });
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
  // The worker checks the entered mobile against the approved show registration.
  if (requestedMode === "singer") {
    if (preauthorizedSingerToken) {
      const token = preauthorizedSingerToken;
      preauthorizedSingerToken = null;
      return token;
    }
    return workerRequest({
      action: "joinSinger",
      mobile: singerMobile,
      ...((singerRegistration?.registrationId || registrationId)
        ? { registrationId: singerRegistration?.registrationId || registrationId }
        : {}),
      name: currentUser.displayName || singerRegistration?.singerName || "Singer"
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

function isCurrentSingerAssignedToStage() {
  return currentRole === "singer" && !!currentUser && stageSingerUids.includes(getSingerParticipantUid());
}

function updateKaraokePlayerAccess() {
  const card = byId("mmYoutubePlayer")?.closest(".card, .mm-card");
  const canView = isHost || isCurrentSingerAssignedToStage();
  if (card) card.style.display = canView ? "" : "none";
  if (!canView && youtubePlayer) {
    try { youtubePlayer.mute(); youtubePlayer.pauseVideo(); } catch (error) {}
  } else if (canView && youtubePlayer && currentRole === "host") {
    try {
      if (byId("mmHostKaraokeMonitor")?.checked) {
        youtubePlayer.unMute();
        youtubePlayer.setVolume(100);
      } else {
        youtubePlayer.mute();
      }
    } catch (error) {}
  }
  const button = byId("mmSingerKaraokeAudioBtn");
  const singerCanPerform = isCurrentSingerAssignedToStage() && microphoneAllowed;
  if (button) button.hidden = !singerCanPerform;
  const monitorWrap = byId("mmSingerMonitorWrap");
  if (monitorWrap) monitorWrap.hidden = !singerCanPerform;
}

function updateActivePerformerKaraokeLayout() {
  const performance = activePerformanceData || {};
  const myUid = safeText(currentUser?.uid);
  const myRegistrationId = safeText(singerRegistration?.id || registrationId);
  const activeRegistrationId = safeText(
    performance.currentPerformerId || performance.registrationId
  );
  const normalizeIdentity = value => safeText(value).trim().toLowerCase().replace(/\\s+/g, " ");
  const myName = normalizeIdentity(singerRegistration?.singerName || singerRegistration?.name);
  const activeName = normalizeIdentity(
    performance.currentPerformerName || performance.singerName || performance.name
  );
  const myMobile = safeText(singerRegistration?.mobile).replace(/\D/g, "").slice(-10);
  const activeMobile = safeText(performance.mobile || performance.singerMobile).replace(/\D/g, "").slice(-10);
  const isSinger = requestedMode === "singer" || currentRole === "singer" || !!singerRegistration;
  const isPerforming = safeText(performance.status || performance.performanceStatus).toLowerCase() === "performing";
  const identityMatches =
    (!!myUid && !!performance.singerUid && performance.singerUid === myUid) ||
    (!!myRegistrationId && !!activeRegistrationId && activeRegistrationId === myRegistrationId) ||
    (!!myName && !!activeName && activeName === myName) ||
    (!!myMobile && !!activeMobile && activeMobile === myMobile);
  const isMyPerformance = isSinger && (stageSingerUids.includes(myUid) || (isPerforming && identityMatches));

  document.body.classList.toggle("mm-active-performer", isMyPerformance);
  updateKaraokePlayerAccess();
  const karaokeCard = document.querySelector("#mmYoutubePlayer")?.closest(".card");
  const heading = karaokeCard?.querySelector("h2");
  if (heading) heading.textContent = isMyPerformance
    ? "🎵 Karaoke — MAIN PERFORMANCE SCREEN"
    : "🎵 Karaoke — Mini Player";
}

function listenToActivePerformerLayout() {
  if (!showId) return;
  onValue(ref(db, "livePerformance/" + showId), snapshot => {
    activePerformanceData = snapshot.val() || {};
    updateActivePerformerKaraokeLayout();
  });
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
    for (const participant of room.remoteParticipants.values()) {
      const identity = safeText(participant.identity);
      let role = "";
      try { role = safeText(JSON.parse(participant.metadata || "{}").role).toLowerCase(); } catch (error) {}
      const isHostParticipant = identity === getHostParticipantUid();
      const isStageSinger = stageSingerUids.includes(identity);
      const isRegisteredSinger = Object.values(registrations || {}).some(item => safeText(item?.singerUid) === identity);
      const isSingerParticipant = role === "singer" || role === "host";
      if (!isHostParticipant && !isStageSinger && !isRegisteredSinger && !isSingerParticipant) count++;
    }
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
            controls: 0,
            disablekb: 1,
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
              if (status) status.textContent = "Karaoke player connected. Waiting for host playback...";
              const enableButton = byId("mmEnableKaraokeSound");
              if (enableButton) {
                enableButton.hidden = true;
                enableButton.onclick = () => {
                  try { event.target.unMute(); event.target.playVideo(); enableButton.hidden = true; }
                  catch (error) { if (status) status.textContent = "Tap the karaoke player to enable sound."; }
                };
              }
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
              if (status) status.textContent = "Tap ENABLE KARAOKE SOUND once to allow synchronized playback.";
              const enableButton = byId("mmEnableKaraokeSound");
              if (enableButton) enableButton.hidden = false;
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

  const syncAt = Number(data.syncAt || data.startedAt || 0);
  const syncPosition = data.syncPosition === undefined ? base : Number(data.syncPosition || 0);
  if (!syncAt) return Math.max(0, base);
  return Math.max(0, syncPosition + (Date.now() - syncAt) / 1000);
}

async function applyPlayback(data) {
  const statusElement = byId("mmPlaybackStatus");
  if (!data) data = {};

  // Each singer and audience device plays the same YouTube video, synchronized through Firebase.

  const videoId = safeText(data.videoId).trim();
  const state = safeText(data.state).toLowerCase();

  const canView = isHost || (requestedMode === "singer" && !!currentUser && stageSingerUids.includes(getSingerParticipantUid()));
  if (!canView) {
    updateKaraokePlayerAccess();
    return;
  }

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

    // Host gets a silent visual preview only. Only the assigned singer hears
    // local YouTube playback; everyone else receives the singer-published mix.
    if (currentRole === "host" || isHost) {
      player.setVolume(0);
      player.mute();
    } else {
      player.setVolume(sharedVolume);
      if (sharedVolume === 0) player.mute();
      else player.unMute();
    }

    const signature = [
      videoId,
      state,
      data.basePosition || 0,
      data.startedAt || 0,
      data.syncPosition || 0,
      data.syncAt || 0,
      data.updatedAt || 0
    ].join("|");

    if (signature === lastPlaybackSignature) return;

    const position = playbackPosition(data);
    const isNewVideo = videoId !== lastYoutubeVideoId;

    if (isNewVideo) lastYoutubeVideoId = videoId;

    // A selected/stopped video must be cued, not loaded (loadVideoById
    // starts playback and can race the player's onReady event).
    if (state !== "playing") clearTimeout(playbackStartTimer);

    if (isNewVideo || state === "stopped" || state === "selected") {
      if (state === "playing") {
        player.cueVideoById({ videoId, startSeconds: position });
        clearTimeout(playbackStartTimer);
        const playAt = Number(data.startedAt || Date.now());
        playbackStartTimer = setTimeout(() => {
          if (!youtubePlayer) return;
          const target = playbackPosition(data);
          const current = youtubePlayer.getCurrentTime?.() || 0;
          if (Math.abs(current - target) > 1) youtubePlayer.seekTo(target, true);
          youtubePlayer.playVideo();
        }, Math.max(0, playAt - Date.now()));
      } else {
        player.cueVideoById({ videoId, startSeconds: position });
      }
    } else if (state === "playing") {
      const currentTime = typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0;
      if (Math.abs(currentTime - position) > 2.5) player.seekTo(position, true);
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


function getSingerYouTubeVideoId(value) {
  const input = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be" || url.hostname.endsWith(".youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    if (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.findIndex(part => ["embed", "shorts", "live"].includes(part));
      if (index >= 0) return parts[index + 1] || "";
    }
  } catch (error) {}
  return "";
}

function listenToSingerKaraokeVideo() {
  if (!showId || !currentUser || requestedMode !== "singer" || !singerMobile) return;
  // Read only this singer's record. The host writes each command at
  // singerKaraoke/{showId}/{singerUid}; reading the whole show node
  // requires broader permissions and is correctly denied by Firebase.
  const singerUid = getSingerParticipantUid();
  if (!singerUid) return;
  const singerVideoRef = ref(db, "singerKaraoke/" + showId + "/" + singerUid);
  if (singerKaraokeListener) off(singerVideoRef, "value", singerKaraokeListener);
  let lastSingerCommandAt = 0;
  let singerKaraokeCurrentVolume = 100;
  singerKaraokeListener = snapshot => {
    const data = snapshot.val() || {};
    const videoId = safeText(data.videoId).trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
    const sharedVolume = Math.max(0, Math.min(100, Number(data.volume === undefined ? 100 : data.volume)));
    singerKaraokeCurrentVolume = sharedVolume;
    if (youtubePlayer && lastYoutubeVideoId === videoId && typeof youtubePlayer.setVolume === "function") {
      try { youtubePlayer.setVolume(sharedVolume); if (sharedVolume === 0) youtubePlayer.mute(); else youtubePlayer.unMute(); } catch (error) {}
    }
    const commandAt = Number(data.commandAt || 0);
    if (commandAt > lastSingerCommandAt) {
      lastSingerCommandAt = commandAt;
      if (youtubePlayer && lastYoutubeVideoId === videoId) {
        const command = safeText(data.command).toLowerCase();
        if (command === "pause") {
          try { youtubePlayer.pauseVideo(); } catch (error) {}
          const playbackStatus = byId("mmPlaybackStatus");
          if (playbackStatus) playbackStatus.textContent = "The host paused your karaoke video.";
        } else if (command === "stop") {
          try { youtubePlayer.stopVideo(); } catch (error) {}
          const playbackStatus = byId("mmPlaybackStatus");
          if (playbackStatus) playbackStatus.textContent = "The host stopped your karaoke video.";
        }
      }
    }
    const notice = byId("mmSingerSentVideo");
    if (!notice) return;
    notice.replaceChildren();
    const label = document.createElement("strong");
    label.textContent = "🎵 The host sent you a karaoke video. ";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "OPEN VIDEO ON MY STAGE";
    openButton.style.cssText = "padding:9px 11px;margin:6px;border-radius:7px;border:1px solid #b58a35;background:#292319;color:#fff";
    openButton.addEventListener("click", async () => {
      openButton.disabled = true;
      try {
        const player = await createYouTubePlayer(videoId);
        if (!player) throw new Error("YouTube player is not ready.");
        lastYoutubeVideoId = videoId;
        lastPlaybackSignature = "";
        player.loadVideoById(videoId);
        const initialVolume = Math.max(0, Math.min(100, Number(singerKaraokeCurrentVolume ?? 100)));
        player.setVolume(initialVolume);
        if (initialVolume === 0) player.mute(); else player.unMute();
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Host's karaoke video opened on your singer stage.";
      } catch (error) {
        const status = byId("mmPlaybackStatus");
        if (status) status.textContent = "Could not open host video: " + error.message;
      } finally {
        openButton.disabled = false;
      }
    });
    notice.append(label, openButton);
    const videoNotice = byId("mmSingerVideoNotice");
    if (videoNotice) videoNotice.textContent = "New karaoke video received from the host.";
  };
  onValue(singerVideoRef, singerKaraokeListener, error => {
    console.error("Singer karaoke video listener error:", error);
    const status = byId("mmSingerVideoNotice");
    if (status) status.textContent = "Could not receive host video: " + error.message;
  });
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
    updateActivePerformerKaraokeLayout();

    if (!["host", "singer", "audience"].includes(currentRole)) {
      throw new Error("Invalid auditorium role returned by server.");
    }
    if (requestedMode === "singer" && currentRole !== "singer") {
      throw new Error("Singer access was not confirmed.");
    }
    if (!isHost && requestedMode !== "singer" && currentRole !== "audience") {
      throw new Error("Audience access was not confirmed.");
    }

    microphoneAllowed = currentRole === "host" ? true : false;
    cameraAllowed = currentRole === "host" ? true : false;
    if (currentRole === "singer") {
      microphoneAllowed = tokenData.microphoneAllowed === true;
      cameraAllowed = tokenData.cameraAllowed === true;
    }
    if (currentRole === "audience") {
      microphoneAllowed = false;
      cameraAllowed = false;
    }

    const performer = currentRole === "host" || currentRole === "singer";
    if (byId("mmMyControls")) byId("mmMyControls").hidden = currentRole !== "singer";
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
      try {
        await room.localParticipant.setCameraEnabled(true);
        localCameraEnabled = true;
      } catch (cameraError) {
        localCameraEnabled = false;
        showMessage("Host connected, but camera permission is needed: " + cameraError.message, "warning");
      }
      try {
        await startMicrophoneEffects();
      } catch (micError) {
        localMicEnabled = false;
        showMessage("Host connected, but microphone could not start: " + micError.message, "warning");
      }
      updateControlButtons();
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
    updateParticipantGalleryVisibility();

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
      // Karaoke is synchronized through each viewer's YouTube player and Firebase.
      // Shared karaoke tab audio must be received and played by singers/audience.
      // Only skip the video screen-share track; suppressing ScreenShareAudio made karaoke silent.
      if (source === Track.Source.ScreenShare) return;
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

  room.on(RoomEvent.Disconnected, reason => {
    console.error("[Melody Magic] LiveKit disconnected:", {
      reason: reason || "no reason supplied",
      mode: requestedMode,
      role: currentRole,
      identity: room?.localParticipant?.identity || "unknown",
      showId: showId || "missing"
    });
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
       identity === getHostParticipantUid() &&
       identity !== safeText(currentUser?.uid))
    : ((isLocal && currentRole === "host") ||
       (!isLocal &&
        !!currentShow?.hostUid &&
        identity === getHostParticipantUid()));

  // A remote singer is visible to the host only when they have an
  // approved registration for THIS show and have actually connected
  // to this show's LiveKit room. Approval alone never creates a tile.
  const isRegisteredForThisShow = Object.values(registrations || {}).some(item =>
    safeText(item?.singerUid) === identity && isApproved(item?.status)
  );
  const isSingerParticipant =
    (isLocal && currentRole === "singer") ||
    (!isLocal && isRegisteredForThisShow);

  // Never show audience, unapproved singers, or singers registered
  // only for another show in the performers gallery.
  if (!isHostParticipant && !isSingerParticipant) {
    removeParticipantTile(identity);
    return;
  }

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
  updateParticipantGalleryVisibility();

  const isOnMainStage = stageSingerUids.includes(identity);
  tile.classList.toggle("mm-main-stage", isOnMainStage);
  tile.classList.toggle("mm-waiting-stage", !isOnMainStage && !isHostParticipant);

  if (participant.trackPublications) {
    participant.trackPublications.forEach(publication => {
      if (
        publication.track &&
        publication.source !== Track.Source.ScreenShare &&
        publication.source !== Track.Source.ScreenShareAudio
      ) {
        attachTrackToTile(
          publication.track,
          tileId + "_media",
          !isLocal
        );
      }
    });
  }
}

async function attachRemoteTrack(track, participant) {
  await createVideoTile(participant, false);
  attachTrackToTile(track, getTileId(participant.identity) + "_media", true);
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

function setHostSingerMonitor(enabled) {
  hostSingerMonitorEnabled = Boolean(enabled);
  // Keep incoming tracks playing; toggle mute/volume rather than pause.
  document.querySelectorAll('audio[data-mm-remote-singer-audio="true"]').forEach(element => {
    element.muted = !hostSingerMonitorEnabled;
    element.volume = hostSingerMonitorEnabled ? 1 : 0;
    if (hostSingerMonitorEnabled) {
      element.autoplay = true;
      element.playsInline = true;
      const playResult = element.play?.();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(error => {
          console.warn("[Melody Magic] Host singer audio playback blocked:", error);
          showMessage("Host audio playback blocked. Tap the page once, then turn the singer audio checkbox ON again.", "warning");
        });
      }
    }
  });
}

function unlockHostRemoteAudio() {
  if (currentRole !== "host" || !hostSingerMonitorEnabled) return;
  document.querySelectorAll('audio[data-mm-remote-singer-audio="true"]').forEach(element => {
    element.muted = false;
    element.volume = 1;
    const playResult = element.play?.();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(error => console.warn("[Melody Magic] Host audio unlock failed:", error));
    }
  });
}
function attachTrackToTile(track, targetId, isRemote = false) {
  const target = byId(targetId);
  if (!track) return;

  if (track.kind === Track.Kind.Audio) {
    // Never attach our own published microphone back to our speakers/headphones.
    // The singer's optional WebAudio monitor is the only local mic preview.
    if (!isRemote) return;
    // Ignore legacy mixed programme track to avoid duplicate audio.
    if (track.name === "Melody Magic Programme Audio") return;

    // Remote audio must not live inside a video tile/section that is hidden
    // when the participant has no camera. Keep a dedicated always-present sink.
    let audioSink = byId("mmRemoteAudioSink");
    if (!audioSink) {
      audioSink = document.createElement("div");
      audioSink.id = "mmRemoteAudioSink";
      audioSink.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden";
      document.body.appendChild(audioSink);
    }
    const attached = track.attach();
    const elements = Array.isArray(attached) ? attached : [attached];
    elements.forEach(element => {
      if (!element) return;
      element.autoplay = true;
      element.controls = false;
      element.dataset.mmRemoteAudioTrack = track.sid || track.name || "remote";
      if (currentRole === "host") {
        element.dataset.mmRemoteSingerAudio = "true";
        element.muted = !hostSingerMonitorEnabled;
        element.volume = hostSingerMonitorEnabled ? 1 : 0;
      } else {
        element.muted = false;
        element.volume = 1;
      }
      if (!audioSink.contains(element)) audioSink.appendChild(element);
      const playResult = element.play?.();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => showMessage("Tap the page once to enable live audio playback.", "warning"));
      }
    });
    return;
  }

  if (!target) return;
  const attached = track.attach();
  const elements = Array.isArray(attached) ? attached : [attached];
  elements.forEach(element => {
    if (!element) return;
    element.style.width = "100%";
    if (track.kind === Track.Kind.Video) {
      element.style.maxHeight = "360px";
      element.autoplay = true;
      element.playsInline = true;
    }
    if (!target.contains(element)) target.appendChild(element);
    updateParticipantGalleryVisibility();
    const playResult = element.play?.();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => showMessage("Your browser may require a click to start live video.", "warning"));
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
    updateParticipantGalleryVisibility();

  } catch (error) {
    console.warn("Track detach error:", error);
  }
}

function removeParticipantTile(identity) {
  const tile = byId(getTileId(identity));
  if (tile) tile.remove();
  updateParticipantGalleryVisibility();
}

function updateParticipantGalleryVisibility() {
  ["mmHostVideoGrid", "mmVideoGrid"].forEach(id => {
    const grid = byId(id);
    if (!grid) return;
    const section = grid.closest(".mm-section, .card");
    const hasCamera = !!grid.querySelector(".mm-video-box video");
    if (section) section.hidden = !hasCamera;
  });
}


/* =========================================
   SHARED AUDITORIUM AUDIO SETTINGS
   Stored inside karaokePlayback so the existing
   host write / singer read path and rules are reused.
========================================= */

function normalizeSharedAudioSettings(value = {}) {
  return {
    echo: Math.max(0, Math.min(100, Number(value.echo ?? 0))),
    delay: Math.max(0, Math.min(1000, Number(value.delay ?? 0))),
    feedback: 0,
    reverb: Math.max(0, Math.min(100, Number(value.reverb ?? 0))),
    mix: 0,
    volume: 80
  };
}

function updateAudioControlLabels() {
  const values = {
    mmEchoValue: [byId("mmEcho")?.value, "%"],
    mmDelayValue: [byId("mmDelay")?.value, " ms"],
    mmReverbValue: [byId("mmReverb")?.value, "%"]
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
    reverb: byId("mmReverb")?.value
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
    ["mmReverb", sharedAudioSettings.reverb]
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
          "Master microphone effects are live for the host and all assigned singers.";
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

function stopHostDirectMonitor() {
  if (!hostDirectMonitorElement) return;
  try {
    hostDirectMonitorElement.pause();
    hostDirectMonitorElement.srcObject = null;
    hostDirectMonitorElement.remove();
  } catch (error) {}
  hostDirectMonitorElement = null;
}

function setupHostDirectMonitor(track) {
  stopHostDirectMonitor();
  if (!track || currentRole !== "host" || !IS_HOST_CONTROL_PAGE) return;
  const audio = document.createElement("audio");
  audio.id = "mmHostDirectMonitorAudio";
  audio.autoplay = false;
  audio.playsInline = true;
  audio.controls = false;
  audio.volume = 0.35;
  audio.muted = true;
  audio.srcObject = new MediaStream([track]);
  audio.style.display = "none";
  document.body.appendChild(audio);
  hostDirectMonitorElement = audio;
  if (byId("mmHostSelfMonitor")) byId("mmHostSelfMonitor").checked = false;
}

function setHostDirectMonitor(enabled) {
  if (!hostDirectMonitorElement) {
    if (enabled) showMessage("Turn on HOST MIC first, then enable Host Self-Monitor.", "warning");
    return;
  }
  hostDirectMonitorElement.muted = !Boolean(enabled);
  if (enabled) {
    const playPromise = hostDirectMonitorElement.play();
    if (playPromise?.catch) playPromise.catch(error => {
      console.warn("Host self-monitor playback failed:", error);
      const control = byId("mmHostSelfMonitor");
      if (control) control.checked = false;
      hostDirectMonitorElement.muted = true;
      showMessage("Could not start host headphone monitoring. Tap the checkbox again.", "warning");
    });
  } else {
    hostDirectMonitorElement.pause();
  }
}

function canProcessMicrophoneAudio() {
  return isJoined && (
    (currentRole === "host" && isHost && IS_HOST_CONTROL_PAGE) ||
    (currentRole === "singer" && microphoneAllowed)
  );
}

function hostCanUseAudioEffects() {
  return isJoined && currentRole === "host" && isHost && IS_HOST_CONTROL_PAGE;
}

async function startSingerKaraokeAudio() {
  if (!isCurrentSingerAssignedToStage() || !microphoneAllowed || !room || !isJoined) {
    throw new Error("Wait until the host assigns you to the main stage and grants microphone permission.");
  }
  if (publishedMicrophoneTrack) return;

  // Mobile browsers cannot reliably share tab audio. Publish the singer's
  // microphone directly on phones; desktop can still send mic + tab audio.
  const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobileBrowser || !navigator.mediaDevices?.getDisplayMedia) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not supported by this browser.");
    }
    let mobileMicStream = null;
    try {
      mobileMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.01 } },
        video: false
      });
      const micTrack = mobileMicStream.getAudioTracks()[0];
      if (!micTrack) throw new Error("No microphone was found.");
      audioEffects = new VirtualAudioEffects();
      const processedMicTrack = await audioEffects.start(micTrack);
      applySharedAudioSettingsToEffects();
      audioEffects.setMonitor(Boolean(byId("mmSingerMonitor")?.checked), 30);
      // Enable the processed audio track before publishing; effects start muted by default.
      audioEffects.setMuted(false);
      await room.localParticipant.publishTrack(processedMicTrack, {
        name: "Melody Magic Singer Mobile Microphone",
        source: Track.Source.Microphone
      });
      singerKaraokeCaptureStream = new MediaStream([micTrack]);
      singerKaraokeAudioContext = null;
      singerKaraokeMixTrack = processedMicTrack;
      rawMicrophoneTrack = micTrack;
      processedMicrophoneTrack = processedMicTrack;
      publishedMicrophoneTrack = processedMicTrack;
      localMicEnabled = true;
      updateControlButtons();
      const button = byId("mmSingerKaraokeAudioBtn");
      if (button) button.textContent = "■ Stop singer microphone";
      showMessage("Your phone microphone is live. Karaoke audio is supplied separately.", "success");
      return;
    } catch (error) {
      if (audioEffects) { audioEffects.stop(); audioEffects = null; }
      if (mobileMicStream) mobileMicStream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported by this browser.");
  }
  let displayStream = null;
  let micStream = null;
  let mixContext = null;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const tabAudio = displayStream.getAudioTracks()[0];
    if (!tabAudio) throw new Error("No tab audio was shared. Select This Tab and tick Share tab audio.");
    displayStream.getVideoTracks().forEach(track => track.stop());
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    const micTrack = micStream.getAudioTracks()[0];
    if (!micTrack) throw new Error("No microphone was found.");

    audioEffects = new VirtualAudioEffects();
    const processedMicTrack = await audioEffects.start(micTrack);
    applySharedAudioSettingsToEffects();
    audioEffects.setMonitor(Boolean(byId("mmSingerMonitor")?.checked), 30);
    // Enable the processed audio track before mixing/publishing; effects start muted by default.
    audioEffects.setMuted(false);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not supported in this browser.");
    mixContext = new AudioContextClass();
    await mixContext.resume();
    const destination = mixContext.createMediaStreamDestination();
    const karaokeSource = mixContext.createMediaStreamSource(new MediaStream([tabAudio]));
    const micSource = mixContext.createMediaStreamSource(new MediaStream([processedMicTrack]));
    const karaokeGain = mixContext.createGain();
    const micGain = mixContext.createGain();
    karaokeGain.gain.value = 0.85;
    micGain.gain.value = 1;
    karaokeSource.connect(karaokeGain).connect(destination);
    micSource.connect(micGain).connect(destination);
    const mixedTrack = destination.stream.getAudioTracks()[0];
    await room.localParticipant.publishTrack(mixedTrack, {
      name: "Melody Magic Singer Microphone + Karaoke Mix",
      source: Track.Source.Microphone
    });
    singerKaraokeCaptureStream = new MediaStream([tabAudio, micTrack]);
    singerKaraokeAudioContext = mixContext;
    singerKaraokeMixTrack = mixedTrack;
    rawMicrophoneTrack = micTrack;
    processedMicrophoneTrack = processedMicTrack;
    publishedMicrophoneTrack = mixedTrack;
    localMicEnabled = true;
    tabAudio.addEventListener("ended", () => {
      if (localMicEnabled && currentRole === "singer") stopMicrophoneEffects();
    }, { once: true });
    updateControlButtons();
    const button = byId("mmSingerKaraokeAudioBtn");
    if (button) button.textContent = "■ Stop microphone + karaoke audio";
    showMessage("Your microphone and karaoke audio are live with the host's shared effects.", "success");
  } catch (error) {
    if (mixContext) { try { await mixContext.close(); } catch (e) {} }
    if (audioEffects) { audioEffects.stop(); audioEffects = null; }
    if (displayStream) displayStream.getTracks().forEach(track => track.stop());
    if (micStream) micStream.getTracks().forEach(track => track.stop());
    throw error;
  }
}

async function startMicrophoneEffects() {
  if (!canProcessMicrophoneAudio()) throw new Error("Microphone access is not currently permitted.");
  if (!microphoneAllowed) throw new Error("The host has not granted microphone permission.");
  if (!room || !isJoined) throw new Error("Join the auditorium first.");
  if (publishedMicrophoneTrack) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not supported.");

  // Publish the browser microphone track directly: no app-added echo, reverb,
  // delay, or Web Audio effects graph is placed in the voice path.
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
    stream.getTracks().forEach(track => track.stop());
    throw new Error("No microphone was found.");
  }

  await room.localParticipant.publishTrack(rawMicrophoneTrack, {
    name: currentRole === "host"
      ? "Melody Magic Host Raw Microphone"
      : "Melody Magic Singer Raw Microphone",
    source: Track.Source.Microphone
  });

  publishedMicrophoneTrack = rawMicrophoneTrack;
  processedMicrophoneTrack = null;
  audioEffects = null;
  if (currentRole === "host") setupHostDirectMonitor(rawMicrophoneTrack);
  localMicEnabled = true;
  if (byId("mmEffectsStatus")) {
    byId("mmEffectsStatus").textContent =
      "Raw microphone is live. Echo, reverb and delay are disabled.";
  }
  updateControlButtons();
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
  stopHostDirectMonitor();
  processedMicrophoneTrack = null;
  if (singerKaraokeCaptureStream) {
    singerKaraokeCaptureStream.getTracks().forEach(track => { try { track.stop(); } catch (error) {} });
    singerKaraokeCaptureStream = null;
  }
  if (singerKaraokeAudioContext) {
    try { await singerKaraokeAudioContext.close(); } catch (error) {}
    singerKaraokeAudioContext = null;
  }
  singerKaraokeMixTrack = null;
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

    if (currentRole === "singer") {
      await startSingerKaraokeAudio();
    } else if (currentRole === "host") {
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
  const hostMic = byId("mmHostMicToggle");
  const hostMicStatus = byId("mmHostMicStatus");

  if (mic) {
    mic.disabled = !isJoined || !microphoneAllowed ||
      (currentRole === "host" && IS_HOST_CONTROL_PAGE);
    mic.textContent = currentRole === "host" && IS_HOST_CONTROL_PAGE
      ? "Use Host Mic button below"
      : (localMicEnabled ? "Microphone ON" : "Microphone OFF");
  }
  if (camera) {
    camera.disabled = !isJoined || !cameraAllowed;
    camera.textContent = localCameraEnabled ? "Camera ON" : "Camera OFF";
  }

  if (hostMic) {
    const isHostControl = currentRole === "host" && IS_HOST_CONTROL_PAGE;
    hostMic.hidden = !isHostControl;
    hostMic.disabled = !isJoined || !isHostControl || !microphoneAllowed;
    hostMic.textContent = localMicEnabled
      ? "🎙️ HOST MIC: ON — TURN OFF"
      : "🎙️ HOST MIC: OFF — TAP TO TURN ON";
    if (hostMicStatus && isHostControl) {
      hostMicStatus.textContent = !microphoneAllowed
        ? "Host microphone permission is not enabled for this account."
        : localMicEnabled
          ? "Host microphone is LIVE and published to the auditorium."
          : "Host microphone is OFF. Tap the button above to start it.";
    }
  }

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

  // Read permissions by the exact LiveKit singer identity.
  // A mobile-number query can return a stale/other registration record and
  // prevent camera/microphone changes from reaching the correct singer.
  const permissionRef = ref(
    db,
    "participantControls/" + showId + "/" + getSingerParticipantUid()
  );

  if (permissionListener) {
    off(permissionRef, "value", permissionListener);
  }

  permissionListener = snapshot => {
    // This reference already points to this singer's exact UID record.
    // Do not iterate its fields as though it were a list of singers.
    const controls = snapshot.val() || {};

    if (currentRole !== "singer") {
      microphoneAllowed = false;
      cameraAllowed = false;
      updateControlButtons();
      return;
    }

    if (controls.blocked === true) {
      microphoneAllowed = false;
      cameraAllowed = false;
      showMessage("The host has blocked your access to this show.", "error");
      leaveAuditorium();
      return;
    }

    const selected =
      stageSingerUids.includes(getSingerParticipantUid());

    microphoneAllowed = selected && controls.microphoneAllowed === true;
    cameraAllowed = controls.cameraAllowed !== false;
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
  if (currentRole !== "singer") return;
  updateKaraokePlayerAccess();
  if (isCurrentSingerAssignedToStage() && microphoneAllowed && !localMicEnabled) {
    const button = byId("mmSingerKaraokeAudioBtn");
    if (button) button.hidden = false;
    showMessage("You are on the main stage. Press START MIC + KARAOKE AUDIO and share this Chrome tab with audio.");
  }
}

async function enforceCurrentPermissions() {
  if (!room) return;

  if (!microphoneAllowed && localMicEnabled) {
    await stopMicrophoneEffects();
  }

  if (!cameraAllowed && localCameraEnabled) {
    try {
      await room.localParticipant.setCameraEnabled(false);
    } catch (error) {
      console.warn("Could not turn off singer camera:", error);
    }
    localCameraEnabled = false;
  } else if (cameraAllowed && !localCameraEnabled && currentRole === "singer" && isJoined) {
    try {
      await room.localParticipant.setCameraEnabled(true);
      localCameraEnabled = true;
    } catch (error) {
      console.warn("Could not turn on singer camera:", error);
    }
  }

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

    // Add newly assigned singers that were already connected before stage assignment.
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        if (stageSingerUids.includes(safeText(participant.identity))) {
          createVideoTile(participant, false);
        }
      }
    }

    // Reclassify existing camera tiles when the host changes the main stage.
    document.querySelectorAll(".mm-video-box[data-participant-identity]").forEach(tile => {
      const identity = tile.dataset.participantIdentity || "";
      const isHostTile = tile.id === getTileId(getHostParticipantUid());
      const selected = stageSingerUids.includes(identity);
      tile.classList.toggle("mm-main-stage", selected);
      tile.classList.toggle("mm-waiting-stage", !selected && !isHostTile);
    });

    updateActivePerformerKaraokeLayout();
    updateKaraokePlayerAccess();

    if (currentRole === "singer" && currentUser) {
      const selected = stageSingerUids.includes(getSingerParticipantUid());

      if (!selected) {
        microphoneAllowed = false;
      }
      // When selected, microphone permission comes from the singer's own controls listener.
      // Camera permission is controlled by participantControls, not stage assignment.
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
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        createVideoTile(participant, false);
      }
    }
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
    const cameraOn = controls.cameraAllowed !== false;
    const blocked = controls.blocked === true;
    const selected = stageSingerUids.includes(item.singerUid);

    const card = document.createElement("div");
    card.className = "mm-singer-control";

    const name = document.createElement("strong");
    name.textContent =
      item.singerName || item.name || "Singer";

    const status = document.createElement("div");
    status.className = "mm-permission-status";

    status.textContent =
      (blocked ? "BLOCKED" : (selected ? "On main stage" : "Waiting in queue")) +
      " | Microphone: " + (micOn ? "ON" : "OFF") +
      " | Camera: " + (cameraOn ? "ON" : "OFF");

    const micButton = document.createElement("button");

    micButton.textContent = micOn ? "Mute Mic" : "Unmute Mic";
    micButton.disabled = blocked || !selected;
    micButton.addEventListener("click", () => {
      changeSingerPermission(item.singerUid, !micOn, cameraOn);
    });

    const cameraButton = document.createElement("button");
    cameraButton.textContent = cameraOn ? "Turn Camera OFF" : "Turn Camera ON";
    cameraButton.disabled = blocked;
    cameraButton.addEventListener("click", () => {
      changeSingerPermission(item.singerUid, micOn, !cameraOn);
    });

    const blockButton = document.createElement("button");
    blockButton.textContent = blocked ? "Blocked" : "Block Singer";
    blockButton.disabled = blocked;
    blockButton.addEventListener("click", async () => {
      if (!confirm("Block this singer from the show?")) return;
      try {
        await workerRequest({
          action: "syncPermissions",
          uid: item.singerUid,
          microphoneAllowed: false,
          cameraAllowed: false,
          blocked: true
        });
        showMessage("Singer blocked from this show.", "success");
      } catch (error) {
        console.error("Block singer error:", error);
        showMessage("Could not block singer: " + error.message, "error");
      }
    });

    card.append(name, status, micButton, cameraButton, blockButton);
    container.appendChild(card);
  });
}


/* =========================================
   HOST: CHANGE SINGER MICROPHONE PERMISSION
========================================= */

async function changeSingerPermission(singerUid, microphone, camera) {
  if (!isHost || !IS_HOST_CONTROL_PAGE || !isJoined) {
    showMessage("Only the verified host can change permissions.", "error");
    return;
  }

  try {
    await workerRequest({
      action: "syncPermissions",
      uid: singerUid,
      microphoneAllowed: microphone === true,
      cameraAllowed: camera === true
    });

    showMessage("Singer microphone/camera permission updated.", "success");
  } catch (error) {
    console.error("Permission update error:", error);
    showMessage("Could not update singer permission: " + error.message, "error");
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
      ref(db, "participantControls/" + showId + "/" + getSingerParticipantUid()),
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

  if (singerRegistrationListener && showId) {
    off(ref(db, "showRegistrations/" + showId), "value", singerRegistrationListener);
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

function wireSingerKaraokeAudioButton() {
  const monitor = byId("mmSingerMonitor");
  if (monitor && monitor.dataset.mmWired !== "true") {
    monitor.dataset.mmWired = "true";
    monitor.addEventListener("change", () => {
      if (audioEffects && currentRole === "singer") {
        audioEffects.setMonitor(monitor.checked, 30);
      }
    });
  }

  const button = byId("mmSingerKaraokeAudioBtn");
  if (!button || button.dataset.mmWired === "true") return;
  button.dataset.mmWired = "true";
  button.hidden = true;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (localMicEnabled) {
        await stopMicrophoneEffects();
        button.textContent = "🎤 START MIC + KARAOKE AUDIO";
        showMessage("Singer microphone and karaoke audio stopped.");
      } else {
        button.textContent = "Starting audio...";
        await startSingerKaraokeAudio();
      }
    } catch (error) {
      button.textContent = "🎤 START MIC + KARAOKE AUDIO";
      showMessage("Could not start singer audio: " + error.message, "error");
    } finally {
      button.disabled = false;
      updateKaraokePlayerAccess();
    }
  });
}

/* =========================================
   INITIALIZE
========================================= */

async function initializeShow() {
  createPanel();
  wirePublicInteractionControls();
  wireSingerKaraokeAudioButton();
  wireSingerMobileEntry();
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

  // Show the singer's mobile entry immediately. Do not make the
  // entry form wait for Firebase authentication or show loading.
  if (requestedMode === "singer") {
    showSingerMobileEntry("Preparing singer entry...");
  }

  try {
    await waitForAuth();
    await loadShow();

    isHost = await verifyHost();

    if (!isHost && requestedMode === "singer") {
      let savedMobile = "";
      try { savedMobile = localStorage.getItem("mmSingerMobile:" + showId) || ""; } catch (error) {}
      if (savedMobile) {
        try {
          await activateSingerMobileRegistration(savedMobile);
        } catch (error) {
          try { localStorage.removeItem("mmSingerMobile:" + showId); } catch (removeError) {}
          showSingerMobileEntry(error.message || "Please enter your registered mobile number.");
        }
      } else {
        showSingerMobileEntry();
      }
    }

    // Singers receive their private host-sent video only. Audience members
    // continue to receive the public/shared karaoke playback listener.
    if (isHost || requestedMode === "audience") listenToKaraokePlayback();
    if (requestedMode === "singer") listenToSingerKaraokeVideo();

    if (byId("mmHostControls")) {
      byId("mmHostControls").hidden = true;
    }

    if (byId("mmAudioEffects")) {
      byId("mmAudioEffects").hidden = true;
    }

    if (isHost) {
      byId("mmRoleInfo").textContent =
        IS_HOST_CONTROL_PAGE
          ? "Host verified. Connecting directly to your live auditorium..."
          : "Host account detected. Host controls are available only in the Host Control Room.";

      if (IS_HOST_CONTROL_PAGE) {
        const joinRow = byId("mmJoinBtn")?.parentElement;
        if (joinRow) joinRow.hidden = true;
        showMessage("Host verified. Connecting directly to the auditorium...");
        joinAuditorium();
      } else {
        showMessage("Host controls are available in the Host Control Room.");
      }

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
    listenToActivePerformerLayout();
    if (requestedMode === "singer" && singerRegistration) {
      listenToShowLifecycle();
      setSingerVisibleStatus(
        "Waiting for host",
        "Your registration is approved. You will join automatically when the host starts this show."
      );
    }

  } catch (error) {
    console.error("Initialization error:", error);

    const errorMessage = error?.message || "Unable to initialize auditorium.";

    showMessage(errorMessage, "error");

    if (requestedMode === "singer") {
      setSingerVisibleStatus(
        "Connection setup failed",
        errorMessage + " Please refresh the page and try again."
      );
      const mobilePanel = byId("mmSingerMobileEntry");
      if (mobilePanel && !singerRegistration) {
        showSingerMobileEntry(errorMessage);
      }
    }

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
