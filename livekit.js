
import {
  Room,
  RoomEvent,
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

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

/* =========================================
   MELODY MAGIC LIVEKIT CONFIGURATION
========================================= */

const LIVEKIT_URL =
  "wss://melody-magic-auditorium-wrgjlqio.livekit.cloud";

const TOKEN_SERVER =
  "https://lucky-night-b9bfmelody-magic-token-server.akbusinessenterprisess.workers.dev/";

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

let micAllowed = false;
let cameraAllowed = false;

let queueData = {};
let stageSingerUids = [];

let stopQueueListener = null;
let stopStageListener = null;
let stopPermissionListener = null;

const participants = new Map();
const remoteAudioElements = new Map();

let joining = false;
let leaving = false;
let permissionBusy = false;

/* =========================================
   HELPERS
========================================= */

const $ = id => document.getElementById(id);

function setStatus(message, error = false) {
  const element = $("livekitStatus");

  if (element) {
    element.textContent = message;
    element.style.color = error ? "#ff7777" : "#e5bd62";
  }
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

    let unsubscribe;

    unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe?.();

      if (user) {
        resolve(user);
      } else {
        reject(new Error("Please sign in before joining."));
      }
    });
  });
}

function getQueueEntries() {
  return Object.entries(queueData).filter(([, person]) => person);
}

function getSingerRegistration(uid) {
  return getQueueEntries().find(([, person]) =>
    person.singerUid === uid || person.uid === uid
  );
}

function isApprovedSinger(uid) {
  const entry = getSingerRegistration(uid);

  return Boolean(
    entry &&
    ["Approved", "Queued", "Playing"].includes(
      String(entry[1].status || "")
    )
  );
}

function displayName(uid) {
  if (uid === currentUser?.uid) {
    return isHost
      ? "Show Host"
      : ($("liveSingerName")?.value.trim() || "Singer");
  }

  const registration = getSingerRegistration(uid);

  return (
    registration?.[1]?.name ||
    registration?.[1]?.singerName ||
    participants.get(uid)?.name ||
    "Participant"
  );
}

/* =========================================
   WORKER REQUEST
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
    margin:18px 0;
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

    <div style="margin-top:15px">
      <label for="liveSingerName">Your name</label>

      <input id="liveSingerName"
        type="text"
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
        Host: turn your camera and microphone on or off here.
        Singers: these controls follow the host's permissions.
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
          style="background:#555;color:white;padding:13px 18px;border:0;border-radius:8px;font-weight:bold;cursor:pointer">
          LEAVE
        </button>

      </div>

      <div id="localPermissionMessage"
        style="color:#e5bd62;font-size:13px;margin-top:12px">
      </div>

    </div>

    <div id="hostStageControls"
      style="display:none;background:#202020;padding:14px;border-radius:10px;margin-top:15px">

      <h3 style="color:#e5bd62">⭐ HOST STAGE CONTROLS</h3>

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
        SELECT MAIN STAGE SINGER(S)
      </button>

      <h3 style="color:#e5bd62;margin-top:20px">
        🎚️ INDIVIDUAL SINGER CONTROLS
      </h3>

      <div id="hostSingerControls">
        No approved singers connected.
      </div>

    </div>

    <h3 style="color:#e5bd62;margin-top:22px">
      ⭐ MAIN STAGE
    </h3>

    <div id="mainStage"
      style="background:#181818;padding:12px;border-radius:10px;min-height:120px">
      Waiting for host...
    </div>

    <h3 style="color:#e5bd62;margin-top:22px">
      🎤 CONNECTED PARTICIPANTS
    </h3>

    <div id="singerGrid"
      style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
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
}

/* =========================================
   HOST VERIFICATION
========================================= */

async function verifyHost() {
  if (!currentUser || !currentShow) return false;

  if (currentShow.hostUid !== currentUser.uid) {
    return false;
  }

  const snapshot = await get(
    ref(db, "hostApplications/" + currentUser.uid)
  );

  if (!snapshot.exists()) return false;

  const application = snapshot.val();
  const now = Date.now();

  return (
    application.status === "Approved" &&
    Number(application.subscriptionStartAt || 0) <= now &&
    Number(application.subscriptionEndAt || 0) > now
  );
}

/* =========================================
   PARTICIPANT TILES
========================================= */

