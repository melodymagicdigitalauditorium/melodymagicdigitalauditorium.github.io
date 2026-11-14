
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

let room = null;
let currentUser = null;
let currentShow = null;

let isHost = false;
let currentRole = "unknown";

let localMic = null;
let localCamera = null;

let micAllowed = false;
let cameraAllowed = false;

let registrations = {};
let stageSingerUids = [];
let stageSingerNames = [];

let stopStageListener = null;
let stopQueueListener = null;
let stopPermissionListener = null;

const participants = new Map();
const remoteAudioElements = new Map();

let joining = false;
let leaving = false;
let permissionUpdateRunning = false;

/* =========================================
   HELPERS
========================================= */

const $ = id => document.getElementById(id);

function setStatus(message) {
  const element = $("livekitStatus");
  if (element) element.textContent = message;
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

      if (user) resolve(user);
      else reject(new Error("Please sign in before joining."));
    });
  });
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

function getRegistration(uid) {
  return Object.entries(registrations).find(
    ([id, item]) =>
      item &&
      item.singerUid === uid &&
      ["Approved", "Queued"].includes(String(item.status || ""))
  );
}

function isApprovedSinger(uid) {
  return Boolean(getRegistration(uid));
}

function isSelectedSinger(uid) {
  return stageSingerUids.includes(uid);
}

