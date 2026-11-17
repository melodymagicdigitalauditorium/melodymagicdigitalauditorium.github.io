
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
   LiveKit Connection and Role Management
========================================= */

const LIVEKIT_URL =
  "wss://melody-magic-auditorium-wrgjlqio.livekit.cloud";

const TOKEN_SERVER =
  "https://lucky-night-b9bfmelody-magic-token-server.akbusinessenterprisess.workers.dev/";

const params = new URLSearchParams(location.search);

const showId = params.get("showId");
const registrationId = params.get("registrationId");
const requestedMode = (params.get("mode") || "audience").toLowerCase();

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

let permissionListener = null;
let stageListener = null;
let registrationListener = null;

let joining = false;
let leaving = false;


/* =========================================
   BASIC HELPERS
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

  if (text) {
    button.textContent = text;
  }
}

function escapeHTML(value) {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isApproved(value) {
  return ["approved", "queued", "playing"].includes(
    safeText(value).toLowerCase()
  );
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
        padding:11px 14px;
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
        position:relative;
      }

      #mmLiveKitPanel .mm-video-box video {
        width:100%;
        height:100%;
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
        Microphone and camera are OFF until permission is granted.
      </div>
    </div>

    <div id="mmHostControls" class="mm-section" hidden>
      <h3>Host Stage Controls</h3>

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
        Only singers selected for the main stage can receive microphone
        and camera permissions. Audience members remain viewers.
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
}


/* =========================================
   AUTHENTICATION
========================================= */

function waitForAuth() {
  return new Promise((resolve) => {
    if (auth.currentUser) {
      currentUser = auth.currentUser;
      resolve(currentUser);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        currentUser = user;
        unsubscribe();
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

  const hostUid = safeText(currentShow.hostUid);

  if (!hostUid || hostUid !== currentUser.uid) {
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

  if (!start || !end || now < start || now >= end) {
    return false;
  }

  return true;
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
      result.error || result.message || "Auditorium access was denied."
    );
  }

  if (!result.token || !result.url) {
    throw new Error("The token server did not return a LiveKit token.");
  }

  return result;
}


/* =========================================
   ROLE AND TOKEN
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
   LIVEKIT ROOM
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
      throw new Error("The server returned an invalid auditorium role.");
    }

    if (requestedMode === "singer" && currentRole !== "singer") {
      throw new Error("Singer access was not confirmed. Please contact the host.");
    }

    if (!isHost && requestedMode !== "singer" && currentRole !== "audience") {
      throw new Error("Audience access was not confirmed.");
    }

    microphoneAllowed =
      currentRole === "host" && tokenData.microphoneAllowed === true;

    cameraAllowed =
      currentRole === "host" && tokenData.cameraAllowed === true;

    if (currentRole === "singer") {
      microphoneAllowed = tokenData.microphoneAllowed === true;
      cameraAllowed = tokenData.cameraAllowed === true;
    }

    // Audience must never publish.
    if (currentRole === "audience") {
      microphoneAllowed = false;
      cameraAllowed = false;
    }

    room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    registerRoomEvents();

    await room.connect(tokenData.url || LIVEKIT_URL, tokenData.token);

    isJoined = true;

    byId("mmJoinBtn").disabled = true;
    byId("mmLeaveBtn").disabled = false;

    byId("mmRoleInfo").textContent =
      "Connected as: " + currentRole.toUpperCase();

    showMessage("Connected to the live auditorium.", "success");

    updateControlButtons();

    await createVideoTile(
      room.localParticipant,
      true
    );

    // Do not automatically turn on a singer's microphone or camera.
    // Host also starts with both OFF.
    if (currentRole === "host") {
      byId("mmHostControls").hidden = false;
      await loadHostRegistrations();
      listenToStage();
    } else {
      byId("mmHostControls").hidden = true;
      listenToMyPermissions();
      listenToStage();
    }

  } catch (error) {
    console.error(error);

    showMessage(error.message || "Unable to enter auditorium.", "error");

    if (room) {
      try {
        await room.disconnect();
      } catch (e) {
        console.warn(e);
      }

      room = null;
    }

    isJoined = false;

  } finally {
    joining = false;
    setButtonState("mmJoinBtn", isJoined, "Enter Live Auditorium");
  }
}


/* =========================================
   ROOM EVENTS
========================================= */

function registerRoomEvents() {
  if (!room) return;

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    await attachRemoteTrack(track, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    track.detach().forEach((element) => element.remove());
  });

  room.on(RoomEvent.ParticipantConnected, async (participant) => {
    await createVideoTile(participant, false);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    removeParticipantTile(participant.identity);
  });

  room.on(RoomEvent.Disconnected, () => {
    if (!leaving) {
      isJoined = false;
      showMessage("Disconnected from the auditorium.", "warning");
      resetButtons();
    }
  });

  room.on(RoomEvent.LocalTrackPublished, async (publication) => {
    if (publication.track) {
      await attachLocalTrack(publication.track);
    }
  });
}


/* =========================================
   VIDEO TILES
========================================= */

async function createVideoTile(participant, isLocal) {
  const grid = byId("mmVideoGrid");

  if (!grid) return;

  const identity = safeText(participant.identity || "participant");

  const tileId = "mmTile_" + identity.replace(/[^a-zA-Z0-9_-]/g, "_");

  let tile = byId(tileId);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "mm-video-box";
    tile.id = tileId;

    const name = document.createElement("div");
    name.className = "mm-video-name";
    name.textContent = isLocal
      ? "You (" + currentRole + ")"
      : identity;

    tile.appendChild(name);

    const media = document.createElement("div");
    media.id = tileId + "_media";

    tile.appendChild(media);

    grid.appendChild(tile);
  }

  if (participant.trackPublications) {
    participant.trackPublications.forEach((publication) => {
      if (publication.track) {
        attachTrackToTile(publication.track, tileId + "_media");
      }
    });
  }
}

