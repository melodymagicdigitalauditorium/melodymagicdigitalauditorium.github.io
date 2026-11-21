
const WORKER_VERSION = "melody-magic-mobile-entry-auto-join-2026-11-21";

const FIREBASE_PROJECT_ID = "melody-magic-auditorium";

const FIREBASE_DATABASE_URL =
  "https://melody-magic-auditorium-default-rtdb.asia-southeast1.firebasedatabase.app";

const ALLOWED_ORIGINS = new Set([
  "https://melodymagicdigitalauditorium.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080"
]);

const TOKEN_TTL_SECONDS = 3600;

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";


export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const isAllowedOrigin = ALLOWED_ORIGINS.has(origin);

    const corsHeaders = {
      ...(isAllowedOrigin
        ? { "Access-Control-Allow-Origin": origin }
        : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    };

    if (!isAllowedOrigin) {
      return json(
        { error: "Origin not allowed" },
        403,
        { "Vary": "Origin" }
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method !== "POST") {
      return json({ error: "POST required" }, 405, corsHeaders);
    }

    try {
      if (
        !env.LIVEKIT_API_KEY ||
        !env.LIVEKIT_API_SECRET ||
        !env.LIVEKIT_URL
      ) {
        throw new Error("LiveKit Worker secrets are not configured.");
      }

      const body = await request.json();

      const action = String(body.action || "").trim();
      const showId = String(body.showId || "").trim();

      const authorization =
        request.headers.get("Authorization") || "";

      const idToken = authorization
        .replace(/^Bearer\s+/i, "")
        .trim();

      if (!idToken) {
        return json({ error: "Firebase login required" }, 401, corsHeaders);
      }

      const user = await verifyFirebaseToken(idToken);

      if (!user || !user.uid) {
        return json({ error: "Invalid Firebase login" }, 401, corsHeaders);
      }

      if (!showId) {
        return json({ error: "Show ID required" }, 400, corsHeaders);
      }

      const show = await readDB(`shows/${showId}`, idToken);

      if (!isPublishedShow(show)) {
        return json({
          error: "Show is not published or available.",
          workerVersion: WORKER_VERSION,
          action
        }, 403, corsHeaders);
      }

      const lifecycle = getShowLifecycle(show);

      if (lifecycle.ended) {
        return json({
          error: "This show has ended. New auditorium entries are closed.",
          showEnded: true,
          workerVersion: WORKER_VERSION,
          action
        }, 403, corsHeaders);
      }


      /* =====================================
         CHECK SINGER MOBILE REGISTRATION
      ===================================== */

      if (action === "checkSingerRegistration") {
        const mobile = normalizeMobile(body.mobile || "");

        if (!/^\\d{10}$/.test(mobile)) {
          return json({ error: "Enter your registered 10-digit mobile number." }, 400, corsHeaders);
        }

        const registration = await getSingerRegistration(
          showId,
          user.uid,
          idToken,
          "",
          mobile
        );

        if (!registration) {
          return json({
            error: "No registration was found for this mobile number in this show.",
            workerVersion: WORKER_VERSION,
            action
          }, 404, corsHeaders);
        }

        if (!isSingerApproved(registration.status)) {
          return json({
            error: "Your registration is not approved yet. Please wait for host approval.",
            registrationStatus: registration.status || "Pending",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        return json({
          success: true,
          action,
          workerVersion: WORKER_VERSION,
          registrationId: registration.registrationId,
          singerUid: registration.singerUid,
          singerName: registration.singerName || registration.name || "Singer",
          status: registration.status
        }, 200, corsHeaders);
      }

      /* =====================================
         SINGER ENTRY
      ===================================== */

      if (action === "joinSinger") {
        const requestedRegistrationId =
          String(body.registrationId || "").trim();
        const requestedMobile = normalizeMobile(body.mobile || "");

        const registration = await getSingerRegistration(
          showId,
          user.uid,
          idToken,
          requestedRegistrationId,
          requestedMobile
        );

        if (
          !registration ||
          !isSingerApproved(registration.status)
        ) {
          return json({
            error: "This singer registration is not approved. Please contact the host.",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        if (!lifecycle.started) {
          return json({
            error: "Your entry is confirmed. Please wait for the host to start the show.",
            showNotStarted: true,
            scheduledAt: lifecycle.scheduledAt || 0,
            registrationConfirmed: true,
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const participantUid = registration.singerUid || user.uid;
        const stage = await readDB(`liveStage/${showId}`, idToken);

        const selected = isSingerSelected(
          stage,
          participantUid,
          registration
        );

        const controls = await readDB(
          `participantControls/${showId}/${participantUid}`,
          idToken
        ) || {};

        const cameraAllowed = true;

        const microphoneAllowed =
          selected &&
          controls.microphoneAllowed === true;

        const token = await createLiveKitToken(env, {
          uid: participantUid,
          showId,
          name:
            registration.singerName ||
            registration.name ||
            body.name ||
            "Singer",
          role: "singer",
          canPublishAudio: microphoneAllowed,
          canPublishVideo: cameraAllowed
        });

        return json({
          success: true,
          role: "singer",
          action: "joinSinger",
          workerVersion: WORKER_VERSION,
          authenticatedUid: user.uid,
          singerUid: participantUid,
          registrationConfirmed: true,
          singerStageStatus: selected ? "selected" : "waiting",
          registrationId: registration.registrationId,
          microphoneAllowed,
          cameraAllowed,
          canPublishAudio: microphoneAllowed,
          canPublishVideo: cameraAllowed,
          canPublishData: true,
          token,
          url: env.LIVEKIT_URL
        }, 200, corsHeaders);
      }


      /* =====================================
         AUDIENCE ENTRY
      ===================================== */

      if (action === "joinAudience") {
        if (!lifecycle.started) {
          return json({
            error: "This show has not started yet. Please enter when the host starts the show.",
            showNotStarted: true,
            scheduledAt: lifecycle.scheduledAt || 0,
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const blocked = await readDB(
          `audienceBlocks/${showId}/${user.uid}`,
          idToken
        );

        if (
          blocked === true ||
          (blocked && blocked.blocked === true)
        ) {
          return json({
            error: "You are blocked from this show.",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const access = await readDB(
          `audienceAccess/${showId}/${user.uid}`,
          idToken
        );

        const fee = getAudienceFee(show);

        if (
          fee > 0 &&
          access !== true &&
          (!access || access.approved !== true)
        ) {
          return json({
            error: "Audience entry is not approved for this paid show.",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const token = await createLiveKitToken(env, {
          uid: user.uid,
          showId,
          name: body.name || "Audience",
          role: "audience",
          canPublishAudio: false,
          canPublishVideo: false
        });

        return json({
          success: true,
          role: "audience",
          action: "joinAudience",
          workerVersion: WORKER_VERSION,
          authenticatedUid: user.uid,
          microphoneAllowed: false,
          cameraAllowed: false,
          canPublishAudio: false,
          canPublishVideo: false,
          canPublishData: true,
          token,
          url: env.LIVEKIT_URL
        }, 200, corsHeaders);
      }


      /* =====================================
         HOST ENTRY
      ===================================== */

      if (action === "joinHost") {
        const activeHost = await verifyHost(
          showId,
          user.uid,
          idToken
        );

        if (!activeHost) {
          return json({
            error: "Active approved host access required.",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const token = await createLiveKitToken(env, {
          uid: user.uid,
          showId,
          name: body.name || "Host",
          role: "host",
          canPublishAudio: true,
          canPublishVideo: true
        });

        return json({
          success: true,
          role: "host",
          action: "joinHost",
          workerVersion: WORKER_VERSION,
          authenticatedUid: user.uid,
          microphoneAllowed: true,
          cameraAllowed: true,
          canPublishAudio: true,
          canPublishVideo: true,
          canPublishData: true,
          showStarted: lifecycle.started,
          scheduledAt: lifecycle.scheduledAt || 0,
          token,
          url: env.LIVEKIT_URL
        }, 200, corsHeaders);
      }


      /* =====================================
         HOST: SYNCHRONIZE SINGER PERMISSIONS
      ===================================== */

      if (action === "syncPermissions") {
        const activeHost = await verifyHost(
          showId,
          user.uid,
          idToken
        );

        if (!activeHost) {
          return json({
            error: "Only the active host can change singer permissions.",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const targetUid = String(
          body.uid || body.targetUid || ""
        ).trim();

        if (!targetUid) {
          return json({
            error: "Singer UID required",
            workerVersion: WORKER_VERSION,
            action
          }, 400, corsHeaders);
        }

        const registration = await getSingerRegistration(
          showId,
          targetUid,
          idToken
        );

        if (
          !registration ||
          !isSingerApproved(registration.status)
        ) {
          return json({
            error: "Approved singer not found",
            workerVersion: WORKER_VERSION,
            action
          }, 403, corsHeaders);
        }

        const stage = await readDB(`liveStage/${showId}`, idToken);

        const selected = isSingerSelected(
          stage,
          targetUid,
          registration
        );

        const cameraAllowed = true;

        const microphoneAllowed =
          selected &&
          body.microphoneAllowed === true;

        await writeDB(
          `participantControls/${showId}/${targetUid}`,
          {
            microphoneAllowed,
            cameraAllowed,
            updatedAt: Date.now(),
            updatedBy: user.uid
          },
          idToken
        );

        const updateResult = await updateLiveKitParticipant(
          env,
          showId,
          targetUid,
          {
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            canPublishSources: [
              "camera",
              ...(microphoneAllowed ? ["microphone"] : [])
            ]
          }
        );

        return json({
          success: true,
          action: "syncPermissions",
          workerVersion: WORKER_VERSION,
          microphoneAllowed,
          cameraAllowed,
          canPublishData: true,
          selected,
          participantOnline: !updateResult.offline
        }, 200, corsHeaders);
      }


      return json({
        error: "Unknown action",
        receivedAction: action,
        workerVersion: WORKER_VERSION
      }, 400, corsHeaders);

    } catch (error) {
      console.error("Melody Magic Worker error:", error);

      return json({
        error: error.message || "Worker error",
        workerVersion: WORKER_VERSION
      }, 500, corsHeaders);
    }
  }
};


/* =========================================
   SHOW PUBLICATION STATUS
========================================= */

function isPublishedShow(show) {
  if (!show) return false;

  const status = String(show.status || "")
    .trim()
    .toLowerCase();

  return status === "published" || status === "live";
}


/* =========================================
   SHOW LIFECYCLE
========================================= */

function getShowLifecycle(show) {
  const liveStatus = String(show.liveStatus || "")
    .trim()
    .toLowerCase();

  const endedAt = parseTimestamp(show.liveEndedAt);

  if (
    liveStatus === "ended" ||
    (Number.isFinite(endedAt) && endedAt > 0)
  ) {
    return {
      started: false,
      ended: true,
      scheduledAt: getScheduledTimestamp(show) || 0
    };
  }

  if (
    liveStatus === "live" ||
    show.isLive === true
  ) {
    return {
      started: true,
      ended: false,
      scheduledAt: getScheduledTimestamp(show) || 0
    };
  }

  return {
    started: false,
    ended: false,
    scheduledAt: getScheduledTimestamp(show) || 0
  };
}


/* =========================================
   SCHEDULED SHOW TIME
========================================= */

function getScheduledTimestamp(show) {
  const stored = parseTimestamp(show.scheduledAt);

  if (Number.isFinite(stored) && stored > 0) {
    return stored;
  }

  const date = String(show.showDate || show.date || "").trim();
  const time = String(show.showTime || show.time || "").trim();

  if (!date || !time) return NaN;

  const normalizedTime =
    /^\d{1,2}:\d{2}$/.test(time)
      ? time.padStart(5, "0") + ":00"
      : time;

  const timestamp = Date.parse(
    `${date}T${normalizedTime}+05:30`
  );

  return Number.isFinite(timestamp) ? timestamp : NaN;
}


/* =========================================
   TIMESTAMP NORMALIZATION
========================================= */

function parseTimestamp(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return NaN;
  }

  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }

  return Date.parse(value);
}


/* =========================================
   SINGER APPROVAL
========================================= */

function isSingerApproved(status) {
  return [
    "approved",
    "queued",
    "playing"
  ].includes(
    String(status || "").trim().toLowerCase()
  );
}


/* =========================================
   AUDIENCE FEE
========================================= */

function getAudienceFee(show) {
  const feeType = String(show.audienceFeeType || "")
    .toLowerCase();

  if (feeType === "free") return 0;

  if (feeType === "paid") {
    return Math.max(0, Number(show.audienceFee) || 0);
  }

  return Math.max(
    0,
    Number(
      show.audienceFee ??
      show.audienceEntryFee ??
      show.entryFee ??
      0
    ) || 0
  );
}


/* =========================================
   JSON RESPONSE
========================================= */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}


/* =========================================
   FIREBASE TOKEN VERIFICATION
========================================= */

async function verifyFirebaseToken(idToken) {
  const parts = idToken.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid Firebase token");
  }

  const header = JSON.parse(base64UrlDecodeText(parts[0]));
  const payload = JSON.parse(base64UrlDecodeText(parts[1]));

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Invalid Firebase token header");
  }

  const response = await fetch(FIREBASE_JWKS_URL);

  if (!response.ok) {
    throw new Error("Could not verify Firebase token");
  }

  const jwks = await response.json();

  const key = jwks.keys.find(item => item.kid === header.kid);

  if (!key) {
    throw new Error("Firebase signing key not found");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    key,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  const signedData = new TextEncoder().encode(
    parts[0] + "." + parts[1]
  );

  const signature = base64UrlToBytes(parts[2]);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    signedData
  );

  if (!valid) {
    throw new Error("Firebase token signature invalid");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    payload.aud !== FIREBASE_PROJECT_ID ||
    payload.iss !==
      `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` ||
    !payload.sub ||
    payload.sub.length > 128 ||
    Number(payload.exp) <= now ||
    Number(payload.iat) > now + 60 ||
    (payload.user_id && payload.user_id !== payload.sub)
  ) {
    throw new Error("Firebase token expired or invalid");
  }

  return {
    uid: payload.sub,
    email: payload.email || ""
  };
}


function base64UrlDecodeText(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}


function base64UrlToBytes(value) {
  let base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (base64.length % 4) {
    base64 += "=";
  }

  const binary = atob(base64);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}


/* =========================================
   FIREBASE DATABASE HELPERS
========================================= */

function databasePath(path) {
  return path
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}


async function readDB(path, idToken) {
  const url =
    `${FIREBASE_DATABASE_URL}/${databasePath(path)}.json` +
    `?auth=${encodeURIComponent(idToken)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Firebase read failed (${response.status})`);
  }

  return response.json();
}


async function writeDB(path, value, idToken) {
  const url =
    `${FIREBASE_DATABASE_URL}/${databasePath(path)}.json` +
    `?auth=${encodeURIComponent(idToken)}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });

  if (!response.ok) {
    throw new Error(`Firebase write failed (${response.status})`);
  }

  return response.json();
}


/* =========================================
   GET SINGER REGISTRATION
========================================= */

async function getSingerRegistration(
  showId,
  uid,
  idToken,
  requestedRegistrationId = "",
  requestedMobile = ""
) {
  const path = databasePath(`showRegistrations/${showId}`);
  const useMobile = Boolean(requestedMobile);
  const orderField = useMobile ? "mobile" : "singerUid";
  const orderValue = useMobile ? requestedMobile : uid;

  const query =
    `orderBy=${encodeURIComponent(JSON.stringify(orderField))}` +
    `&equalTo=${encodeURIComponent(JSON.stringify(orderValue))}` +
    `&auth=${encodeURIComponent(idToken)}`;

  const response = await fetch(
    `${FIREBASE_DATABASE_URL}/${path}.json?${query}`
  );

  if (!response.ok) {
    throw new Error(
      `Firebase singer registration lookup failed (${response.status})`
    );
  }

  const records = await response.json();

  if (!records || typeof records !== "object") return null;

  const matches = Object.entries(records)
    .map(([id, value]) => ({ ...(value || {}), registrationId: id }))
    .filter(record => {
      const correctSinger = useMobile
        ? normalizeMobile(record.mobile) === requestedMobile
        : record.singerUid === uid;
      const correctRegistration =
        !requestedRegistrationId ||
        record.registrationId === requestedRegistrationId;
      const correctShow = !record.showId || record.showId === showId;
      return correctSinger && correctRegistration && correctShow;
    })
    .sort((a, b) =>
      Number(b.createdAt || b.submittedAt || 0) -
      Number(a.createdAt || a.submittedAt || 0)
    );

  return matches[0] || null;
}

function normalizeMobile(value) {
  return String(value || "").replace(/\\D/g, "").slice(-10);
}


/* =========================================
   VERIFY HOST AND SUBSCRIPTION
========================================= */

async function verifyHost(showId, uid, idToken) {
  const show = await readDB(`shows/${showId}`, idToken);

  if (!show || show.hostUid !== uid) {
    return false;
  }

  const application = await readDB(
    `hostApplications/${uid}`,
    idToken
  );

  if (
    !application ||
    String(application.status || "").trim().toLowerCase() !== "approved"
  ) {
    return false;
  }

  const now = Date.now();

  const start = parseTimestamp(application.subscriptionStartAt);
  const end = parseTimestamp(application.subscriptionEndAt);

  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start > 0 &&
    end > now &&
    start <= now
  );
}


/* =========================================
   CHECK MAIN STAGE SELECTION
========================================= */

function isSingerSelected(stage, uid, registration) {
  if (!stage) return false;

  const singerUids = Array.isArray(stage.singerUids)
    ? stage.singerUids
    : Object.values(stage.singerUids || {});

  const registrationIds = Array.isArray(stage.registrationIds)
    ? stage.registrationIds
    : Object.values(stage.registrationIds || {});

  return (
    singerUids.includes(uid) ||
    registrationIds.includes(registration.registrationId)
  );
}


/* =========================================
   CREATE LIVEKIT ACCESS TOKEN
========================================= */

async function createLiveKitToken(env, options) {
  const now = Math.floor(Date.now() / 1000);

  const publishSources = [];

  if (options.canPublishVideo) {
    publishSources.push("camera");
  }

  if (options.canPublishAudio) {
    publishSources.push("microphone");
  }

  const payload = {
    iss: env.LIVEKIT_API_KEY,
    sub: options.uid,
    nbf: now,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,

    name: String(options.name || "Participant").slice(0, 80),

    video: {
      room: options.showId,
      roomJoin: true,

      canPublish: publishSources.length > 0,
      canSubscribe: true,
      canPublishData: true,

      canPublishSources: publishSources
    },

    metadata: JSON.stringify({
      role: options.role,
      uid: options.uid
    })
  };

  return signJWT(payload, env.LIVEKIT_API_SECRET);
}


/* =========================================
   SIGN JWT
========================================= */

async function signJWT(payload, secret) {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const encodedHeader = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(header))
  );

  const encodedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );

  const message = encodedHeader + "." + encodedPayload;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return (
    message +
    "." +
    bytesToBase64Url(new Uint8Array(signature))
  );
}


function bytesToBase64Url(bytes) {
  let binary = "";

  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

