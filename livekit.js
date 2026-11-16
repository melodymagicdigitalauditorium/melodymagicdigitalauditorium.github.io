import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  createLocalVideoTrack
} from "https://esm.sh/livekit-client@2";

import { auth, db } from "./firebase.js";

import {
  ref,
  get,
  set,
  onValue
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { VirtualAudioEffects } from "./audio-effects.js";

/* =========================================
   MELODY MAGIC LIVEKIT CONFIGURATION
========================================= */

const LIVEKIT_URL = "wss://melody-magic-auditorium-wrgjlqio.livekit.cloud";

const TOKEN_SERVER = "https://lucky-night-b9bfmelody-magic-token-server.akbusinessenterprisess.workers.dev/";

const showId = new URLSearchParams(location.search).get("showId");

/* =========================================
   APPLICATION STATE
========================================= */

let room = null;
let currentUser = null;
let currentShow = null;
let isHost = false;
let currentRole = "unknown";

let localMic = null;
let localCamera = null;
let vocalEffects = null;
let processedMicTrack = null;
let hostMicMuted = true;

let micAllowed = false;
let cameraAllowed = false;

let queueData = {};
let stageSingerUids = [];

let stopQueueListener = null;
let stopStageListener = null;
let stopPermissionListener = null;

const participants = new Map();
const remoteAudioElements = new Map();
const participantControlListeners = new Map();

let joining = false;
let leaving = false;
let permissionBusy = false;

const vocalEffectSettings = {
  echo: 20,
  reverb: 20,
  mix: 25,
  volume: 80,
  monitor: false,
  monitorVolume: 35
};

/* =========================================
   HELPERS
========================================= */

const $ = id => document.getElementById(id);

function setStatus(message, error = false) {
  const element = $("livekitStatus");
  if (!element) return;

  element.textContent = message;
  element.style.color = error ? "#ff7777" : "#e5bd62";
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function stopListener(listener) {
  if (listener) {
    try {
      listener();
    } catch (error) {
      console.warn(error);
    }
  }
}

function waitForUser() {
  return new Promise((resolve, reject) => {
    if (auth.currentUser) {
      resolve(auth.currentUser);
      return;
    }

    let unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();

      if (user) resolve(user);
      else reject(new Error("Please sign in before joining."));
    });
  });
}

function getQueueEntries() {
  return Object.entries(queueData).filter(([, person]) => person);
}

function getSingerRegistration(uid) {
  return getQueueEntries().find(([, person]) =>
    (person.singerUid || person.uid) === uid
  );
}

/*
 * IMPORTANT:
 * Singers must not read the complete performanceQueue.
 * Their own secure role comes from the Cloudflare Worker token.
 * The host can verify singers using the queue.
 */

function isApprovedSinger(uid) {
  if (!uid) return false;

  // A singer selected on the main stage is approved.
  if (stageSingerUids.includes(uid)) {
    return true;
  }

  // The connected singer's role is confirmed by the secure token.
  if (uid === currentUser?.uid) {
    return (
      currentRole === "selected-singer" ||
      currentRole === "waiting-singer"
    );
  }

  // Only the host can check other singers against the queue.
  if (isHost) {
    const entry = getSingerRegistration(uid);

    return Boolean(
      entry &&
      ["Approved", "Queued", "Playing"].includes(
        String(entry[1].status || "")
      )
    );
  }

  return false;
}

function isSingerRole() {
  return currentRole === "selected-singer" ||
    currentRole === "waiting-singer";
}

function displayName(uid) {
  if (uid === currentUser?.uid) {
    return isHost
      ? "Show Host"
      : $("liveSingerName")?.value.trim() || "Singer";
  }

  const registration = getSingerRegistration(uid);

  return registration?.[1]?.name ||
    registration?.[1]?.singerName ||
    participants.get(uid)?.name ||
    "Participant";
}

function isOnStage(uid) {
  return stageSingerUids.includes(uid);
}

/* =========================================
   SECURE WORKER REQUEST
========================================= */

async function workerRequest(data) {
  if (!currentUser) {
    throw new Error("Please sign in first.");
  }

  const idToken = await currentUser.getIdToken();

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

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.success === false) {
    throw new Error(
      result.error ||
      result.message ||
      "Live server request failed: " + response.status
    );
  }

  return result;
}

/* =========================================
   VOCAL EFFECTS
========================================= */

function applyVocalEffectSettings() {
  if (!vocalEffects) return;

  vocalEffects.setEcho(vocalEffectSettings.echo);
  vocalEffects.setReverb(vocalEffectSettings.reverb);
  vocalEffects.setMix(vocalEffectSettings.mix);
  vocalEffects.setVolume(vocalEffectSettings.volume);

  vocalEffects.setMonitorVolume(
    vocalEffectSettings.monitor
      ? vocalEffectSettings.monitorVolume
      : 0
  );
}

function setupVocalEffectControls() {
  const controls = [
    ["echoControl", "echoValue", "echo"],
    ["reverbControl", "reverbValue", "reverb"],
    ["mixControl", "mixValue", "mix"],
    ["volumeControl", "volumeValue", "volume"],
    ["monitorVolumeControl", "monitorVolumeValue", "monitorVolume"]
  ];

  controls.forEach(([controlId, valueId, setting]) => {
    const control = $(controlId);
    const value = $(valueId);

    if (!control) return;

    control.addEventListener("input", () => {
      vocalEffectSettings[setting] = Number(control.value);

      if (value) value.textContent = control.value + "%";

      applyVocalEffectSettings();
    });
  });

  const monitor = $("monitorControl");

  if (monitor) {
    monitor.addEventListener("change", async () => {
      vocalEffectSettings.monitor = monitor.checked;

      if (vocalEffects) {
        await vocalEffects.setMonitor(monitor.checked);

        vocalEffects.setMonitorVolume(
          monitor.checked
            ? vocalEffectSettings.monitorVolume
            : 0
        );
      }

      setStatus(
        monitor.checked
          ? "Headphone monitoring enabled. Use headphones to avoid feedback."
          : "Headphone monitoring disabled."
      );
    });
  }
}

