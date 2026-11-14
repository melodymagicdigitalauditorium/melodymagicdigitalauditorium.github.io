
import {
  Room,
  RoomEvent,
  createLocalAudioTrack,
  createLocalVideoTrack
} from "https://esm.sh/livekit-client@2";

import { VirtualAudioEffects } from "./audio-effects.js";
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

const params = new URLSearchParams(location.search);
const showId = params.get("showId");

let room = null;
let localMic = null;
let localCamera = null;
let audioEffects = null;
let processedMicTrack = null;

let currentUser = null;
let currentShow = null;
let isHost = false;
let currentRole = "unknown";

let registrations = {};
let stageSingerUids = [];
let stageSingerNames = [];

let stopStageListener = null;
let stopQueueListener = null;

const participants = new Map();
const remoteAudioElements = new Map();

let joining = false;
let leaving = false;

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

    let unsubscribe = null;

    unsubscribe = onAuthStateChanged(auth, user => {
      if (unsubscribe) unsubscribe();

      if (user) {
        resolve(user);
      } else {
        reject(new Error("Please sign in before joining the auditorium."));
      }
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

function isSelectedSinger(uid) {
  return stageSingerUids.includes(uid);
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

function displayName(uid) {
  if (uid === currentUser?.uid) {
    const ownName = $("liveSingerName")?.value.trim();
    if (ownName) return ownName;
  }

  const registration = getRegistration(uid);

  if (registration?.[1]?.name) {
    return registration[1].name;
  }

  const participant = participants.get(uid);

  if (participant?.name) {
    return participant.name;
  }

  const index = stageSingerUids.indexOf(uid);

  if (index >= 0 && stageSingerNames[index]) {
    return stageSingerNames[index];
  }

  return "Participant";
}

function isVideoEnabled(uid) {
  const participant = participants.get(uid);
  return Boolean(participant?.videoTrack);
}

function isMicrophoneEnabled(uid) {
  const participant = participants.get(uid);
  return Boolean(participant?.audioTrack);
}

/* =========================================
   FIREBASE AUTHENTICATED WORKER REQUEST
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

  if (!response.ok) {
    throw new Error(
      result.error ||
      result.message ||
      "Worker request failed: " + response.status
    );
  }

  if (result.success === false) {
    throw new Error(result.error || "Worker rejected the request.");
  }

  return result;
}

/* =========================================
   PANEL CREATION
========================================= */

function createPanel() {
  if ($("livekitPanel")) return;

  const panel = document.createElement("section");
  panel.id = "livekitPanel";

  panel.style.cssText = `
    background:#101010;
    color:white;
    padding:16px;
    border-radius:12px;
    margin:15px 0;
    font-family:Arial,sans-serif;
  `;

  panel.innerHTML = `
    <h2 style="color:#e5bd62;margin-top:0">
      🎤 Melody Magic Live Auditorium
    </h2>

    <p id="livekitStatus">Connecting...</p>

    <label>Your name</label>
    <input id="liveSingerName"
      type="text"
      placeholder="Enter your name"
      style="display:block;width:100%;padding:11px;margin:7px 0 14px;box-sizing:border-box">

    <button id="joinLiveButton">JOIN LIVE AUDITORIUM</button>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
      <button id="micButton" disabled>Microphone OFF</button>
      <button id="cameraButton" disabled>Camera OFF</button>
      <button id="monitorButton" disabled>Monitor OFF</button>
      <button id="leaveButton" disabled>LEAVE</button>
    </div>

    <div id="audioControls"
      style="background:#202020;padding:12px;border-radius:10px;margin:12px 0">

      <h3 style="margin-top:0">🎚️ Vocal Effects</h3>

      <label>Echo: <span id="echoValue">20</span>%</label>
      <input id="echoSlider" type="range" min="0" max="100" value="20" style="width:100%">

      <label>Reverb: <span id="reverbValue">20</span>%</label>
      <input id="reverbSlider" type="range" min="0" max="100" value="20" style="width:100%">

      <label>Dry / Wet Mix: <span id="mixValue">25</span>%</label>
      <input id="mixSlider" type="range" min="0" max="100" value="25" style="width:100%">

      <label>Outgoing Voice Volume: <span id="volumeValue">80</span>%</label>
      <input id="volumeSlider" type="range" min="0" max="100" value="80" style="width:100%">

      <label>Monitor Volume: <span id="monitorVolumeValue">35</span>%</label>
      <input id="monitorVolumeSlider" type="range" min="0" max="100" value="35" style="width:100%">

      <p style="font-size:12px;color:#bbb">
        Use headphones to prevent feedback.
      </p>
    </div>

    <div id="hostStageControls"
      style="display:none;background:#202020;padding:12px;border-radius:10px;margin:12px 0">

      <h3 style="margin-top:0;color:#e5bd62">⭐ Host Controls</h3>

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

    <h3>⭐ MAIN STAGE</h3>
    <div id="mainStage"
      style="background:#181818;padding:12px;border-radius:10px;min-height:100px">
      Waiting for the host to select singers...
    </div>

    <h3>🎤 CONNECTED PARTICIPANTS</h3>
    <div id="singerGrid"
      style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
    </div>
  `;

  const area = $("livekitArea");

  if (area) {
    area.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }

  $("joinLiveButton").addEventListener("click", joinAuditorium);
  $("micButton").addEventListener("click", toggleMicrophone);
  $("cameraButton").addEventListener("click", toggleCamera);
  $("monitorButton").addEventListener("click", toggleMonitor);
  $("leaveButton").addEventListener("click", leaveAuditorium);

  $("stageMode").addEventListener("change", () => {
    $("secondSingerArea").style.display =
      $("stageMode").value === "duet" ? "block" : "none";

    updateSingerOptions();
  });

  $("makeStageButton").addEventListener("click", selectMainSingers);

  bindSlider("echoSlider", "echoValue",
    value => audioEffects?.setEcho(value));

  bindSlider("reverbSlider", "reverbValue",
    value => audioEffects?.setReverb(value));

  bindSlider("mixSlider", "mixValue",
    value => audioEffects?.setMix(value));

  bindSlider("volumeSlider", "volumeValue",
    value => audioEffects?.setVolume(value));

  bindSlider("monitorVolumeSlider", "monitorVolumeValue",
    value => audioEffects?.setMonitorVolume(value));
}

function bindSlider(sliderId, valueId, callback) {
  $(sliderId).addEventListener("input", event => {
    const value = Number(event.target.value);
    $(valueId).textContent = value;
    callback(value);
  });
}

/* =========================================
   VIDEO TILES
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
      text-align:center;
      min-width:0;
    `;

    grid.appendChild(tile);
  }

  tile.innerHTML = `
    <p style="color:#e5bd62;font-weight:bold">
      ${escapeText(name)}
    </p>
    <div class="videoBox" style="min-height:90px;background:#111;border-radius:8px"></div>
    <div class="participantState" style="font-size:12px;color:#bbb;margin-top:7px"></div>
  `;

  updateTileState(uid);
}

function updateTileState(uid) {
  const tile = $("singer-" + uid);

  if (!tile) return;

  const state = tile.querySelector(".participantState");

  if (!state) return;

  const participant = participants.get(uid);

  if (!participant) {
    state.textContent = "Not connected";
    return;
  }

  const camera = participant.videoTrack ? "Camera ON" : "Camera OFF";
  const mic = participant.audioTrack ? "Mic publishing" : "Mic not publishing";

  state.textContent = camera + " • " + mic;
}

function attachVideo(uid, track) {
  const tile = $("singer-" + uid);

  if (!tile) return;

  const videoBox = tile.querySelector(".videoBox");

  if (!videoBox) return;

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

function detachVideo(uid) {
  const tile = $("singer-" + uid);

  if (!tile) return;

  const videoBox = tile.querySelector(".videoBox");

  if (videoBox) {
    videoBox.innerHTML =
      '<p style="padding:20px;color:#bbb">Camera is off</p>';
  }
}

function addParticipant(uid, name) {
  const old = participants.get(uid) || {};

  participants.set(uid, {
    ...old,
    name
  });

  makeSingerTile(uid, name);
  updateSingerOptions();
  renderHostControls();
  showMainSinger(stageSingerUids);
}

function removeParticipant(uid) {
  participants.delete(uid);

  const tile = $("singer-" + uid);

  if (tile) tile.remove();

  const audio = remoteAudioElements.get(uid);

  if (audio) {
    audio.remove();
    remoteAudioElements.delete(uid);
  }

  updateSingerOptions();
  renderHostControls();
  showMainSinger(stageSingerUids);
}

/* =========================================
   REMOTE VIDEO STAGE
========================================= */

function showMainSinger(uids) {
  const stage = $("mainStage");

  if (!stage) return;

  stage.innerHTML = "";

  const singerList = Array.isArray(uids)
    ? uids.filter(Boolean)
    : [];

  const visibleUids = [];

  if (currentUser && isHost) {
    visibleUids.push(currentUser.uid);
  }

  singerList.forEach(uid => {
    if (!visibleUids.includes(uid)) {
      visibleUids.push(uid);
    }
  });

  if (!visibleUids.length) {
    stage.textContent = "Waiting for the host to select singers...";
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
      (uid === currentUser?.uid ? "⭐ HOST: " : "🎤 ") +
      displayName(uid);

    heading.style.color = "#e5bd62";

    box.appendChild(heading);

    const videoBox = document.createElement("div");

    if (participant?.videoTrack) {
      const video = participant.videoTrack.attach();

      video.autoplay = true;
      video.playsInline = true;
      video.muted = uid === currentUser?.uid;

      video.style.cssText =
        "width:100%;max-height:350px;object-fit:cover;border-radius:8px";

      videoBox.appendChild(video);
    } else {
      videoBox.textContent = "Camera is off or participant is connecting.";
    }

    box.appendChild(videoBox);
    stage.appendChild(box);
  });
}

/* =========================================
   HOST QUEUE
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

/* =========================================
   HOST CAMERA AND MICROPHONE CONTROLS
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
    title.textContent = participant.name || "Singer";

    const buttons = document.createElement("div");

    buttons.style.cssText =
      "display:flex;gap:7px;flex-wrap:wrap;margin-top:9px";

    const micButton = document.createElement("button");

    micButton.textContent =
      participant.micAllowed
        ? "MIC: ON"
        : "MIC: OFF";

    micButton.style.background =
      participant.micAllowed ? "#287c48" : "#a71919";

    micButton.addEventListener("click", () => {
      setSingerPermission(uid, "microphone", !participant.micAllowed);
    });

    const cameraButton = document.createElement("button");

    cameraButton.textContent =
      participant.cameraAllowed
        ? "CAMERA: ON"
        : "CAMERA: OFF";

    cameraButton.style.background =
      participant.cameraAllowed ? "#287c48" : "#a71919";

    cameraButton.addEventListener("click", () => {
      setSingerPermission(uid, "camera", !participant.cameraAllowed);
    });

    buttons.append(micButton, cameraButton);
    row.append(title, buttons);
    container.appendChild(row);
  });
}

async function setSingerPermission(uid, kind, enabled) {
  if (!isHost) {
    alert("Only the host can control singer permissions.");
    return;
  }

  try {
    setStatus("Updating singer permissions...");

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
      displayName(uid) + " " +
      kind + " permission " +
      (enabled ? "enabled." : "disabled.")
    );

  } catch (error) {
    console.error("Host permission update error:", error);

    setStatus(
      "Permission update failed: " + error.message
    );

    alert(
      "The Worker must support per-singer " +
      kind + " permission updates.\n\n" +
      error.message
    );
  }
}

/* =========================================
   SELECT SOLO / DUET
========================================= */

async function selectMainSingers() {
  if (!isHost || !showId) return;

  const mode = $("stageMode").value;
  const firstId = $("stageSingerOne").value;
  const secondId = $("stageSingerTwo").value;

  if (!firstId) {
    alert("Please select the first singer.");
    return;
  }

  if (mode === "duet" && !secondId) {
    alert("Please select the second singer.");
    return;
  }

  if (mode === "duet" && firstId === secondId) {
    alert("Select two different singers.");
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
    // First select stage in Firebase.
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

    // Then ask the Worker to synchronize permissions.
    for (const uid of uids) {
      await workerRequest({
        action: "syncPermissions",
        targetUid: uid,
        microphoneAllowed: true,
        cameraAllowed: true
      });
    }

    setStatus(
      mode === "duet"
        ? "Duet selected. Host can manage both singers."
        : "Singer selected. Host can manage microphone and camera."
    );

  } catch (error) {
    console.error(error);

    setStatus("Stage selection or permission synchronization failed.");

    alert(
      "Could not complete stage selection.\n" +
      error.message
    );
  }
}

/* =========================================
   FIREBASE STAGE LISTENER
========================================= */

function listenToStage() {
  if (stopStageListener) stopStageListener();

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

      showMainSinger(stageSingerUids);

      if (currentUser && !isHost) {
        if (!isSelectedSinger(currentUser.uid)) {
          enforceLocalMicOff();
          setStatus("Waiting for host selection. Microphone OFF.");
        } else {
          setStatus("You are selected for the stage. Host controls your microphone.");
        }
      }

      renderHostControls();
    },
    error => {
      console.error("Stage listener error:", error);
    }
  );
}