function displayName(uid) {
  if (uid === currentUser?.uid) {
    return $("liveSingerName")?.value.trim() ||
      (isHost ? "Show Host" : "Singer");
  }

  const registration = getRegistration(uid);

  if (registration?.[1]?.name) {
    return registration[1].name;
  }

  return participants.get(uid)?.name || "Participant";
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
   PANEL
========================================= */

function createPanel() {
  if ($("livekitPanel")) return;

  const panel = document.createElement("section");
  panel.id = "livekitPanel";

  panel.style.cssText = `
    background:#101010;
    color:#fff;
    padding:16px;
    border-radius:12px;
    margin:15px 0;
    font-family:Arial,sans-serif;
  `;

  panel.innerHTML = `
    <h2 style="color:#e5bd62;margin-top:0">
      🎤 Melody Magic Live Auditorium
    </h2>

    <p id="livekitStatus">Loading show...</p>

    <label>Your name</label>
    <input id="liveSingerName"
      type="text"
      placeholder="Enter your name"
      style="display:block;width:100%;padding:11px;margin:7px 0 14px;box-sizing:border-box">

    <button id="joinLiveButton">JOIN LIVE AUDITORIUM</button>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
      <button id="micButton" disabled>MICROPHONE OFF</button>
      <button id="cameraButton" disabled>CAMERA OFF</button>
      <button id="leaveButton" disabled>LEAVE</button>
    </div>

    <div id="localPermissionMessage"
      style="color:#e5bd62;font-size:13px;margin:8px 0">
    </div>

    <div id="hostStageControls"
      style="display:none;background:#202020;padding:12px;border-radius:10px;margin:12px 0">

      <h3 style="color:#e5bd62">⭐ Host Controls</h3>

      <label>Stage type</label>
      <select id="stageMode" style="display:block;width:100%;padding:10px;margin:7px 0">
        <option value="solo">Solo</option>
        <option value="duet">Duet</option>
      </select>

      <label>First singer</label>
      <select id="stageSingerOne" style="display:block;width:100%;padding:10px;margin:7px 0">
        <option value="">Select singer</option>
      </select>

      <div id="secondSingerArea" style="display:none">
        <label>Second singer</label>
        <select id="stageSingerTwo" style="display:block;width:100%;padding:10px;margin:7px 0">
          <option value="">Select second singer</option>
        </select>
      </div>

      <button id="makeStageButton">
        SELECT MAIN STAGE SINGER(S)
      </button>

      <h3>🎛️ Individual Singer Controls</h3>
      <div id="hostSingerControls">
        No singers connected.
      </div>
    </div>

    <h3 style="color:#e5bd62">⭐ MAIN STAGE</h3>
    <div id="mainStage"
      style="background:#181818;padding:12px;border-radius:10px;min-height:120px">
      Waiting for host...
    </div>

    <h3>🎤 CONNECTED PARTICIPANTS</h3>
    <div id="singerGrid"
      style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
    </div>
  `;

  const area = $("livekitArea");

  if (area) area.appendChild(panel);
  else document.body.appendChild(panel);

  $("joinLiveButton").addEventListener("click", joinAuditorium);
  $("micButton").addEventListener("click", toggleMicrophone);
  $("cameraButton").addEventListener("click", toggleCamera);
  $("leaveButton").addEventListener("click", leaveAuditorium);

  $("stageMode").addEventListener("change", () => {
    $("secondSingerArea").style.display =
      $("stageMode").value === "duet" ? "block" : "none";

    updateSingerOptions();
  });

  $("makeStageButton").addEventListener("click", selectMainSingers);
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
    tile.style.cssText =
      "background:#252525;padding:10px;border-radius:10px;min-width:0;text-align:center";

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
    (participant.videoTrack ? "Camera ON" : "Camera OFF") +
    " • " +
    (participant.audioTrack ? "Mic connected" : "Mic not connected");
}

function attachVideoToTile(uid, track) {
  const tile = $("singer-" + uid);
  const videoBox = tile?.querySelector(".videoBox");

  if (!videoBox) return;

  const video = track.attach();

  video.autoplay = true;
  video.playsInline = true;
  video.muted = uid === currentUser?.uid;

  video.style.cssText =
    "width:100%;max-height:260px;object-fit:cover;border-radius:8px";

  videoBox.replaceChildren(video);
}

function removeParticipant(uid) {
  participants.delete(uid);

  $("singer-" + uid)?.remove();

  const audio = remoteAudioElements.get(uid);
  if (audio) audio.remove();

  remoteAudioElements.delete(uid);

  updateSingerOptions();
  renderHostControls();
  showMainStage();
}

function addParticipant(uid, name) {
  const old = participants.get(uid) || {};

  participants.set(uid, {
    ...old,
    name: name || "Participant"
  });

  makeSingerTile(uid, name || "Participant");

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
    if (!visibleUids.includes(uid)) visibleUids.push(uid);
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
    box.style.cssText =
      "background:#252525;padding:10px;border-radius:10px;min-width:0";

    const heading = document.createElement("p");

    heading.textContent =
      uid === currentUser?.uid && isHost
        ? "⭐ SHOW HOST"
        : "🎤 " + displayName(uid);

    heading.style.color = "#e5bd62";
    box.appendChild(heading);

    const videoBox = document.createElement("div");

    videoBox.style.cssText =
      "min-height:120px;background:#111;border-radius:8px;overflow:hidden";

    const videoTrack =
      uid === currentUser?.uid
        ? localCamera
        : participant?.videoTrack;

    if (videoTrack && !videoTrack.isMuted) {
      const video = videoTrack.attach();

      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;

      video.style.cssText =
        "width:100%;max-height:350px;object-fit:cover";

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
   LOCAL TRACKS
========================================= */

async function startCamera() {
  if (!room || !cameraAllowed) return;

  if (!localCamera) {
    localCamera = await createLocalVideoTrack({
      facingMode: "user"
    });

    await room.localParticipant.publishTrack(localCamera, {
      name: "camera"
    });
  } else if (localCamera.isMuted) {
    await localCamera.unmute();
  }

  const own = participants.get(currentUser.uid) || {
    name: isHost ? "Show Host" : "Singer"
  };

  own.videoTrack = localCamera;
  participants.set(currentUser.uid, own);

  makeSingerTile(
    currentUser.uid,
    isHost ? "Show Host" : displayName(currentUser.uid)
  );

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

async function startMicrophone() {
  if (!room || !micAllowed) return;

  if (!localMic) {
    localMic = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });

    await room.localParticipant.publishTrack(localMic, {
      name: "microphone"
    });
  }

  if (localMic.isMuted) {
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

/* =========================================
   BUTTON STATES
========================================= */

function updateMicButton() {
  const button = $("micButton");
  if (!button) return;

  const enabled = Boolean(localMic && !localMic.isMuted);

  button.textContent = enabled
    ? "MICROPHONE ON"
    : "MICROPHONE OFF";

  button.style.background = enabled ? "#287c48" : "#a71919";
  button.disabled = !isHost && !micAllowed;
}

function updateCameraButton() {
  const button = $("cameraButton");
  if (!button) return;

  const enabled = Boolean(localCamera && !localCamera.isMuted);

  button.textContent = enabled
    ? "CAMERA ON"
    : "CAMERA OFF";

  button.style.background = enabled ? "#287c48" : "#a71919";
  button.disabled = !isHost && !cameraAllowed;
}

/* =========================================
   LOCAL BUTTON ACTIONS
========================================= */

async function toggleMicrophone() {
  if (!room) return;

  if (!isHost && !micAllowed) {
    setStatus("The host has not enabled your microphone.");
    return;
  }

  try {
    if (localMic && !localMic.isMuted) {
      await stopMicrophone();
    } else {
      await startMicrophone();
    }
  } catch (error) {
    console.error(error);
    setStatus("Microphone error: " + error.message);
  }
}

async function toggleCamera() {
  if (!room) return;

  if (!isHost && !cameraAllowed) {
    setStatus("The host has not enabled your camera.");
    return;
  }

  try {
    if (localCamera && !localCamera.isMuted) {
      await stopCamera();
    } else {
      await startCamera();
    }
  } catch (error) {
    console.error(error);
    setStatus("Camera error: " + error.message);
  }
}

/* =========================================
   SINGER PERMISSION LISTENER
========================================= */

function listenToMyPermissions(initialData) {
  if (stopPermissionListener) {
    stopPermissionListener();
    stopPermissionListener = null;
  }

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

      cameraAllowed =
        typeof controls.cameraAllowed === "boolean"
          ? controls.cameraAllowed
          : Boolean(initialData.cameraAllowed);

      micAllowed =
        typeof controls.microphoneAllowed === "boolean"
          ? controls.microphoneAllowed
          : false;

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

        $("localPermissionMessage").textContent =
          "Host permissions: Camera " +
          (cameraAllowed ? "ON" : "OFF") +
          " • Microphone " +
          (micAllowed ? "ON" : "OFF");

      } catch (error) {
        console.error("Permission application error:", error);
        setStatus("Could not apply host permissions: " + error.message);
      }

      updateMicButton();
      updateCameraButton();
    },
    error => {
      console.error("Permission listener error:", error);
      setStatus("Could not read your host permissions.");
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
    ([uid]) => uid !== currentUser?.uid && isApprovedSinger(uid)
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
    title.textContent = participant.name || "Singer";

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
  if (!isHost) return;

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
    setStatus("Permission update failed: " + error.message);
    alert(error.message);
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

  const connected = Object.entries(registrations).filter(
    ([id, item]) =>
      item &&
      ["Approved", "Queued"].includes(String(item.status || "")) &&
      participants.has(item.singerUid)
  );

  const oldFirst = first.value;
  const oldSecond = second.value;

  const options = connected.map(([id, item]) => `
    <option value="${escapeText(id)}">
      ${escapeText(item.name || "Singer")}
    </option>
  `).join("");

  first.innerHTML =
    '<option value="">Select first singer</option>' + options;

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

  const selected = ids.map(id => registrations[id]);

  if (selected.some(item =>
    !item ||
    !["Approved", "Queued"].includes(String(item.status || "")) ||
    !participants.has(item.singerUid)
  )) {
    alert("Selected singers must be approved and connected.");
    return;
  }

  const uids = selected.map(item => item.singerUid);
  const names = selected.map(item => item.name || "Singer");

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

    setStatus("Stage singers selected. Enable their microphones using Host Controls.");

  } catch (error) {
    console.error(error);
    alert("Could not select singers: " + error.message);
  }
}

/* =========================================
   FIREBASE LISTENERS
========================================= */

function listenToStage() {
  stopStageListener?.();

  stopStageListener = onValue(
    ref(db, `liveStage/${showId}`),
    snapshot => {
      const data = snapshot.val();

      stageSingerUids = Array.isArray(data?.singerUids)
        ? data.singerUids.filter(Boolean)
        : data?.singerUid
          ? [data.singerUid]
          : [];

      stageSingerNames = Array.isArray(data?.singerNames)
        ? data.singerNames
        : data?.singerName
          ? [data.singerName]
          : [];

      showMainStage();
    },
    error => console.error("Stage listener:", error)
  );
}

function listenToHostQueue() {
  stopQueueListener?.();

  stopQueueListener = onValue(
    ref(db, `showRegistrations/${showId}`),
    snapshot => {
      registrations = snapshot.val() || {};

      // Refresh permission state from connected singer objects.
      for (const [uid, participant] of participants.entries()) {
        const registration = getRegistration(uid);

        if (registration) {
          participant.name =
            registration[1].name || participant.name;
        }
      }

      updateSingerOptions();
      renderHostControls();
    },
    error => console.error("Queue listener:", error)
  );
}

/* =========================================
   INITIALIZE SHOW
========================================= */

async function initializeShow() {
  try {
    if (!showId) {
      setStatus("Show ID is missing from the page URL.");
      return;
    }

    currentUser = await waitForUser();

    const snapshot = await get(ref(db, `shows/${showId}`));

    if (!snapshot.exists()) {
      setStatus("Show not found.");
      return;
    }

    currentShow = snapshot.val();

    if (currentShow.status !== "Published") {
      setStatus("This show is not published.");
      return;
    }

    isHost = currentShow.hostUid === currentUser.uid;

    if (isHost) {
      $("hostStageControls").style.display = "block";
      $("liveSingerName").value = "Show Host";
      setStatus("Host verified. Join to start your camera and microphone.");
      listenToHostQueue();
    } else {
      setStatus("Show loaded. Sign in and join the auditorium.");
    }

    listenToStage();

  } catch (error) {
    console.error(error);
    setStatus(error.message || "Unable to initialize show.");
  }
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

    currentRole = tokenData.role || "audience";

    const canPublish = currentRole !== "audience";

    cameraAllowed = isHost
      ? true
      : Boolean(tokenData.cameraAllowed);

    micAllowed = isHost
      ? true
      : Boolean(tokenData.microphoneAllowed);

    room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    /* Remote participant events */

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

        const previous = remoteAudioElements.get(uid);
        if (previous) previous.remove();

        remoteAudioElements.set(uid, audio);
      }

      participants.set(uid, old);

      makeSingerTile(uid, old.name);
      if (track.kind === "video") attachVideoToTile(uid, track);

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
      setStatus("Disconnected from the auditorium.");
    });

    room.on(RoomEvent.ParticipantNameChanged, (name, participant) => {
      const old = participants.get(participant.identity) || {};
      old.name = name;
      participants.set(participant.identity, old);

      makeSingerTile(participant.identity, name);
      renderHostControls();
    });

    await room.connect(
      tokenData.url || LIVEKIT_URL,
      tokenData.token
    );

    // Add already-connected remote participants.
    room.remoteParticipants.forEach(participant => {
      addParticipant(
        participant.identity,
        participant.name || participant.identity
      );

      participant.trackPublications.forEach(publication => {
        if (publication.track) {
          const track = publication.track;
          const old = participants.get(participant.identity) || {};

          if (track.kind === "video") {
            old.videoTrack = track;
            attachVideoToTile(participant.identity, track);
          }

          if (track.kind === "audio") {
            old.audioTrack = track;
            const audio = track.attach();
            audio.autoplay = true;
            audio.dataset.livekitRemote = "true";
            document.body.appendChild(audio);
            remoteAudioElements.set(participant.identity, audio);
          }

          participants.set(participant.identity, old);
        }
      });
    });

    // Register local participant as host or singer.
    participants.set(currentUser.uid, {
      name: isHost ? "Show Host" : singerName,
      micAllowed,
      cameraAllowed
    });

    makeSingerTile(
      currentUser.uid,
      isHost ? "Show Host" : singerName
    );

    if (canPublish) {
      // Camera starts ON when permission allows it.
      if (cameraAllowed) {
        await startCamera();
      }

      // Host microphone starts OFF; host can turn it ON.
      // Singer microphone starts only when host grants permission.
      if (micAllowed && !isHost) {
        await startMicrophone();
      }
    }

    if (!isHost) {
      listenToMyPermissions(tokenData);
    }

    $("micButton").disabled = !isHost && !micAllowed;
    $("cameraButton").disabled = !isHost && !cameraAllowed;
    $("leaveButton").disabled = false;

    updateMicButton();
    updateCameraButton();

    showMainStage();

    setStatus(
      isHost
        ? "You are LIVE as Show Host. Camera is ready. Use the buttons to control your mic and camera."
        : canPublish
          ? "Connected. The host controls your microphone and camera permissions."
          : "Connected as audience. You can watch and listen."
    );

    renderHostControls();

  } catch (error) {
    console.error("Join error:", error);

    await leaveAuditorium();

    $("joinLiveButton").disabled = false;
    setStatus(error.message || "Could not join the auditorium.");

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
    stopStageListener?.();
    stopStageListener = null;

    stopQueueListener?.();
    stopQueueListener = null;

    stopPermissionListener?.();
    stopPermissionListener = null;

    if (localMic) {
      try {
        await room?.localParticipant.unpublishTrack(localMic);
      } catch (error) {
        console.warn(error);
      }

      localMic.stop();
      localMic = null;
    }

    if (localCamera) {
      try {
        await room?.localParticipant.unpublishTrack(localCamera);
      } catch (error) {
        console.warn(error);
      }

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

    if ($("singerGrid")) $("singerGrid").innerHTML = "";

    if ($("joinLiveButton")) $("joinLiveButton").disabled = false;

    if ($("micButton")) {
      $("micButton").disabled = true;
      $("micButton").textContent = "MICROPHONE OFF";
    }

    if ($("cameraButton")) {
      $("cameraButton").disabled = true;
      $("cameraButton").textContent = "CAMERA OFF";
    }

    if ($("leaveButton")) $("leaveButton").disabled = true;

    if ($("mainStage")) {
      $("mainStage").innerHTML = "Waiting for host...";
    }

    micAllowed = false;
    cameraAllowed = false;

    setStatus("You have left the auditorium.");

  } catch (error) {
    console.error("Leave error:", error);
    setStatus("There was a problem leaving the auditorium.");

  } finally {
    leaving = false;
  }
}

/* =========================================
   START
========================================= */

createPanel();
initializeShow();