/* =========================================
   CREATE LIVEKIT PANEL
========================================= */

function createPanel() {
  if ($("livekitPanel")) return;

  const panel = document.createElement("section");
  panel.id = "livekitPanel";

  panel.style.cssText = `
    background:#101010;
    color:#fff;
    padding:18px;
    border:1px solid #9b7939;
    border-radius:14px;
    margin:0;
    font-family:Arial,sans-serif;
    box-sizing:border-box;
    width:100%;
  `;

  panel.innerHTML = `
    <h2 style="color:#e5bd62;margin-top:0">
      🎤 MELODY MAGIC LIVE AUDITORIUM
    </h2>

    <div id="livekitStatus"
      style="color:#e5bd62;padding:10px;background:#202020;border-radius:8px">
      Loading auditorium...
    </div>

    <div id="liveNameArea" style="margin-top:15px">
      <label for="liveSingerName">Your name</label>
      <input id="liveSingerName" type="text"
        placeholder="Enter your name"
        style="display:block;width:100%;padding:12px;margin:7px 0 12px;box-sizing:border-box;border-radius:7px">
    </div>

    <button id="joinLiveButton"
      style="background:#b58b35;color:#111;font-weight:bold;padding:14px;width:100%;border:0;border-radius:8px;cursor:pointer">
      🎬 JOIN LIVE AUDITORIUM
    </button>

    <div style="background:#202020;padding:14px;border-radius:10px;margin-top:15px">
      <h3 style="color:#e5bd62;margin-top:0">
        🎛️ CAMERA & MICROPHONE CONTROL
      </h3>

      <p style="font-size:13px;color:#ccc">
        Host camera and microphone start automatically.
        Approved singers' cameras turn on when they join.
        Only main-stage singers can use their microphones.
      </p>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="cameraButton" disabled
          style="background:#a71919;color:white;padding:13px 18px;border:0;border-radius:8px;font-weight:bold;cursor:pointer">
          📷 CAMERA OFF
        </button>

        <button id="micButton" disabled
          style="background:#a71919;color:white;padding:13px 18px;border:0;border-radius:8px;font-weight:bold;cursor:pointer">
          🎙️ MICROPHONE OFF
        </button>

        <button id="leaveButton" disabled
          style="background:#555;color:white;padding:13px 18px;border:0;border-radius:8px;cursor:pointer">
          LEAVE
        </button>
      </div>

      <div id="localPermissionMessage"
        style="color:#e5bd62;font-size:13px;margin-top:12px">
      </div>
    </div>

    <div id="hostVocalEffects"
      style="display:none;background:#202020;padding:14px;border-radius:10px;margin-top:15px">

      <h3 style="color:#e5bd62;margin-top:0">
        🎚️ HOST VOCAL EFFECTS
      </h3>

      <p style="font-size:13px;color:#ccc">
        These effects apply to the host microphone only.
      </p>

      <label for="echoControl">
        Echo / Delay: <strong id="echoValue">20%</strong>
      </label>
      <input id="echoControl" type="range" min="0" max="100" value="20"
        style="width:100%;margin:10px 0 18px">

      <label for="reverbControl">
        Reverb: <strong id="reverbValue">20%</strong>
      </label>
      <input id="reverbControl" type="range" min="0" max="100" value="20"
        style="width:100%;margin:10px 0 18px">

      <label for="mixControl">
        Wet / Dry Mix: <strong id="mixValue">25%</strong>
      </label>
      <input id="mixControl" type="range" min="0" max="100" value="25"
        style="width:100%;margin:10px 0 18px">

      <label for="volumeControl">
        Microphone Output: <strong id="volumeValue">80%</strong>
      </label>
      <input id="volumeControl" type="range" min="0" max="100" value="80"
        style="width:100%;margin:10px 0 18px">

      <div style="border-top:1px solid #555;padding-top:14px;margin-top:8px">
        <label style="display:flex;align-items:center;gap:9px">
          <input id="monitorControl" type="checkbox">
          Headphone monitoring
        </label>

        <p style="font-size:12px;color:#ccc">
          Use headphones. Monitoring through speakers can cause feedback.
        </p>

        <label for="monitorVolumeControl">
          Headphone Volume:
          <strong id="monitorVolumeValue">35%</strong>
        </label>
        <input id="monitorVolumeControl" type="range" min="0" max="100" value="35"
          style="width:100%">
      </div>
    </div>

    <div id="hostStageControls"
      style="display:none;background:#202020;padding:14px;border-radius:10px;margin-top:15px">

      <h3 style="color:#e5bd62;margin-top:0">
        ⭐ HOST STAGE CONTROLS
      </h3>

      <label for="stageMode">Stage type</label>
      <select id="stageMode"
        style="display:block;width:100%;padding:11px;margin:7px 0 12px">
        <option value="solo">Solo performance</option>
        <option value="duet">Duet performance</option>
      </select>

      <label for="stageSingerOne">First singer</label>
      <select id="stageSingerOne"
        style="display:block;width:100%;padding:11px;margin:7px 0 12px">
        <option value="">Select singer</option>
      </select>

      <div id="secondSingerArea" style="display:none">
        <label for="stageSingerTwo">Second singer</label>
        <select id="stageSingerTwo"
          style="display:block;width:100%;padding:11px;margin:7px 0 12px">
          <option value="">Select second singer</option>
        </select>
      </div>

      <button id="makeStageButton"
        style="background:#b58b35;padding:12px;width:100%;border:0;border-radius:7px;font-weight:bold">
        ASSIGN SINGER(S) TO MAIN STAGE
      </button>

      <h3 style="color:#e5bd62;margin-top:20px">
        🎚️ SINGER CAMERA CONTROLS
      </h3>

      <p style="font-size:12px;color:#ccc">
        Microphone access is controlled automatically by stage assignment.
      </p>

      <div id="hostSingerControls">
        No approved singers connected.
      </div>
    </div>

    <h3 style="color:#e5bd62;margin-top:22px">⭐ MAIN STAGE</h3>

    <div id="mainStage"
      style="background:#181818;padding:12px;border-radius:10px;min-height:130px">
      Waiting for host to select a singer...
    </div>

    <h3 style="color:#e5bd62;margin-top:22px">🎤 SINGERS WAITING QUEUE</h3>

    <div id="singerGrid"
      style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
      <p style="color:#aaa">No waiting singers are connected.</p>
    </div>
  `;

  const area = $("livekitArea");
  (area || document.body).appendChild(panel);

  $("joinLiveButton").addEventListener("click", joinAuditorium);
  $("cameraButton").addEventListener("click", toggleCamera);
  $("micButton").addEventListener("click", toggleMicrophone);
  $("leaveButton").addEventListener("click", leaveAuditorium);

  $("stageMode").addEventListener("change", () => {
    $("secondSingerArea").style.display =
      $("stageMode").value === "duet" ? "block" : "none";

    updateSingerOptions();
  });

  $("makeStageButton").addEventListener("click", selectMainSingers);

  setupVocalEffectControls();
}