function makeSingerTile(uid, name) {
  const grid = $("singerGrid");
  if (!grid) return;

  let tile = $("singer-" + uid);

  if (!tile) {
    tile = document.createElement("div");
    tile.id = "singer-" + uid;

    tile.style.cssText = `
      background:#252525;
      padding:10px;
      border-radius:10px;
      min-width:0;
      text-align:center;
    `;

    grid.appendChild(tile);
  }

  tile.innerHTML = `
    <p style="color:#e5bd62;font-weight:bold">
      ${escapeText(name)}
    </p>

    <div class="videoBox"
      style="min-height:100px;background:#111;border-radius:8px;overflow:hidden">
    </div>

    <div class="participantState"
      style="font-size:12px;color:#bbb;margin-top:7px">
    </div>
  `;

  updateTileState(uid);
}

function updateTileState(uid) {
  const tile = $("singer-" + uid);
  if (!tile) return;

  const state = tile.querySelector(".participantState");
  const participant = participants.get(uid);

  if (!state || !participant) return;

  state.textContent =
    (participant.videoTrack ? "Camera connected" : "Camera off") +
    " • " +
    (participant.audioTrack ? "Microphone connected" : "Microphone off");
}

function attachVideoToTile(uid, track) {
  const tile = $("singer-" + uid);
  const videoBox = tile?.querySelector(".videoBox");

  if (!videoBox || !track) return;

  const video = track.attach();

  video.autoplay = true;
  video.playsInline = true;
  video.muted = uid === currentUser?.uid;

  video.style.cssText = `
    width:100%;
    max-height:260px;
    object-fit:cover;
    border-radius:8px;
  `;

  videoBox.replaceChildren(video);
}

function addParticipant(uid, name) {
  const old = participants.get(uid) || {};

  participants.set(uid, {
    ...old,
    name: name || old.name || "Participant"
  });

  makeSingerTile(uid, name || "Participant");

  updateSingerOptions();
  renderHostControls();
  showMainStage();
}

function removeParticipant(uid) {
  participants.delete(uid);

  $("singer-" + uid)?.remove();

  const audio = remoteAudioElements.get(uid);

  if (audio) {
    audio.remove();
    remoteAudioElements.delete(uid);
  }

  updateSingerOptions();
  renderHostControls();
  showMainStage();
}

/* =========================================
   MAIN STAGE
========================================= */

function showMainStage() {
  const stage = $("mainStage");
  if (!stage) return;

  stage.innerHTML = "";

  const visibleUids = [];

  if (isHost && currentUser) {
    visibleUids.push(currentUser.uid);
  }

  stageSingerUids.forEach(uid => {
    if (!visibleUids.includes(uid)) {
      visibleUids.push(uid);
    }
  });

  if (!visibleUids.length) {
    stage.textContent = "Waiting for host to select singers...";
    return;
  }

  stage.style.display = "grid";
  stage.style.gridTemplateColumns =
    "repeat(auto-fit,minmax(180px,1fr))";
  stage.style.gap = "12px";

  visibleUids.forEach(uid => {
    const participant = participants.get(uid);

    const box = document.createElement("div");

    box.style.cssText = `
      background:#252525;
      padding:10px;
      border-radius:10px;
      min-width:0;
    `;

    const heading = document.createElement("p");

    heading.textContent =
      uid === currentUser?.uid && isHost
        ? "⭐ SHOW HOST"
        : "🎤 " + displayName(uid);

    heading.style.color = "#e5bd62";
    box.appendChild(heading);

    const videoBox = document.createElement("div");

    videoBox.style.cssText = `
      min-height:120px;
      background:#111;
      border-radius:8px;
      overflow:hidden;
    `;

    const videoTrack =
      uid === currentUser?.uid
        ? localCamera
        : participant?.videoTrack;

    if (videoTrack && !videoTrack.isMuted) {
      const video = videoTrack.attach();

      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;

      video.style.cssText = `
        width:100%;
        max-height:350px;
        object-fit:cover;
      `;

      videoBox.appendChild(video);
    } else {
      videoBox.textContent = "Camera is OFF";
      videoBox.style.color = "#bbb";
      videoBox.style.padding = "40px 5px";
      videoBox.style.textAlign = "center";
    }

    box.appendChild(videoBox);
    stage.appendChild(box);
  });
}

/* =========================================
   CAMERA CONTROLS
========================================= */