async function enforceLocalMicOff() {
  if (localMic && !localMic.isMuted) {
    try {
      await localMic.mute();
    } catch (error) {
      console.error(error);
    }
  }

  if (audioEffects?.setMuted) {
    audioEffects.setMuted(true);
  }

  updateMicButton();
}

/* =========================================
   QUEUE LISTENER
========================================= */

function listenToHostQueue() {
  if (stopQueueListener) stopQueueListener();

  stopQueueListener = onValue(
    ref(db, `showRegistrations/${showId}`),
    snapshot => {
      registrations = snapshot.val() || {};

      updateSingerOptions();
      renderHostControls();
    },
    error => {
      console.error("Queue listener error:", error);
    }
  );
}

/* =========================================
   SHOW INITIALIZATION
========================================= */

async function initializeShow() {
  try {
    if (!showId) {
      setStatus("Show ID is missing.");
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
      listenToHostQueue();
    }

    listenToStage();

    setStatus(
      isHost
        ? "Host verified. Join to manage the stage."
        : "Show loaded. Join the auditorium."
    );

  } catch (error) {
    console.error(error);
    setStatus(error.message || "Unable to initialize auditorium.");
  }
}

/* =========================================
   BUTTON STATES
========================================= */

function updateMicButton() {
  if (!localMic) return;

  $("micButton").textContent =
    localMic.isMuted ? "Microphone OFF" : "Microphone ON";
}