/* =========================================
   HOST VERIFICATION
========================================= */

async function verifyHost() {
  if (!currentUser || !currentShow ||
      currentShow.hostUid !== currentUser.uid) {
    return false;
  }

  const snapshot = await get(
    ref(db, "hostApplications/" + currentUser.uid)
  );

  if (!snapshot.exists()) return false;

  const application = snapshot.val();
  const now = Date.now();

  return application.status === "Approved" &&
    Number(application.subscriptionStartAt || 0) <= now &&
    Number(application.subscriptionEndAt || 0) > now;
}

/* =========================================
   VIDEO TILES
========================================= */

function makeTile(uid, target, stageTile = false) {
  const participant = participants.get(uid);
  if (!participant || !target) return;

  const tile = document.createElement("div");

  tile.style.cssText = `
    background:#252525;
    padding:${stageTile ? "12px" : "10px"};
    border:1px solid ${stageTile ? "#b58b35" : "#444"};
    border-radius:10px;
    min-width:0;
    text-align:center;
  `;

  const title = document.createElement("p");
  title.textContent = "🎤 " + displayName(uid);
  title.style.cssText = "color:#e5bd62;font-weight:bold;margin:4px 0 10px";
  tile.appendChild(title);

  const videoBox = document.createElement("div");

  videoBox.style.cssText = `
    min-height:${stageTile ? "210px" : "125px"};
    background:#111;
    border-radius:8px;
    overflow:hidden;
    display:flex;
    align-items:center;
    justify-content:center;
  `;

  const track = uid === currentUser?.uid
    ? localCamera
    : participant.videoTrack;

  if (track && !track.isMuted) {
    const video = track.attach();

    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

    video.style.cssText = `
      display:block;
      width:100%;
      height:auto;
      max-height:${stageTile ? "430px" : "260px"};
      aspect-ratio:16/9;
      object-fit:cover;
    `;

    videoBox.appendChild(video);
  } else {
    const message = document.createElement("span");
    message.textContent = "Camera is OFF";
    message.style.cssText = "color:#aaa;padding:35px 8px";
    videoBox.appendChild(message);
  }

  tile.appendChild(videoBox);

  const hasAudio = uid === currentUser?.uid
    ? (
        isHost
          ? Boolean(vocalEffects && !hostMicMuted)
          : Boolean(localMic && !localMic.isMuted)
      )
    : Boolean(participant.audioTrack);

  const state = document.createElement("p");

  state.textContent =
    (track && !track.isMuted ? "Camera ON" : "Camera OFF") +
    " • " +
    (hasAudio ? "Microphone active" : "Microphone OFF");

  state.style.cssText = "font-size:12px;color:#bbb;margin:8px 0 0";

  tile.appendChild(state);
  target.appendChild(tile);
}