async function startCamera() {
  if (!room) {
    throw new Error("Join the auditorium first.");
  }

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

    await room.localParticipant.publishTrack(localCamera, {
      name: "camera"
    });

  } else if (localCamera.isMuted) {
    await localCamera.unmute();
  }

  const own = participants.get(currentUser.uid) || {};

  own.name = isHost
    ? "Show Host"
    : ($("liveSingerName").value || "Singer");

  own.videoTrack = localCamera;

  participants.set(currentUser.uid, own);

  makeSingerTile(currentUser.uid, own.name);
  attachVideoToTile(currentUser.uid, localCamera);

  updateCameraButton();
  showMainStage();
}

async function stopCamera() {
  if (localCamera && !localCamera.isMuted) {
    await localCamera.mute();
  }

  updateCameraButton();
  showMainStage();
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

  const button = $("cameraButton");
  button.disabled = true;

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

    setStatus(
      "Camera error: " + error.message +
      ". Check browser camera permission.",
      true
    );

    alert(
      "Unable to start camera.\n\n" +
      error.message +
      "\n\nCheck that your browser has camera permission."
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

  button.disabled =
    !room || (!isHost && !cameraAllowed);
}

/* =========================================
   MICROPHONE CONTROLS
========================================= */

async function startMicrophone() {
  if (!room) {
    throw new Error("Join the auditorium first.");
  }

  if (!isHost && !micAllowed) {
    throw new Error("The host has not enabled your microphone.");
  }

  if (!localMic) {
    localMic = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });

    await room.localParticipant.publishTrack(localMic, {
      name: "microphone"
    });

  } else if (localMic.isMuted) {
    await localMic.unmute();
  }

  updateMicButton();
}

async function stopMicrophone() {
  if (localMic && !localMic.isMuted) {
    await localMic.mute();
  }

  updateMicButton();
}

async function toggleMicrophone() {
  if (!room) {
    setStatus("Join the auditorium before using the microphone.", true);
    return;
  }

  if (!isHost && !micAllowed) {
    setStatus("The host has not enabled your microphone.", true);
    return;
  }

  const button = $("micButton");
  button.disabled = true;

  try {
    if (localMic && !localMic.isMuted) {
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
      "\n\nCheck your browser microphone permission."
    );
  } finally {
    updateMicButton();
  }
}

function updateMicButton() {
  const button = $("micButton");
  if (!button) return;

  const enabled = Boolean(localMic && !localMic.isMuted);

  button.textContent = enabled
    ? "🎙️ MICROPHONE ON"
    : "🎙️ MICROPHONE OFF";

  button.style.background = enabled ? "#287c48" : "#a71919";

  button.disabled =
    !room || (!isHost && !micAllowed);
}

/* =========================================
   SINGER PERMISSION LISTENER
========================================= */