async function attachRemoteTrack(track, participant) {
  await createVideoTile(participant, false);

  const identity = safeText(participant.identity || "participant");

  const tileId = "mmTile_" + identity.replace(/[^a-zA-Z0-9_-]/g, "_");

  attachTrackToTile(track, tileId + "_media");
}

async function attachLocalTrack(track) {
  if (!room) return;

  const tileId =
    "mmTile_" +
    safeText(room.localParticipant.identity)
      .replace(/[^a-zA-Z0-9_-]/g, "_");

  attachTrackToTile(track, tileId + "_media");
}

function attachTrackToTile(track, targetId) {
  const target = byId(targetId);

  if (!target || !track) return;

  const elements = track.attach();

  elements.forEach((element) => {
    element.style.width = "100%";
    element.style.maxHeight = "360px";

    if (track.kind === Track.Kind.Video) {
      element.autoplay = true;
      element.playsInline = true;
    }

    if (track.kind === Track.Kind.Audio) {
      element.autoplay = true;
    }

    target.appendChild(element);
  });
}

function removeParticipantTile(identity) {
  const tileId =
    "mmTile_" +
    safeText(identity).replace(/[^a-zA-Z0-9_-]/g, "_");

  const tile = byId(tileId);

  if (tile) tile.remove();
}


/* =========================================
   MICROPHONE
========================================= */