function renderStageAndQueue() {
  const stage = $("mainStage");
  const queue = $("singerGrid");

  if (!stage || !queue) return;

  stage.innerHTML = "";
  queue.innerHTML = "";

  stage.style.display = "grid";
  stage.style.gridTemplateColumns = "repeat(auto-fit,minmax(220px,1fr))";
  stage.style.gap = "12px";

  const selected = stageSingerUids.filter(uid =>
    participants.has(uid) && isApprovedSinger(uid)
  );

  if (!selected.length) {
    stage.innerHTML = `
      <p style="color:#aaa;padding:20px;text-align:center">
        Waiting for host to select a singer...
      </p>
    `;
  } else {
    selected.forEach(uid => makeTile(uid, stage, true));
  }

  const waiting = [...participants.keys()].filter(uid =>
    uid !== currentUser?.uid &&
    isApprovedSinger(uid) &&
    !stageSingerUids.includes(uid)
  );

  if (
    !isHost &&
    isSingerRole() &&
    currentUser &&
    isApprovedSinger(currentUser.uid) &&
    !stageSingerUids.includes(currentUser.uid)
  ) {
    waiting.unshift(currentUser.uid);
  }

  const uniqueWaiting = [...new Set(waiting)];

  if (!uniqueWaiting.length) {
    queue.innerHTML = `
      <p style="color:#aaa">
        No other approved singers are waiting right now.
      </p>
    `;
  } else {
    uniqueWaiting.forEach(uid => makeTile(uid, queue, false));
  }
}

/* =========================================
   CAMERA CONTROLS
========================================= */

async function startCamera() {
  if (!room) throw new Error("Join the auditorium first.");

  if (!isHost && !cameraAllowed) {
    throw new Error("The host has not enabled your camera.");
  }

  if (!localCamera) {
    localCamera = await createLocalVideoTrack({
      facingMode: "user",
      resolution: {
        width: 1280,
        height: 720,
        frameRate: 30
      }
    });

    try {
      await room.localParticipant.publishTrack(localCamera, {
        name: "camera",
        source: Track.Source.Camera
      });
    } catch (error) {
      localCamera.stop();
      localCamera = null;
      throw error;
    }
  } else if (localCamera.isMuted) {
    await localCamera.unmute();
  }

  const own = participants.get(currentUser.uid) || {};

  own.name = isHost
    ? "Show Host"
    : ($("liveSingerName").value || "Singer");

  own.videoTrack = localCamera;

  participants.set(currentUser.uid, own);

  updateCameraButton();
  renderStageAndQueue();
}

async function stopCamera() {
  if (localCamera && !localCamera.isMuted) {
    await localCamera.mute();
  }

  updateCameraButton();
  renderStageAndQueue();
}

async function toggleCamera() {
  if (!room) {
    setStatus("Join the auditorium before using the camera.", true);
    return;
  }

  if (!isHost && !cameraAllowed) {
    setStatus("The host has not enabled your camera.", true);
    return;
  }

  $("cameraButton").disabled = true;

  try {
    if (localCamera && !localCamera.isMuted) {
      await stopCamera();
      setStatus("Camera turned OFF.");
    } else {
      setStatus("Requesting camera access...");
      await startCamera();
      setStatus("Camera turned ON.");
    }
  } catch (error) {
    console.error("Camera error:", error);

    setStatus("Camera error: " + error.message, true);

    alert(
      "Unable to start camera.\n\n" +
      error.message +
      "\n\nCheck browser camera permission."
    );
  } finally {
    updateCameraButton();
  }
}

function updateCameraButton() {
  const button = $("cameraButton");
  if (!button) return;

  const enabled = Boolean(localCamera && !localCamera.isMuted);

  button.textContent = enabled
    ? "📷 CAMERA ON"
    : "📷 CAMERA OFF";

  button.style.background = enabled ? "#287c48" : "#a71919";

  button.disabled = !room || (!isHost && !cameraAllowed);
}

/* =========================================
   MICROPHONE CONTROLS
========================================= */

async function startMicrophone() {
  if (!room) throw new Error("Join the auditorium first.");

  if (!isHost && (!micAllowed || !isOnStage(currentUser.uid))) {
    throw new Error(
      "Only singers selected for the main stage can use the microphone."
    );
  }

  if (isHost) {
    if (!localMic) {
      localMic = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      });

      vocalEffects = new VirtualAudioEffects();

      try {
        processedMicTrack = await vocalEffects.start(
          localMic.mediaStreamTrack
        );

        if (!processedMicTrack) {
          throw new Error("Vocal effects did not return an audio track.");
        }

        applyVocalEffectSettings();

        await room.localParticipant.publishTrack(processedMicTrack, {
          name: "microphone",
          source: Track.Source.Microphone
        });

      } catch (error) {
        vocalEffects?.stop();
        vocalEffects = null;
        processedMicTrack = null;

        localMic.stop();
        localMic = null;

        throw error;
      }
    }

    hostMicMuted = false;

    if (vocalEffects) {
      await vocalEffects.setMuted(false);
    }

  } else {
    if (!localMic) {
      localMic = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      });

      try {
        await room.localParticipant.publishTrack(localMic, {
          name: "microphone",
          source: Track.Source.Microphone
        });
      } catch (error) {
        localMic.stop();
        localMic = null;
        throw error;
      }
    } else if (localMic.isMuted) {
      await localMic.unmute();
    }
  }

  updateMicButton();
  renderStageAndQueue();
}

async function stopMicrophone() {
  if (isHost) {
    hostMicMuted = true;

    if (vocalEffects) {
      await vocalEffects.setMuted(true);
    }

  } else if (localMic && !localMic.isMuted) {
    await localMic.mute();
  }

  updateMicButton();
  renderStageAndQueue();
}