function listenToMyPermissions() {
  stopListener(stopPermissionListener);
  stopPermissionListener = null;

  if (isHost) {
    micAllowed = true;
    cameraAllowed = true;
    updateMicButton();
    updateCameraButton();
    return;
  }

  stopPermissionListener = onValue(
    ref(db, `participantControls/${showId}/${currentUser.uid}`),

    async snapshot => {
      const controls = snapshot.val() || {};

      cameraAllowed = controls.cameraAllowed === true;
      micAllowed = controls.microphoneAllowed === true;

      $("localPermissionMessage").textContent =
        "Host permissions: Camera " +
        (cameraAllowed ? "ON" : "OFF") +
        " • Microphone " +
        (micAllowed ? "ON" : "OFF");

      try {
        if (cameraAllowed) {
          await startCamera();
        } else {
          await stopCamera();
        }

        if (micAllowed) {
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
      setStatus("Could not read your host permissions.", true);
    }
  );
}

/* =========================================
   HOST SINGER CONTROLS
========================================= */

function renderHostControls() {
  const container = $("hostSingerControls");

  if (!container || !isHost) return;

  const connected = [...participants.entries()].filter(
    ([uid]) =>
      uid !== currentUser?.uid &&
      isApprovedSinger(uid)
  );

  if (!connected.length) {
    container.textContent = "No approved singers connected.";
    return;
  }

  container.innerHTML = "";

  connected.forEach(([uid, participant]) => {
    const row = document.createElement("div");

    row.style.cssText = `
      background:#303030;
      border-radius:9px;
      padding:12px;
      margin:8px 0;
    `;

    const title = document.createElement("strong");
    title.textContent = participant.name || displayName(uid);

    const buttons = document.createElement("div");
    buttons.style.cssText =
      "display:flex;gap:7px;flex-wrap:wrap;margin-top:9px";

    const micButton = document.createElement("button");

    micButton.textContent =
      participant.micAllowed ? "MIC: ON" : "MIC: OFF";

    micButton.style.background =
      participant.micAllowed ? "#287c48" : "#a71919";

    micButton.addEventListener("click", () => {
      setSingerPermission(
        uid,
        "microphone",
        !participant.micAllowed
      );
    });

    const cameraButton = document.createElement("button");

    cameraButton.textContent =
      participant.cameraAllowed ? "CAMERA: ON" : "CAMERA: OFF";

    cameraButton.style.background =
      participant.cameraAllowed ? "#287c48" : "#a71919";

    cameraButton.addEventListener("click", () => {
      setSingerPermission(
        uid,
        "camera",
        !participant.cameraAllowed
      );
    });

    buttons.append(micButton, cameraButton);
    row.append(title, buttons);
    container.appendChild(row);
  });
}

async function setSingerPermission(uid, kind, enabled) {
  if (!isHost || permissionBusy) return;

  permissionBusy = true;

  try {
    setStatus("Updating singer permission...");

    const result = await workerRequest({
      action: "syncPermissions",
      targetUid: uid,
      [kind + "Allowed"]: enabled
    });

    if (result.success === false) {
      throw new Error(result.error || "Permission update failed.");
    }

    const participant = participants.get(uid);

    if (participant) {
      participant[kind + "Allowed"] = enabled;
    }

    renderHostControls();

    setStatus(
      displayName(uid) + ": " + kind +
      (enabled ? " enabled." : " disabled.")
    );

  } catch (error) {
    console.error(error);
    setStatus("Permission update failed: " + error.message, true);
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

  const connected = getQueueEntries().filter(
    ([id, item]) =>
      item &&
      ["Approved", "Queued", "Playing"].includes(
        String(item.status || "")
      ) &&
      participants.has(item.singerUid || item.uid)
  );

  const oldFirst = first.value;
  const oldSecond = second.value;

  const options = connected.map(([id, item]) => `
    <option value="${escapeText(id)}">
      ${escapeText(item.name || item.singerName || "Singer")}
    </option>
  `).join("");

  first.innerHTML =
    '<option value="">Select singer</option>' + options;

  second.innerHTML =
    '<option value="">Select second singer</option>' + options;

  if (connected.some(([id]) => id === oldFirst)) {
    first.value = oldFirst;
  }

  if (connected.some(([id]) => id === oldSecond)) {
    second.value = oldSecond;
  }
}

async function selectMainSingers() {
  if (!isHost) return;

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

  const ids = mode === "duet"
    ? [firstId, secondId]
    : [firstId];

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

    setStatus("Stage singers selected successfully.");

  } catch (error) {
    console.error(error);
    alert("Could not select singers: " + error.message);
  }
}

/* =========================================
   FIREBASE LISTENERS
========================================= */

function listenToStage() {
  stopListener(stopStageListener);

  stopStageListener = onValue(
    ref(db, `liveStage/${showId}`),

    snapshot => {
      const data = snapshot.val() || {};

      stageSingerUids = Array.isArray(data.singerUids)
        ? data.singerUids.filter(Boolean)
        : data.singerUid
          ? [data.singerUid]
          : [];

      showMainStage();
    },

    error => console.error("Stage listener:", error)
  );
}

function listenToHostQueue() {
  stopListener(stopQueueListener);

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
    },

    error => console.error("Queue listener:", error)
  );
}

/* =========================================
   LIVEKIT EVENTS
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

    if (track.kind === "video") {
      old.videoTrack = track;
    }

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

    makeSingerTile(uid, old.name);

    if (track.kind === "video") {
      attachVideoToTile(uid, track);
    }

    updateTileState(uid);
    showMainStage();
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

    updateTileState(uid);
    showMainStage();
    renderHostControls();
  });

  room.on(RoomEvent.Disconnected, () => {
    setStatus("Disconnected from the auditorium.", true);
  });

  room.on(RoomEvent.ParticipantNameChanged, (name, participant) => {
    const old = participants.get(participant.identity) || {};

    old.name = name;
    participants.set(participant.identity, old);

    makeSingerTile(participant.identity, name);
    renderHostControls();
  });
}

/* =========================================
   JOIN AUDITORIUM
========================================= */

