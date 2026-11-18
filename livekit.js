
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

let joining = false;
let leaving = false;

let lastReactionTimes = [];

let audioEffects = null;
let rawMicrophoneTrack = null;
let processedMicrophoneTrack = null;
let publishedMicrophoneTrack = null;

const MIC_OFF_MESSAGE =
  "Your microphone is OFF until the host grants permission.";

const CAMERA_OFF_MESSAGE =
  "Your camera is OFF until you enable it.";


/* =========================================
   VIRTUAL AUDIO EFFECTS
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
    this.muted = true;
  }

  async start(inputTrack) {
    this.stop();

    this.context = new AudioContext();

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

    this.delay = this.context.createDelay(2);
    this.delay.delayTime.value = 0.28;

    this.feedback = this.context.createGain();
    this.feedback.gain.value = 0.20;

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

    this.setMuted(true);

    return this.processedTrack;
  }

  createReverbImpulse(duration, decay) {
    const rate = this.context.sampleRate;
    const length = Math.floor(rate * duration);

    const impulse = this.context.createBuffer(
      2,
      length,
      rate
    );

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
    this.muted = Boolean(muted);

    if (this.processedTrack) {
      this.processedTrack.enabled = !this.muted;
    }
  }

  setEcho(value) {
    if (!this.echoGain || !this.feedback) return;

    const amount =
      Math.max(0, Math.min(100, Number(value))) / 100;

    this.echoGain.gain.setTargetAtTime(
      amount * 0.6,
      this.context.currentTime,
      0.03
    );

    this.feedback.gain.setTargetAtTime(
      0.10 + amount * 0.35,
      this.context.currentTime,
      0.03
    );
  }

  setReverb(value) {
    if (!this.reverbGain) return;

    const amount =
      Math.max(0, Math.min(100, Number(value))) / 100;

    this.reverbGain.gain.setTargetAtTime(
      amount * 0.6,
      this.context.currentTime,
      0.03
    );
  }

  setMix(value) {
    if (!this.dryGain || !this.wetGain) return;

    const mix =
      Math.max(0, Math.min(100, Number(value))) / 100;

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
    if (!this.outputGain) return;

    const volume =
      Math.max(0, Math.min(100, Number(value))) / 100;

    this.outputGain.gain.setTargetAtTime(
      volume,
      this.context.currentTime,
      0.03
    );
  }

  async setMonitor(enabled) {
    this.monitorEnabled = Boolean(enabled);

    if (!this.monitorGain) return;

    this.monitorGain.gain.setTargetAtTime(
      this.monitorEnabled ? 0.35 : 0,
      this.context.currentTime,
      0.03
    );
  }

  setMonitorVolume(value) {
    if (!this.monitorGain) return;

    this.monitorGain.gain.setTargetAtTime(
      Math.max(0, Math.min(100, Number(value))) / 100,
      this.context.currentTime,
      0.03
    );
  }

  stop() {
    if (this.processedTrack) {
      this.processedTrack.stop();
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


/* =========================================
   CREATE LIVEKIT PANEL
========================================= */