async function toggleMicrophone() {
  if (!room) {
    setStatus("Join the auditorium before using the microphone.", true);
    return;
  }

  if (!isHost && (!micAllowed || !isOnStage(currentUser.uid))) {
    setStatus(
      "Your microphone is available only while you are selected for the main stage.",
      true
    );
    return;
  }

  $("micButton").disabled = true;

  try {
    const enabled = isHost
      ? Boolean(vocalEffects && !hostMicMuted)
      : Boolean(localMic && !localMic.isMuted);

    if (enabled) {
      await stopMicrophone();
      setStatus("Microphone turned OFF.");
    } else {
      setStatus("Requesting microphone access...");
      await startMicrophone();
      setStatus("Microphone turned ON.");
    }
  } catch (error) {
    console.error("Microphone error:", error);

    setStatus("Microphone error: " + error.message, true);

    alert(
      "Unable to start microphone.\n\n" +
      error.message +
      "\n\nCheck browser microphone permission and LiveKit publishing permission."
    );
  } finally {
    updateMicButton();
  }
}

function updateMicButton() {
  const button = $("micButton");
  if (!button) return;

  const enabled = isHost
    ? Boolean(vocalEffects && !hostMicMuted)
    : Boolean(localMic && !localMic.isMuted);

  button.textContent = enabled
    ? "🎙️ MICROPHONE ON"
    : "🎙️ MICROPHONE OFF";

  button.style.background = enabled ? "#287c48" : "#a71919";

  button.disabled =
    !room ||
    (!isHost && (!micAllowed || !isOnStage(currentUser?.uid)));
}

/* =========================================
   SINGER PERMISSION LISTENER
========================================= */

function listenToMyPermissions() {
  stopListener(stopPermissionListener);
  stopPermissionListener = null;

  if (isHost || !isSingerRole()) return;

  stopPermissionListener = onValue(
    ref(db, `participantControls/${showId}/${currentUser.uid}`),

    async snapshot => {
      const controls = snapshot.val() || {};

      cameraAllowed =
        typeof controls.cameraAllowed === "boolean"
          ? controls.cameraAllowed
          : true;

      micAllowed =
        typeof controls.microphoneAllowed === "boolean"
          ? controls.microphoneAllowed
          : false;

      $("localPermissionMessage").textContent =
        "Host permissions: Camera " +
        (cameraAllowed ? "ON" : "OFF") +
        " • Microphone " +
        (micAllowed && isOnStage(currentUser.uid)
          ? "ON (Main Stage)"
          : "OFF");

      try {
        if (cameraAllowed) {
          await startCamera();
        } else {
          await stopCamera();
        }

        if (micAllowed && isOnStage(currentUser.uid)) {
          await startMicrophone();
        } else {
          await stopMicrophone();
        }

      } catch (error) {
        console.error("Permission application:", error);
        setStatus("Could not apply host permissions: " + error.message, true);
      }

      updateMicButton();
      updateCameraButton();
    },

    error => {
      console.error("Permission listener:", error);
      setStatus(
        "Could not read your camera/microphone permissions: " +
        error.message,
        true
      );
    }
  );
}

/* =========================================
   HOST CAMERA CONTROLS
========================================= */

function renderHostControls() {
  const container = $("hostSingerControls");
  if (!container || !isHost) return;

  const connected = [...participants.entries()].filter(([uid]) =>
    uid !== currentUser?.uid && isApprovedSinger(uid)
  );

  if (!connected.length) {
    container.textContent = "No approved singers connected.";
    return;
  }

  container.innerHTML = "";

  connected.forEach(([uid, participant]) => {
    const row = document.createElement("div");

    row.style.cssText =
      "background:#303030;border-radius:9px;padding:12px;margin:8px 0";

    const title = document.createElement("strong");
    title.textContent = participant.name || displayName(uid);

    const details = document.createElement("p");
    details.style.cssText = "font-size:12px;color:#bbb;margin:6px 0";

    details.textContent = isOnStage(uid)
      ? "MAIN STAGE • Microphone permission ON"
      : "WAITING QUEUE • Microphone permission OFF";

    const cameraButton = document.createElement("button");

    cameraButton.textContent =
      participant.cameraAllowed === false
        ? "CAMERA: OFF"
        : "CAMERA: ON";

    cameraButton.style.cssText =
      "margin-top:8px;padding:9px 12px;border:0;border-radius:6px;color:white;background:" +
      (participant.cameraAllowed === false ? "#a71919" : "#287c48");

    cameraButton.addEventListener("click", () => {
      setSingerCameraPermission(
        uid,
        participant.cameraAllowed === false
      );
    });

    row.append(title, details, cameraButton);
    container.appendChild(row);
  });
}

async function setSingerCameraPermission(uid, enabled) {
  if (!isHost || permissionBusy) return;

  permissionBusy = true;

  try {
    setStatus("Updating singer camera permission...");

    await workerRequest({
      action: "syncPermissions",
      targetUid: uid,
      cameraAllowed: enabled
    });

    const participant = participants.get(uid);

    if (participant) {
      participant.cameraAllowed = enabled;
    }

    renderHostControls();

    setStatus(
      displayName(uid) + ": camera " +
      (enabled ? "enabled." : "disabled.")
    );

  } catch (error) {
    console.error(error);

    setStatus("Camera permission update failed: " + error.message, true);
    alert(error.message);

  } finally {
    permissionBusy = false;
  }
}

/* =========================================
   HOST STAGE SELECTION
========================================= */

function updateSingerOptions() {
  if (!isHost) return;

  const first = $("stageSingerOne");
  const second = $("stageSingerTwo");

  if (!first || !second) return;

  const connected = getQueueEntries().filter(([, item]) =>
    item &&
    ["Approved", "Queued", "Playing"].includes(String(item.status || "")) &&
    participants.has(item.singerUid || item.uid)
  );

  const oldFirst = first.value;
  const oldSecond = second.value;

  const options = connected.map(([id, item]) =>
    `<option value="${escapeText(id)}">${escapeText(
      item.name || item.singerName || "Singer"
    )}</option>`
  ).join("");

  first.innerHTML = '<option value="">Select singer</option>' + options;
  second.innerHTML = '<option value="">Select second singer</option>' + options;

  if (connected.some(([id]) => id === oldFirst)) first.value = oldFirst;
  if (connected.some(([id]) => id === oldSecond)) second.value = oldSecond;
}