function updateCameraButton() {
  if (!localCamera) return;

  $("cameraButton").textContent =
    localCamera.isMuted ? "Camera OFF" : "Camera ON";
}

function updateMonitorButton(enabled) {
  $("monitorButton").textContent =
    enabled ? "Monitor ON" : "Monitor OFF";
}

/* =========================================
   JOIN AUDITORIUM
========================================= */

async function joinAuditorium() {
  if (room || joining) return;

  joining = true;

  try {
    currentUser = await waitForUser();

    const singerName =
      $("liveSingerName").value.trim() || "Singer";

    $("joinLiveButton").disabled = true;

    setStatus("Requesting secure auditorium access...");

    // Correct authenticated Worker request.
    const tokenData = await workerRequest({
      action: "join",
      name: singerName
    });

    if (!tokenData.token) {
      throw new Error("Worker did not return a LiveKit token.");
    }

    currentRole = tokenData.role || "audience";

    // Audience must not create local publishing tracks.
    const canPublish = tokenData.role !== "audience";

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
      const old = participants.get(participant.identity) || {};

      if (track.kind === "video") {
        old.videoTrack = track;
        attachVideo(participant.identity, track);
      }

      if (track.kind === "audio") {
        old.audioTrack = track;

        const audio = track.attach();

        audio.autoplay = true;
        audio.dataset.livekitRemote = "true";

        document.body.appendChild(audio);

        const previous = remoteAudioElements.get(participant.identity);

        if (previous) previous.remove();

        remoteAudioElements.set(participant.identity, audio);
      }

      old.name = participant.name || participant.identity;

      participants.set(participant.identity, old);

      updateTileState(participant.identity);
      showMainSinger(stageSingerUids);
      renderHostControls();
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      track.detach().forEach(element => element.remove());

      const old = participants.get(participant.identity);

      if (old) {
        if (track.kind === "video") old.videoTrack = null;
        if (track.kind === "audio") old.audioTrack = null;
      }

      if (track.kind === "video") {
        detachVideo(participant.identity);
      }

      if (track.kind === "audio") {
        const audio = remoteAudioElements.get(participant.identity);
        if (audio) audio.remove();
        remoteAudioElements.delete(participant.identity);
      }

      updateTileState(participant.identity);
      showMainSinger(stageSingerUids);
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

    addParticipant(
      currentUser.uid,
      singerName
    );

    if (canPublish) {
      // Create microphone but keep it muted initially.
      localMic = await createLocalAudioTrack({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      });

      audioEffects = new VirtualAudioEffects();

      processedMicTrack = await audioEffects.start(
        localMic.mediaStreamTrack
      );

      // Start muted. Host permissions decide when it can publish.
      if (audioEffects.setMuted) {
        audioEffects.setMuted(true);
      }

      await room.localParticipant.publishTrack(
        processedMicTrack,
        { name: "processed-microphone" }
      );

      await localMic.mute();

      // Create camera ON by default.
      try {
        localCamera = await createLocalVideoTrack({
          facingMode: "user"
        });

        await room.localParticipant.publishTrack(localCamera);

        attachVideo(currentUser.uid, localCamera);

      } catch (cameraError) {
        console.warn("Camera unavailable:", cameraError);
      }
    }

    $("micButton").disabled = !canPublish;
    $("cameraButton").disabled = !localCamera;
    $("monitorButton").disabled = !canPublish;
    $("leaveButton").disabled = false;

    updateMicButton();
    updateCameraButton();
    updateMonitorButton(false);

    showMainSinger(stageSingerUids);

    setStatus(
      canPublish
        ? "Connected. Camera started. Microphone is OFF until host permission."
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
   LOCAL MIC / CAMERA
========================================= */

async function toggleMicrophone() {
  if (!localMic || !currentUser) return;

  if (!isHost && !isSelectedSinger(currentUser.uid)) {
    alert("You are waiting. The host must select you first.");
    return;
  }

  try {
    if (localMic.isMuted) {
      // Local UI permission is not a security boundary.
      // Worker / LiveKit permissions must also allow publishing.
      if (audioEffects?.setMuted) {
        audioEffects.setMuted(false);
      }

      await localMic.unmute();

    } else {
      await localMic.mute();

      if (audioEffects?.setMuted) {
        audioEffects.setMuted(true);
      }
    }

    updateMicButton();

  } catch (error) {
    console.error(error);
    setStatus("Microphone permission denied by LiveKit.");
  }
}

async function toggleCamera() {
  if (!localCamera) return;

  try {
    if (localCamera.isMuted) {
      await localCamera.unmute();
    } else {
      await localCamera.mute();
    }

    updateCameraButton();

  } catch (error) {
    console.error(error);
    setStatus("Could not change camera state.");
  }
}

async function toggleMonitor() {
  if (!audioEffects) return;

  try {
    const enabled = !audioEffects.monitorEnabled;

    await audioEffects.setMonitor(enabled);

    updateMonitorButton(enabled);

  } catch (error) {
    console.error(error);
    setStatus("Could not change headphone monitoring.");
  }
}

/* =========================================
   LEAVE AUDITORIUM
========================================= */

async function leaveAuditorium() {
  if (leaving) return;

  leaving = true;

  try {
    if (stopStageListener) {
      stopStageListener();
      stopStageListener = null;
    }

    if (stopQueueListener) {
      stopQueueListener();
      stopQueueListener = null;
    }

    if (localMic) {
      localMic.stop();
      localMic = null;
    }

    if (localCamera) {
      localCamera.stop();
      localCamera = null;
    }

    if (audioEffects) {
      audioEffects.stop();
      audioEffects = null;
    }

    processedMicTrack = null;

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
      $("micButton").textContent = "Microphone OFF";
    }

    if ($("cameraButton")) {
      $("cameraButton").disabled = true;
      $("cameraButton").textContent = "Camera OFF";
    }

    if ($("monitorButton")) {
      $("monitorButton").disabled = true;
      updateMonitorButton(false);
    }

    if ($("leaveButton")) {
      $("leaveButton").disabled = true;
    }

    if ($("mainStage")) {
      $("mainStage").innerHTML =
        "Waiting for the host to select singers...";
    }

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