async function toggleMicrophone() {
  if (!room || !isJoined) return;

  if (currentRole === "audience") {
    showMessage("Audience members cannot use the microphone.", "warning");
    return;
  }

  if (!microphoneAllowed) {
    showMessage("The host has not granted microphone permission.", "warning");
    return;
  }

  try {
    localMicEnabled = !localMicEnabled;

    await room.localParticipant.setMicrophoneEnabled(localMicEnabled);

    updateControlButtons();

  } catch (error) {
    localMicEnabled = false;
    updateControlButtons();

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

  if (currentRole === "audience") {
    showMessage("Audience members cannot use the camera.", "warning");
    return;
  }

  if (!cameraAllowed) {
    showMessage("The host has not granted camera permission.", "warning");
    return;
  }

  try {
    localCameraEnabled = !localCameraEnabled;

    await room.localParticipant.setCameraEnabled(localCameraEnabled);

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
   UPDATE BUTTONS
========================================= */

function updateControlButtons() {
  const mic = byId("mmMicBtn");
  const camera = byId("mmCameraBtn");
  const info = byId("mmPermissionInfo");

  if (!mic || !camera) return;

  const canPublish = currentRole !== "audience";

  mic.disabled = !isJoined || !canPublish || !microphoneAllowed;
  camera.disabled = !isJoined || !canPublish || !cameraAllowed;

  mic.textContent = localMicEnabled
    ? "Microphone ON"
    : "Microphone OFF";

  camera.textContent = localCameraEnabled
    ? "Camera ON"
    : "Camera OFF";

  if (info) {
    if (currentRole === "audience") {
      info.textContent = "Audience mode: microphone and camera are disabled.";
    } else {
      info.textContent =
        "Microphone permission: " + (microphoneAllowed ? "Allowed" : "Not allowed") +
        " | Camera permission: " + (cameraAllowed ? "Allowed" : "Not allowed");
    }
  }
}


/* =========================================
   SINGER PERMISSIONS LISTENER
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

  permissionListener = (snapshot) => {
    const controls = snapshot.val() || {};

    if (currentRole !== "singer") {
      microphoneAllowed = false;
      cameraAllowed = false;
      updateControlButtons();
      return;
    }

    const selected = stageSingerUids.includes(currentUser.uid);

    microphoneAllowed =
      selected && controls.microphoneAllowed === true;

    cameraAllowed =
      selected && controls.cameraAllowed === true;

    if (!microphoneAllowed && localMicEnabled) {
      localMicEnabled = false;

      if (room) {
        room.localParticipant.setMicrophoneEnabled(false).catch(console.warn);
      }
    }

    if (!cameraAllowed && localCameraEnabled) {
      localCameraEnabled = false;

      if (room) {
        room.localParticipant.setCameraEnabled(false).catch(console.warn);
      }
    }

    updateControlButtons();
  };

  onValue(permissionRef, permissionListener);
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

  stageListener = (snapshot) => {
    const stage = snapshot.val() || {};

    stageSingerUids = Array.isArray(stage.singerUids)
      ? stage.singerUids
      : [];

    if (currentRole === "singer" && currentUser) {
      if (!stageSingerUids.includes(currentUser.uid)) {
        microphoneAllowed = false;
        cameraAllowed = false;

        if (localMicEnabled && room) {
          localMicEnabled = false;
          room.localParticipant.setMicrophoneEnabled(false).catch(console.warn);
        }

        if (localCameraEnabled && room) {
          localCameraEnabled = false;
          room.localParticipant.setCameraEnabled(false).catch(console.warn);
        }
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

  registrationListener = (snapshot) => {
    registrations = snapshot.val() || {};

    populateSingerSelectors();
  };

  onValue(registrationsRef, registrationListener);
}

function getApprovedRegistrations() {
  return Object.entries(registrations)
    .map(([id, item]) => ({
      id,
      ...item
    }))
    .filter((item) =>
      item.singerUid &&
      isApproved(item.status)
    );
}

function populateSingerSelectors() {
  const first = byId("mmSingerOne");
  const second = byId("mmSingerTwo");

  if (!first || !second) return;

  const approved = getApprovedRegistrations();

  const options = approved.map((item) => {
    return {
      uid: item.singerUid,
      name: item.singerName || item.name || "Singer",
      id: item.id
    };
  });

  const buildOptions = (select, label) => {
    const previous = select.value;

    select.innerHTML =
      `<option value="">${label}</option>`;

    options.forEach((item) => {
      const option = document.createElement("option");

      option.value = item.uid;
      option.textContent = item.name;

      option.dataset.registrationId = item.id;

      select.appendChild(option);
    });

    if (options.some((item) => item.uid === previous)) {
      select.value = previous;
    }
  };

  buildOptions(first, "Select approved singer");
  buildOptions(second, "Select second singer");
}


/* =========================================
   HOST: ASSIGN MAIN STAGE
========================================= */

async function selectMainSingers() {
  if (!isHost || !currentUser) {
    showMessage("Only the approved host can assign the main stage.", "error");
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

  const selected = selectedUids.map((uid) =>
    approved.find((item) => item.singerUid === uid)
  );

  if (selected.some((item) => !item)) {
    showMessage("One or more selected singers are not approved.", "error");
    return;
  }

  const registrationIds = selected.map((item) => item.id);

  const singerNames = selected.map((item) =>
    item.singerName || item.name || "Singer"
  );

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

    // Set explicit permissions for every approved singer.
    for (const item of approved) {
      const selectedForStage = selectedUids.includes(item.singerUid);

      await workerRequest({
        action: "syncPermissions",
        uid: item.singerUid,
        microphoneAllowed: selectedForStage,
        cameraAllowed: selectedForStage
      });
    }

    showMessage(
      mode.toUpperCase() + " stage assigned successfully.",
      "success"
    );

  } catch (error) {
    console.error(error);

    showMessage(
      "Unable to assign stage: " + error.message,
      "error"
    );
  }
}


/* =========================================
   LEAVE AUDITORIUM
========================================= */

async function leaveAuditorium() {
  if (leaving) return;

  leaving = true;

  try {
    if (room) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch (e) {}

      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch (e) {}

      await room.disconnect();
    }

  } catch (error) {
    console.warn("Leave error:", error);

  } finally {
    room = null;

    isJoined = false;
    localMicEnabled = false;
    localCameraEnabled = false;

    microphoneAllowed = false;
    cameraAllowed = false;

    resetButtons();

    const grid = byId("mmVideoGrid");

    if (grid) grid.innerHTML = "";

    showMessage("You have left the auditorium.");

    leaving = false;
  }
}

function resetButtons() {
  setButtonState("mmJoinBtn", false, "Enter Live Auditorium");
  setButtonState("mmLeaveBtn", true, "Leave Auditorium");

  setButtonState("mmMicBtn", true, "Microphone OFF");
  setButtonState("mmCameraBtn", true, "Camera OFF");

  if (byId("mmRoleInfo")) {
    byId("mmRoleInfo").textContent = "";
  }
}


/* =========================================
   INITIALIZE
========================================= */

async function initializeShow() {
  createPanel();

  if (!showId) {
    showMessage("Show ID is missing. Please open the correct show link.", "error");
    setButtonState("mmJoinBtn", true);
    return;
  }

  if (requestedMode === "singer" && !registrationId) {
    showMessage("Singer registration ID is missing from the entry link.", "error");
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

      showMessage("Host verified. Enter the auditorium when ready.");
    } else if (requestedMode === "singer") {
      byId("mmRoleInfo").textContent =
        "Singer entry requested. Your registration will be checked by the server.";

      showMessage("Singer entry ready. Click Enter Live Auditorium.");
    } else {
      byId("mmRoleInfo").textContent =
        "Audience entry. Microphone and camera are disabled.";

      showMessage("Audience entry ready. Click Enter Live Auditorium.");
    }

    listenToStage();

  } catch (error) {
    console.error(error);

    showMessage(error.message || "Unable to initialize auditorium.", "error");
    setButtonState("mmJoinBtn", true);
  }
}


/* =========================================
   START
========================================= */

initializeShow();