async function selectMainSingers() {
  if (!isHost) return;

  if (permissionBusy) {
    alert("Please wait for the current permission update.");
    return;
  }

  const mode = $("stageMode").value;
  const firstId = $("stageSingerOne").value;
  const secondId = $("stageSingerTwo").value;

  if (!firstId) {
    alert("Please select the first singer.");
    return;
  }

  if (mode === "duet" && (!secondId || firstId === secondId)) {
    alert("Please select two different singers.");
    return;
  }

  const ids = mode === "duet" ? [firstId, secondId] : [firstId];
  const selected = ids.map(id => queueData[id]);

  if (selected.some(item =>
    !item ||
    !["Approved", "Queued", "Playing"].includes(String(item.status || "")) ||
    !participants.has(item.singerUid || item.uid)
  )) {
    alert("Selected singers must be approved and connected.");
    return;
  }

  const uids = selected.map(item => item.singerUid || item.uid);

  const names = selected.map(item =>
    item.name || item.singerName || "Singer"
  );

  permissionBusy = true;
  $("makeStageButton").disabled = true;

  try {
    await set(ref(db, `liveStage/${showId}`), {
      mode,
      registrationIds: ids,
      singerUids: uids,
      singerNames: names,
      registrationId: ids[0],
      singerUid: uids[0],
      singerName: names[0],
      updatedAt: Date.now()
    });

    const allApproved = getQueueEntries()
      .filter(([, item]) =>
        item &&
        ["Approved", "Queued", "Playing"].includes(String(item.status || ""))
      )
      .map(([, item]) => item.singerUid || item.uid)
      .filter(Boolean);

    const allUids = [...new Set([...allApproved, ...uids])];

    for (const uid of allUids) {
      await workerRequest({
        action: "syncPermissions",
        targetUid: uid,
        microphoneAllowed: uids.includes(uid)
      });

      const participant = participants.get(uid);

      if (participant) {
        participant.micAllowed = uids.includes(uid);
      }
    }

    stageSingerUids = uids;

    renderStageAndQueue();
    renderHostControls();

    setStatus(
      "Main stage assigned. Only selected singers have microphone permission ON."
    );

  } catch (error) {
    console.error("Stage assignment error:", error);

    alert("Stage assignment or microphone update failed: " + error.message);

    setStatus("Could not complete stage assignment: " + error.message, true);

  } finally {
    permissionBusy = false;
    $("makeStageButton").disabled = false;
  }
}

/* =========================================
   FIREBASE QUEUE AND STAGE LISTENERS
========================================= */

/*
 * CRITICAL 401 FIX:
 * Do not attach a full performanceQueue listener on a singer page.
 * Firebase rules permit the host to read the full queue, but singers
 * are restricted to their own registration records.
 */

function listenToSingerQueue() {
  stopListener(stopQueueListener);
  stopQueueListener = null;

  if (!isHost) {
    queueData = {};
    updateSingerOptions();
    renderHostControls();
    renderStageAndQueue();
    return;
  }

  stopQueueListener = onValue(
    ref(db, `performanceQueue/${showId}`),

    snapshot => {
      queueData = snapshot.val() || {};

      for (const [uid, participant] of participants.entries()) {
        const registration = getSingerRegistration(uid);

        if (registration) {
          participant.name =
            registration[1].name ||
            registration[1].singerName ||
            participant.name;
        }
      }

      updateSingerOptions();
      renderHostControls();
      renderStageAndQueue();
    },

    error => {
      console.error("Host queue listener:", error);
      setStatus(
        "Host could not load the singer queue: " + error.message,
        true
      );
    }
  );
}

function listenToStage() {
  stopListener(stopStageListener);

  stopStageListener = onValue(
    ref(db, `liveStage/${showId}`),

    async snapshot => {
      const data = snapshot.val() || {};

      stageSingerUids = Array.isArray(data.singerUids)
        ? data.singerUids.filter(Boolean)
        : data.singerUid
          ? [data.singerUid]
          : [];

      renderStageAndQueue();
      renderHostControls();

      if (!isHost && room && isSingerRole() && currentUser) {
        if (!stageSingerUids.includes(currentUser.uid)) {
          try {
            await stopMicrophone();
          } catch (error) {
            console.warn(error);
          }
        } else if (micAllowed) {
          try {
            await startMicrophone();
          } catch (error) {
            console.warn(error);
          }
        }
      }

      updateMicButton();
    },

    error => {
      console.error("Stage listener:", error);
      setStatus("Could not read the live stage: " + error.message, true);
    }
  );
}

/* =========================================
   PARTICIPANTS
========================================= */

function addParticipant(uid, name) {
  const old = participants.get(uid) || {};

  participants.set(uid, {
    ...old,
    name: name || old.name || "Participant"
  });

  if (isHost && uid !== currentUser?.uid) {
    listenToSingerControls(uid);
  }

  updateSingerOptions();
  renderHostControls();
  renderStageAndQueue();
}