function createPanel() {
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
        min-height:75px;
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

      @media(max-width:600px) {
        #mmLiveKitPanel {
          padding:12px;
        }

        #mmLiveKitPanel .mm-reaction-button {
          min-width:45px;
          min-height:44px;
          font-size:23px;
        }
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

    <div class="mm-section">
      <h3>My Controls</h3>
      <button id="mmMicBtn" disabled>Microphone OFF</button>
      <button id="mmCameraBtn" disabled>Camera OFF</button>
      <div id="mmPermissionInfo" class="mm-note">
        ${MIC_OFF_MESSAGE}
      </div>
    </div>

    <div class="mm-section" id="mmAudioEffects">
      <h3>🎚️ Microphone Audio Effects</h3>

      <div class="mm-note">
        These effects process your microphone before it is sent to the auditorium.
        Use headphones if monitoring your own voice.
      </div>

      <div class="mm-effect-control">
        <label>Echo: <strong id="mmEchoValue">0%</strong></label>
        <input id="mmEcho" type="range" min="0" max="100" value="0">
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
        <div class="mm-note">
          Headphones recommended. Speakers can cause feedback.
        </div>
      </div>

      <div id="mmEffectsStatus" class="mm-note">
        Effects will activate when you enable your microphone.
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

      <div class="mm-note">
        Share your appreciation with everyone in the live auditorium.
      </div>

      <div id="mmReactionOverlay" aria-live="polite">
        <span class="mm-note">Live reactions will appear here.</span>
      </div>

      <div id="mmReactionHint" class="mm-note">
        Enter the auditorium to send and receive reactions.
      </div>
    </div>

    <div id="mmHostControls" class="mm-section" hidden>
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
        Assigning the stage does not automatically turn on the singer's microphone.
        Grant microphone access separately below.
      </div>

      <div class="mm-section">
        <h3>🎙️ Singer Microphone & Camera Permissions</h3>
        <div id="mmSingerPermissions">
          No approved singers found.
        </div>
      </div>
    </div>

    <div class="mm-section">
      <h3>Live Stage</h3>
      <div id="mmVideoGrid" class="mm-video-grid"></div>
    </div>
  `;

  target.appendChild(panel);

  byId("mmJoinBtn").addEventListener("click", joinAuditorium);
  byId("mmLeaveBtn").addEventListener("click", leaveAuditorium);
  byId("mmMicBtn").addEventListener("click", toggleMicrophone);
  byId("mmCameraBtn").addEventListener("click", toggleCamera);
  byId("mmSetStageBtn").addEventListener("click", selectMainSingers);

  byId("mmReactionButtons").addEventListener("click", event => {
    const button = event.target.closest("[data-reaction]");
    if (button) sendReaction(button.dataset.reaction);
  });

  byId("mmEcho").addEventListener("input", event => {
    const value = Number(event.target.value);
    byId("mmEchoValue").textContent = value + "%";
    audioEffects?.setEcho(value);
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
        if (unsubscribe) unsubscribe();

        reject(
          new Error("Please sign in before entering the auditorium.")
        );
      }
    }, 20000);

    unsubscribe = onAuthStateChanged(auth, user => {
      if (user) {
        currentUser = user;
        clearTimeout(timeout);

        if (unsubscribe) unsubscribe();

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
   WORKER REQUEST
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
      throw new Error(
        "The token server did not return a LiveKit token."
      );
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
      ? "You are connected. Your reactions are visible to everyone in this show."
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
    showMessage(
      "Please wait before sending more reactions.",
      "warning"
    );
    return false;
  }

  lastReactionTimes.push(now);
  return true;
}

async function sendReaction(emoji) {
  if (!room || !isJoined) {
    showMessage(
      "Enter the auditorium before sending a reaction.",
      "warning"
    );
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

    const bytes = new TextEncoder().encode(
      JSON.stringify(message)
    );

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
   JOIN AUDITORIUM
========================================= */

async function joinAuditorium() {
  if (joining || isJoined) return;

  joining = true;
  setButtonState("mmJoinBtn", true, "Connecting...");

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

    microphoneAllowed =
      currentRole === "host" &&
      tokenData.microphoneAllowed === true;

    cameraAllowed =
      currentRole === "host" &&
      tokenData.cameraAllowed === true;

    if (currentRole === "singer") {
      microphoneAllowed =
        tokenData.microphoneAllowed === true;

      cameraAllowed =
        tokenData.cameraAllowed === true;
    }

    if (currentRole === "audience") {
      microphoneAllowed = false;
      cameraAllowed = false;
    }

    room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    registerRoomEvents();

    await room.connect(
      tokenData.url || LIVEKIT_URL,
      tokenData.token
    );

    isJoined = true;

    setButtonState("mmJoinBtn", true, "Connected");
    setButtonState("mmLeaveBtn", false, "Leave Auditorium");

    byId("mmRoleInfo").textContent =
      "Connected as: " + currentRole.toUpperCase();

    showMessage("Connected to the live auditorium.", "success");

    updateControlButtons();
    updateReactionButtons();

    // Create a local participant tile without requesting a camera.
    await createVideoTile(room.localParticipant, true);

    // Also display participants who connected before the tile listener ran.
    for (const participant of room.remoteParticipants.values()) {
      await createVideoTile(participant, false);
    }

    if (currentRole === "host") {
      byId("mmHostControls").hidden = false;

      await loadHostRegistrations();
      listenToParticipantControls();
      listenToStage();

    } else {
      byId("mmHostControls").hidden = true;

      listenToMyPermissions();
      listenToStage();
    }

  } catch (error) {
    console.error("Join error:", error);

    showMessage(
      error.message || "Unable to enter auditorium.",
      "error"
    );

    if (room) {
      try {
        await room.disconnect();
      } catch (e) {
        console.warn(e);
      }
    }

    room = null;
    isJoined = false;

    updateReactionButtons();

  } finally {
    joining = false;

    setButtonState(
      "mmJoinBtn",
      isJoined,
      isJoined ? "Connected" : "Enter Live Auditorium"
    );
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
      await attachRemoteTrack(track, participant);
    }
  );

  room.on(
    RoomEvent.TrackUnsubscribed,
    (track, publication, participant) => {
      track.detach().forEach(element => element.remove());
    }
  );

  room.on(
    RoomEvent.ParticipantConnected,
    async participant => {
      await createVideoTile(participant, false);
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

      showMessage(
        "Disconnected from the auditorium.",
        "warning"
      );

      resetButtons();
      updateReactionButtons();
    }
  });

  room.on(
    RoomEvent.LocalTrackPublished,
    async publication => {
      if (publication.track) {
        await attachLocalTrack(publication.track);
      }
    }
  );

  room.on(
    RoomEvent.LocalTrackUnpublished,
    publication => {
      if (publication.track) {
        publication.track.detach().forEach(element => element.remove());
      }
    }
  );
}


/* =========================================
   VIDEO TILES
========================================= */

function getTileId(identity) {
  return "mmTile_" +
    safeText(identity).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function createVideoTile(participant, isLocal) {
  const grid = byId("mmVideoGrid");
  if (!grid) return;

  const identity = safeText(
    participant.identity || "participant"
  );

  const tileId = getTileId(identity);

  let tile = byId(tileId);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "mm-video-box";
    tile.id = tileId;

    const name = document.createElement("div");
    name.className = "mm-video-name";

    name.textContent = isLocal
      ? "You (" + currentRole + ")"
      : (participant.name || identity);

    const media = document.createElement("div");
    media.id = tileId + "_media";

    tile.append(name, media);
    grid.appendChild(tile);
  }

  if (participant.trackPublications) {
    participant.trackPublications.forEach(publication => {
      if (publication.track) {
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

  attachTrackToTile(
    track,
    getTileId(participant.identity) + "_media"
  );
}

async function attachLocalTrack(track) {
  if (!room) return;

  attachTrackToTile(
    track,
    getTileId(room.localParticipant.identity) + "_media"
  );
}

function attachTrackToTile(track, targetId) {
  const target = byId(targetId);
  if (!target || !track) return;

  const elements = track.attach();

  elements.forEach(element => {
    element.style.width = "100%";
    element.style.maxHeight = "360px";

    if (track.kind === Track.Kind.Video) {
      element.autoplay = true;
      element.playsInline = true;
    }

    if (track.kind === Track.Kind.Audio) {
      element.autoplay = true;
    }

    if (!target.contains(element)) {
      target.appendChild(element);
    }
  });
}

function removeParticipantTile(identity) {
  const tile = byId(getTileId(identity));
  if (tile) tile.remove();
}


/* =========================================
   MICROPHONE WITH AUDIO EFFECTS
========================================= */

async function startMicrophoneEffects() {
  if (!room || !isJoined) {
    throw new Error("Join the auditorium first.");
  }

  if (!microphoneAllowed) {
    throw new Error("The host has not granted microphone permission.");
  }

  if (publishedMicrophoneTrack) return;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
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

  // Apply the selected effects before publishing.
  audioEffects.setEcho(Number(byId("mmEcho").value));
  audioEffects.setReverb(Number(byId("mmReverb").value));
  audioEffects.setMix(Number(byId("mmMix").value));
  audioEffects.setVolume(Number(byId("mmVolume").value));

  audioEffects.setMuted(false);

  await room.localParticipant.publishTrack(
    processedMicrophoneTrack,
    {
      name: "Melody Magic Processed Microphone",
      source: Track.Source.Microphone
    }
  );

  publishedMicrophoneTrack = processedMicrophoneTrack;
  localMicEnabled = true;

  const effectsStatus = byId("mmEffectsStatus");

  if (effectsStatus) {
    effectsStatus.textContent =
      "Microphone active. Echo and reverb controls are available.";
  }

  updateControlButtons();
}

async function stopMicrophoneEffects() {
  if (room && publishedMicrophoneTrack) {
    try {
      await room.localParticipant.unpublishTrack(
        publishedMicrophoneTrack,
        true
      );
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
    try {
      rawMicrophoneTrack.stop();
    } catch (error) {
      console.warn(error);
    }
  }

  rawMicrophoneTrack = null;
  localMicEnabled = false;

  if (byId("mmEffectsStatus")) {
    byId("mmEffectsStatus").textContent =
      "Microphone is OFF.";
  }

  updateControlButtons();
}

async function toggleMicrophone() {
  if (!room || !isJoined) return;

  if (!microphoneAllowed) {
    showMessage(
      "The host has not granted microphone permission.",
      "warning"
    );
    return;
  }

  try {
    if (localMicEnabled) {
      await stopMicrophoneEffects();
      showMessage("Microphone OFF.");
    } else {
      await startMicrophoneEffects();
      showMessage("Microphone ON. Your processed voice is live.", "success");
    }
  } catch (error) {
    console.error("Microphone error:", error);

    await stopMicrophoneEffects();

    showMessage(
      "Microphone error: " + error.message,
      "error"
    );
  }
}


/* =========================================
   CAMERA
========================================= */

async function toggleCamera() {
  if (!room || !isJoined) return;

  if (!cameraAllowed) {
    showMessage(
      "The host has not granted camera permission.",
      "warning"
    );
    return;
  }

  try {
    const nextState = !localCameraEnabled;

    if (nextState) {
      // Check device availability before enabling the camera.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not supported by this browser.");
      }

      const devices = await navigator.mediaDevices.enumerateDevices();

      if (!devices.some(device => device.kind === "videoinput")) {
        throw new Error("No camera device was found on this device.");
      }
    }

    await room.localParticipant.setCameraEnabled(nextState);

    localCameraEnabled = nextState;
    updateControlButtons();

  } catch (error) {
    localCameraEnabled = false;
    updateControlButtons();

    showMessage(
      "Camera error: " + error.message,
      "error"
    );
  }
}


/* =========================================
   UPDATE CONTROL BUTTONS
========================================= */

function updateControlButtons() {
  const mic = byId("mmMicBtn");
  const camera = byId("mmCameraBtn");
  const info = byId("mmPermissionInfo");

  if (!mic || !camera) return;

  mic.disabled = !isJoined || !microphoneAllowed;
  camera.disabled = !isJoined || !cameraAllowed;

  mic.textContent = localMicEnabled
    ? "Microphone ON"
    : "Microphone OFF";

  camera.textContent = localCameraEnabled
    ? "Camera ON"
    : "Camera OFF";

  if (info) {
    if (currentRole === "audience") {
      info.textContent =
        "Audience mode: microphone and camera are disabled.";
    } else {
      info.textContent =
        "Microphone: " +
        (microphoneAllowed ? "Allowed" : "Waiting for host") +
        " | Camera: " +
        (cameraAllowed ? "Allowed" : "Waiting for host");
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

    microphoneAllowed =
      selected && controls.microphoneAllowed === true;

    cameraAllowed =
      selected && controls.cameraAllowed === true;

    enforceCurrentPermissions();
    updateControlButtons();
  };

  onValue(permissionRef, permissionListener);
}


/* =========================================
   ENFORCE CURRENT PERMISSIONS
========================================= */

async function enforceCurrentPermissions() {
  if (!room) return;

  if (!microphoneAllowed && localMicEnabled) {
    await stopMicrophoneEffects();
  }

  if (!cameraAllowed && localCameraEnabled) {
    try {
      await room.localParticipant.setCameraEnabled(false);
    } catch (error) {
      console.warn(error);
    }

    localCameraEnabled = false;
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

    if (currentRole === "singer" && currentUser) {
      if (!stageSingerUids.includes(currentUser.uid)) {
        microphoneAllowed = false;
        cameraAllowed = false;
        enforceCurrentPermissions();
      }
    }

    updateControlButtons();
  };

  onValue(stageRef, stageListener);
}


/* =========================================
   HOST: LOAD APPROVED REGISTRATIONS
========================================= */

async function loadHostRegistrations() {
  if (!isHost || !showId) return;

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
    .map(([id, item]) => ({
      id,
      ...item
    }))
    .filter(item =>
      item.singerUid &&
      isApproved(item.status)
    );
}

function populateSingerSelectors() {
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

      option.dataset.registrationId = item.id;

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
   HOST: LISTEN TO PERMISSIONS
========================================= */

function listenToParticipantControls() {
  if (!isHost || !showId) return;

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
   HOST: RENDER SINGER PERMISSION BUTTONS
========================================= */

function renderSingerPermissionControls() {
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
    const cameraOn = controls.cameraAllowed === true;

    const selected = stageSingerUids.includes(item.singerUid);

    const card = document.createElement("div");
    card.className = "mm-singer-control";

    const name = document.createElement("strong");
    name.textContent =
      item.singerName || item.name || "Singer";

    const status = document.createElement("div");
    status.className = "mm-permission-status";

    status.textContent =
      (selected ? "On main stage" : "Waiting") +
      " | Microphone: " + (micOn ? "Allowed" : "OFF") +
      " | Camera: " + (cameraOn ? "Allowed" : "OFF");

    const micButton = document.createElement("button");
    micButton.textContent = micOn
      ? "Revoke Microphone"
      : "Grant Microphone";

    micButton.addEventListener("click", () => {
      changeSingerPermission(
        item.singerUid,
        !micOn,
        cameraOn
      );
    });

    const cameraButton = document.createElement("button");
    cameraButton.textContent = cameraOn
      ? "Revoke Camera"
      : "Grant Camera";

    cameraButton.addEventListener("click", () => {
      changeSingerPermission(
        item.singerUid,
        micOn,
        !cameraOn
      );
    });

    card.append(name, status, micButton, cameraButton);
    container.appendChild(card);
  });
}


/* =========================================
   HOST: GRANT / REVOKE PERMISSIONS
========================================= */

async function changeSingerPermission(
  singerUid,
  microphone,
  camera
) {
  if (!isHost || !isJoined) {
    showMessage(
      "Only the connected approved host can change permissions.",
      "error"
    );
    return;
  }

  if (!stageSingerUids.includes(singerUid)) {
    showMessage(
      "Assign this singer to the main stage before granting microphone or camera access.",
      "warning"
    );
    return;
  }

  try {
    await workerRequest({
      action: "syncPermissions",
      uid: singerUid,
      microphoneAllowed: microphone === true,
      cameraAllowed: camera === true
    });

    showMessage(
      "Singer permissions updated successfully.",
      "success"
    );

  } catch (error) {
    console.error("Permission update error:", error);

    showMessage(
      "Could not update singer permissions: " + error.message,
      "error"
    );
  }
}


/* =========================================
   HOST: ASSIGN MAIN STAGE
========================================= */

async function selectMainSingers() {
  if (!isHost || !currentUser) {
    showMessage(
      "Only the approved host can assign the main stage.",
      "error"
    );
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
    showMessage(
      "One or more selected singers are not approved.",
      "error"
    );
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

    // Stage assignment does not automatically grant microphone or camera.
    for (const item of approved) {
      await workerRequest({
        action: "syncPermissions",
        uid: item.singerUid,
        microphoneAllowed: false,
        cameraAllowed: false
      });
    }

    showMessage(
      mode.toUpperCase() +
      " stage assigned. Grant microphone access separately.",
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
   CLEANUP FIREBASE LISTENERS
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

  permissionListener = null;
  stageListener = null;
  registrationListener = null;
  controlsListener = null;
}


/* =========================================
   LEAVE AUDITORIUM
========================================= */

async function leaveAuditorium() {
  if (leaving) return;

  leaving = true;

  try {
    await stopMicrophoneEffects();

    if (room) {
      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch (e) {}

      await room.disconnect();
    }

  } catch (error) {
    console.warn("Leave error:", error);

  } finally {
    stopFirebaseListeners();

    room = null;
    isJoined = false;

    localMicEnabled = false;
    localCameraEnabled = false;

    microphoneAllowed = false;
    cameraAllowed = false;

    resetButtons();
    updateReactionButtons();

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
}


/* =========================================
   INITIALIZE
========================================= */

async function initializeShow() {
  createPanel();
  updateReactionButtons();

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

    isHost = await verifyHost();

    if (isHost) {
      byId("mmRoleInfo").textContent =
        "Host access detected. You can manage the live stage.";

      byId("mmHostControls").hidden = false;

      showMessage(
        "Host verified. Enter the auditorium when ready."
      );

    } else if (requestedMode === "singer") {
      byId("mmRoleInfo").textContent =
        "Singer entry requested. Your registration will be checked by the server.";

      showMessage(
        "Singer entry ready. Click Enter Live Auditorium."
      );

    } else {
      byId("mmRoleInfo").textContent =
        "Audience entry. Microphone and camera are disabled.";

      showMessage(
        "Audience entry ready. Click Enter Live Auditorium."
      );
    }

    listenToStage();

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
});
