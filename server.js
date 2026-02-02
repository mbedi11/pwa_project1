const path = require("path");
const fs = require("fs");
const express = require("express");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;

const VAPID_PATH = path.join(__dirname, "vapid.json");
const SUBS_PATH = path.join(__dirname, "subscriptions.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

/**
 * VAPID loading strategy:
 * - On Render: use ENV vars (recommended, no secrets in repo)
 * - Local dev: fallback to vapid.json if ENV is missing
 */
function loadVapid() {
  const envPublic = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;
  const envSubject = process.env.VAPID_SUBJECT;

  if (envPublic && envPrivate) {
    return {
      publicKey: envPublic,
      privateKey: envPrivate,
      subject: envSubject || "mailto:pwa-demo@example.com",
    };
  }

  const fileVapid = readJsonSafe(VAPID_PATH, null);
  if (fileVapid && fileVapid.publicKey && fileVapid.privateKey) {
    return {
      publicKey: fileVapid.publicKey,
      privateKey: fileVapid.privateKey,
      subject: fileVapid.subject || "mailto:pwa-demo@example.com",
    };
  }

  return null;
}

const vapid = loadVapid();
if (!vapid) {
  console.error(
    "Missing VAPID keys.\n" +
      "- Local: create vapid.json with { publicKey, privateKey } OR\n" +
      "- Render: set ENV vars VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT).",
  );
  process.exit(1);
}

webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));

// Avoid stale SW/manifest issues (important for PWA debugging)
app.get(["/sw.js", "/manifest.webmanifest"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});

// Static files (index.html, app.js, sw.js, manifest, icons...)
app.use(express.static(path.join(__dirname, "public")));

// Provide VAPID public key to the frontend
app.get("/api/vapidPublicKey", (req, res) => {
  res.json({ publicKey: vapid.publicKey });
});

// Store push subscription (NOTE: file storage is ephemeral on Render)
app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription." });
  }

  const subs = readJsonSafe(SUBS_PATH, []);
  const exists = subs.some((s) => s.endpoint === subscription.endpoint);

  if (!exists) {
    subs.push(subscription);
    writeJsonSafe(SUBS_PATH, subs);
  }

  res.json({ ok: true });
});

// Upload endpoint used by Background Sync (client sends base64 dataUrl)
app.post("/api/upload", async (req, res) => {
  const { dataUrl, createdAt } = req.body || {};

  if (
    !dataUrl ||
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/")
  ) {
    return res.status(400).json({ error: "Expected dataUrl (base64 image)." });
  }

  // data:image/png;base64,AAAA...
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Malformed dataUrl." });
  }

  const mime = match[1];
  const b64 = match[2];

  const ext = mime === "image/jpeg" ? "jpg" : "png";
  const stamp = new Date(createdAt || Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");
  const filename = `photo-${stamp}.${ext}`;
  const outPath = path.join(UPLOADS_DIR, filename);

  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));

  // Send push notification to all subscribers after successful upload (demo requirement)
  const subs = readJsonSafe(SUBS_PATH, []);
  const payload = JSON.stringify({
    title: "Upload synced ✅",
    body: `Fotka je poslana na server: ${filename}`,
    url: "/",
  });

  const stillValid = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      } catch (err) {
        const status = err && err.statusCode;
        // drop only "gone" subscriptions, keep others
        if (status !== 410 && status !== 404) {
          stillValid.push(sub);
        }
      }
    }),
  );
  writeJsonSafe(SUBS_PATH, stillValid);

  res.json({ ok: true, filename });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// SPA fallback (direct navigation / refresh on routes)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