function removeParticipant(uid) {
  stopSingerControlsListener(uid);

  participants.delete(uid);

  const audio = remoteAudioElements.get(uid);

  if (audio) {
    audio.remove();
    remoteAudioElements.delete(uid);
  }

  updateSingerOptions();
  renderHostControls();
  renderStageAndQueue();
}

function listenToSingerControls(uid) {
  if (!isHost || participantControlListeners.has(uid)) return;

  const unsubscribe = onValue(
    ref(db, `participantControls/${showId}/${uid}`),

    snapshot => {
      const controls = snapshot.val() || {};
      const participant = participants.get(uid);

      if (!participant) return;

      participant.cameraAllowed =
        typeof controls.cameraAllowed === "boolean"
          ? controls.cameraAllowed
          : true;

      participant.micAllowed =
        typeof controls.microphoneAllowed === "boolean"
          ? controls.microphoneAllowed
          : false;

      renderHostControls();
    },

    error => {
      console.error("Singer control listener:", error);
    }
  );

  participantControlListeners.set(uid, unsubscribe);
}

function stopSingerControlsListener(uid) {
  stopListener(participantControlListeners.get(uid));
  participantControlListeners.delete(uid);
}

/* =========================================
   LIVEKIT ROOM EVENTS
========================================= */

function setupRoomEvents() {
  room.on(RoomEvent.ParticipantConnected, participant => {
    addParticipant(
      participant.identity,
      participant.name || participant.identity
    );
  });

  room.on(RoomEvent.ParticipantDisconnected, participant => {
    removeParticipant(participant.identity);
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const uid = participant.identity;

    const old = participants.get(uid) || {
      name: participant.name || uid
    };

    if (track.kind === "video") old.videoTrack = track;

    if (track.kind === "audio") {
      old.audioTrack = track;

      const audio = track.attach();
      audio.autoplay = true;
      audio.dataset.livekitRemote = "true";

      document.body.appendChild(audio);

      remoteAudioElements.get(uid)?.remove();
      remoteAudioElements.set(uid, audio);
    }

    participants.set(uid, old);

    renderStageAndQueue();
    renderHostControls();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    const uid = participant.identity;

    track.detach().forEach(element => element.remove());

    const old = participants.get(uid);

    if (old) {
      if (track.kind === "video") old.videoTrack = null;
      if (track.kind === "audio") old.audioTrack = null;
    }

    if (track.kind === "audio") {
      remoteAudioElements.get(uid)?.remove();
      remoteAudioElements.delete(uid);
    }

    renderStageAndQueue();
    renderHostControls();
  });

  room.on(RoomEvent.Disconnected, () => {
    setStatus("Disconnected from the auditorium.", true);
  });

  room.on(RoomEvent.ParticipantNameChanged, (name, participant) => {
    const old = participants.get(participant.identity) || {};
    old.name = name;

    participants.set(participant.identity, old);

    renderStageAndQueue();
    renderHostControls();
  });
}

/* =========================================
   JOIN AUDITORIUM
========================================= */

async function joinAuditorium() {
  if (room || joining) return;

  joining = true;

  if ($("joinLiveButton")) {
    $("joinLiveButton").disabled = true;
  }

  try {
    currentUser = await waitForUser();

    const singerName =
      $("liveSingerName").value.trim() ||
      (isHost ? "Show Host" : "Singer");

    setStatus("Requesting secure LiveKit access...");

    const tokenData = await workerRequest({
      action: "join",
      name: singerName
    });

    if (!tokenData.token) {
      throw new Error("Worker did not return a LiveKit token.");
    }

    currentRole = tokenData.role || "unknown";

    if (isHost && currentRole !== "host") {
      throw new Error(
        "Host role mismatch. Worker returned: " + currentRole
      );
    }

    if (!isHost && currentRole === "host") {
      throw new Error(
        "Worker returned a host token, but this page did not verify this account as host. Refresh and sign in again."
      );
    }

    const canPublish =
      currentRole === "host" ||
      currentRole === "selected-singer" ||
      currentRole === "waiting-singer";

    if (isHost) {
      cameraAllowed = true;
      micAllowed = true;
      hostMicMuted = true;

    } else if (isSingerRole()) {
      cameraAllowed =
        typeof tokenData.cameraAllowed === "boolean"
          ? tokenData.cameraAllowed
          : true;

      micAllowed =
        typeof tokenData.microphoneAllowed === "boolean"
          ? tokenData.microphoneAllowed
          : false;

    } else {
      cameraAllowed = false;
      micAllowed = false;
    }

    room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    setupRoomEvents();

    await room.connect(
      tokenData.url || LIVEKIT_URL,
      tokenData.token
    );

    room.remoteParticipants.forEach(participant => {
      addParticipant(
        participant.identity,
        participant.name || participant.identity
      );

      participant.trackPublications.forEach(publication => {
        if (!publication.track) return;

        const track = publication.track;
        const uid = participant.identity;
        const old = participants.get(uid) || {};

        if (track.kind === "video") old.videoTrack = track;

        if (track.kind === "audio") {
          old.audioTrack = track;

          const audio = track.attach();
          audio.autoplay = true;
          audio.dataset.livekitRemote = "true";

          document.body.appendChild(audio);
          remoteAudioElements.set(uid, audio);
        }

        participants.set(uid, old);
      });
    });

    participants.set(currentUser.uid, {
      name: isHost ? "Show Host" : singerName,
      micAllowed,
      cameraAllowed
    });

    /* HOST: CAMERA AND MICROPHONE ON AUTOMATICALLY */
    if (isHost && canPublish) {
      setStatus("Starting host camera and microphone...");

      await startCamera();
      await startMicrophone();
    }

    /* APPROVED SINGERS: CAMERA ON AUTOMATICALLY */
    else if (!isHost && canPublish && cameraAllowed) {
      await startCamera();
    }

    /* SINGER MICROPHONE RULES */
    if (!isHost && isSingerRole()) {
      if (micAllowed && isOnStage(currentUser.uid)) {
        await startMicrophone();
      } else {
        await stopMicrophone();
      }
    }

    if (!isHost && isSingerRole()) {
      listenToMyPermissions();
    }

    $("leaveButton").disabled = false;

    updateMicButton();
    updateCameraButton();

    renderStageAndQueue();
    renderHostControls();

    setStatus(
      isHost
        ? "Host connected. Camera and microphone are ON."
        : isSingerRole()
          ? "Singer connected. Camera is ON. Microphone is OFF unless selected for the main stage."
          : "Connected as audience."
    );

  } catch (error) {
    console.error("Join error:", error);

    await leaveAuditorium();

    if ($("joinLiveButton")) {
      $("joinLiveButton").disabled = false;
    }

    setStatus(
      error.message || "Could not join the auditorium.",
      true
    );

  } finally {
    joining = false;
  }
}