async function joinAuditorium() {
  if (room || joining) return;

  joining = true;

  $("joinLiveButton").disabled = true;

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

    const canPublish = isHost ||
      currentRole === "selected-singer" ||
      currentRole === "waiting-singer";

    if (isHost) {
      cameraAllowed = true;
      micAllowed = true;
    } else {
      cameraAllowed = tokenData.cameraAllowed === true;
      micAllowed = tokenData.microphoneAllowed === true;
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

        if (track.kind === "video") {
          old.videoTrack = track;
          attachVideoToTile(uid, track);
        }

        if (track.kind === "audio") {
          old.audioTrack = track;

          const audio = track.attach();
          audio.autoplay = true;
          audio.dataset.livekitRemote = "true";

          document.body.appendChild(audio);
          remoteAudioElements.set(uid, audio);
        }

        participants.set(uid, old);
        updateTileState(uid);
      });
    });

    participants.set(currentUser.uid, {
      name: isHost ? "Show Host" : singerName,
      micAllowed,
      cameraAllowed
    });

    makeSingerTile(
      currentUser.uid,
      isHost ? "Show Host" : singerName
    );

    if (canPublish && cameraAllowed) {
      await startCamera();
    }

    // Host microphone starts OFF.
    // Singer microphone starts only when host permission is ON.
    if (!isHost && canPublish && micAllowed) {
      await startMicrophone();
    }

    if (!isHost) {
      listenToMyPermissions();
    }

    $("leaveButton").disabled = false;

    updateMicButton();
    updateCameraButton();
    showMainStage();
    renderHostControls();

    setStatus(
      isHost
        ? "Host connected. Camera is ON. Turn your microphone ON when ready."
        : canPublish
          ? "Singer connected. Host permissions control your camera and microphone."
          : "Connected as audience."
    );

  } catch (error) {
    console.error("Join error:", error);

    await leaveAuditorium();

    $("joinLiveButton").disabled = false;
    setStatus(error.message || "Could not join the auditorium.", true);

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
    stopListener(stopStageListener);
    stopStageListener = null;

    stopListener(stopQueueListener);
    stopQueueListener = null;

    stopListener(stopPermissionListener);
    stopPermissionListener = null;

    if (room && localMic) {
      try {
        await room.localParticipant.unpublishTrack(localMic);
      } catch (error) {
        console.warn(error);
      }
    }

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

    document
      .querySelectorAll('audio[data-livekit-remote="true"]')
      .forEach(element => element.remove());

    remoteAudioElements.forEach(audio => audio.remove());
    remoteAudioElements.clear();

    participants.clear();

    if ($("singerGrid")) {
      $("singerGrid").innerHTML = "";
    }

    if ($("joinLiveButton")) {
      $("joinLiveButton").disabled = false;
    }

    if ($("micButton")) {
      $("micButton").disabled = true;
      $("micButton").textContent = "🎙️ MICROPHONE OFF";
    }

    if ($("cameraButton")) {
      $("cameraButton").disabled = true;
      $("cameraButton").textContent = "📷 CAMERA OFF";
    }

    if ($("leaveButton")) {
      $("leaveButton").disabled = true;
    }

    if ($("mainStage")) {
      $("mainStage").innerHTML = "Waiting for host...";
    }

    micAllowed = false;
    cameraAllowed = false;

    setStatus("You have left the auditorium.");

  } catch (error) {
    console.error("Leave error:", error);
    setStatus("There was a problem leaving the auditorium.", true);

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

    const snapshot = await get(
      ref(db, `shows/${showId}`)
    );

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

    if (isHost) {
      $("hostStageControls").style.display = "block";
      $("liveSingerName").value = "Show Host";

      $("localPermissionMessage").textContent =
        "Host access verified. Your camera and microphone controls are available above.";

      setStatus(
        "Approved host verified. Join the auditorium to activate your camera."
      );

      listenToHostQueue();

    } else {
      $("liveSingerName").value =
        auth.currentUser?.displayName || "";

      setStatus("Show loaded. Join the auditorium to continue.");
    }

    listenToStage();

  } catch (error) {
    console.error("Initialization error:", error);
    setStatus(error.message || "Unable to initialize show.", true);
  }
}

/* =========================================
   START APPLICATION
========================================= */

createPanel();
initializeShow();