/* =========================================
   LEAVE AUDITORIUM
========================================= */

async function leaveAuditorium() {
  if (leaving) return;

  leaving = true;

  try {
    stopListener(stopPermissionListener);
    stopPermissionListener = null;

    participantControlListeners.forEach(unsubscribe => {
      stopListener(unsubscribe);
    });

    participantControlListeners.clear();

    if (room && processedMicTrack) {
      try {
        await room.localParticipant.unpublishTrack(processedMicTrack);
      } catch (error) {
        console.warn(error);
      }
    } else if (room && localMic) {
      try {
        await room.localParticipant.unpublishTrack(localMic);
      } catch (error) {
        console.warn(error);
      }
    }

    if (vocalEffects) {
      vocalEffects.stop();
      vocalEffects = null;
    }

    processedMicTrack = null;
    hostMicMuted = true;

    if (localMic) {
      localMic.stop();
      localMic = null;
    }

    if (room && localCamera) {
      try {
        await room.localParticipant.unpublishTrack(localCamera);
      } catch (error) {
        console.warn(error);
      }
    }

    if (localCamera) {
      localCamera.stop();
      localCamera = null;
    }

    if (room) {
      await room.disconnect();
      room = null;
    }

    document.querySelectorAll(
      'audio[data-livekit-remote="true"]'
    ).forEach(element => element.remove());

    remoteAudioElements.forEach(audio => audio.remove());
    remoteAudioElements.clear();
    participants.clear();

    if ($("joinLiveButton")) $("joinLiveButton").disabled = false;
    if ($("leaveButton")) $("leaveButton").disabled = true;

    micAllowed = false;
    cameraAllowed = false;
    currentRole = "unknown";

    updateMicButton();
    updateCameraButton();

    renderStageAndQueue();

    if ($("mainStage")) {
      $("mainStage").innerHTML = `
        <p style="color:#aaa">
          Waiting for host to select a singer...
        </p>
      `;
    }

    if ($("hostSingerControls")) {
      $("hostSingerControls").textContent =
        "No approved singers connected.";
    }

    setStatus(
      "You have left the auditorium. Your camera and microphone have been stopped."
    );

  } catch (error) {
    console.error("Leave error:", error);

    setStatus(
      "There was a problem leaving the auditorium: " + error.message,
      true
    );

  } finally {
    leaving = false;
  }
}

/* =========================================
   INITIALIZE SHOW
========================================= */

async function initializeShow() {
  try {
    if (!showId) {
      setStatus("Show ID is missing from the page URL.", true);
      return;
    }

    currentUser = await waitForUser();

    const snapshot = await get(ref(db, `shows/${showId}`));

    if (!snapshot.exists()) {
      setStatus("Show not found.", true);
      return;
    }

    currentShow = snapshot.val();

    if (!["Published", "Live"].includes(currentShow.status)) {
      setStatus("This show is not published or live.", true);
      return;
    }

    isHost = await verifyHost();

    // The queue listener now reads the full queue only for the host.
    listenToSingerQueue();

    // Singers can still listen to the public live-stage selection.
    listenToStage();

    if (isHost) {
      $("hostStageControls").style.display = "block";
      $("hostVocalEffects").style.display = "block";

      $("liveNameArea").style.display = "none";
      $("joinLiveButton").style.display = "none";

      $("cameraButton").style.display = "inline-block";
      $("micButton").style.display = "inline-block";

      $("liveSingerName").value = "Show Host";

      $("localPermissionMessage").textContent =
        "Host mode: camera and microphone will turn ON automatically when you connect.";

      setStatus(
        "Host verified. Connecting automatically to the live auditorium..."
      );

      await joinAuditorium();

    } else {
      $("liveSingerName").value =
        auth.currentUser?.displayName || "";

      setStatus(
        "Show loaded. Approved singers can join the auditorium."
      );
    }

  } catch (error) {
    console.error("Initialization error:", error);

    setStatus(
      error.message || "Unable to initialize show.",
      true
    );
  }
}

/* =========================================
   START APPLICATION
========================================= */

createPanel();

initializeShow();

window.addEventListener("beforeunload", () => {
  stopListener(stopQueueListener);
  stopListener(stopStageListener);
  stopListener(stopPermissionListener);

  participantControlListeners.forEach(unsubscribe => {
    stopListener(unsubscribe);
  });
});
