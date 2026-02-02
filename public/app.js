/* PhotoQueue client: camera + offline queue + bg sync + push */

const $ = (sel) => document.querySelector(sel);

let deferredInstallPrompt = null;
let swReg = null;

function toast(msg, kind = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.style.display = "block";
  el.className = `toast ${kind}`;
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => (el.style.display = "none"), 2400);
}

function setOnlineBadge() {
  const el = $("#onlineBadge");
  const online = navigator.onLine;
  el.textContent = online ? "Online" : "Offline";
  el.style.background = online
    ? "rgba(34,197,94,0.14)"
    : "rgba(245,158,11,0.14)";
  el.style.borderColor = online
    ? "rgba(34,197,94,0.35)"
    : "rgba(245,158,11,0.35)";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    toast("Service Worker nije podržan u ovom pregledniku.", "warn");
    return;
  }
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error(err);
    toast("Ne mogu registrirati service worker.", "bad");
  }
}

function wireInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $("#installHint").textContent =
      "Aplikacija je installable. U Chrome-u klikni Install (ikonica u address baru) ili ovaj gumb kad ga dodamo.";
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("#installHint").textContent = "Aplikacija je instalirana ✅";
  });
}

async function getVapidPublicKey() {
  const resp = await fetch("/api/vapidPublicKey");
  if (!resp.ok) throw new Error("Cannot fetch VAPID key");
  const data = await resp.json();
  return data.publicKey;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i)
    outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enablePush() {
  const statusEl = $("#notifStatus");

  if (!("Notification" in window)) {
    statusEl.textContent = "Notifikacije nisu podržane.";
    toast("Notifikacije nisu podržane.", "warn");
    return;
  }
  if (!("PushManager" in window)) {
    statusEl.textContent = "Push nije podržan.";
    toast("Push nije podržan.", "warn");
    return;
  }
  if (!swReg) {
    statusEl.textContent = "Service worker nije spreman.";
    toast("Service worker nije spreman.", "warn");
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    statusEl.textContent = "Permission denied (push će biti isključen).";
    toast("Bez dozvole za notifikacije, push dio preskačemo.", "warn");
    return;
  }

  try {
    const publicKey = await getVapidPublicKey();
    const appServerKey = urlBase64ToUint8Array(publicKey);

    const existing = await swReg.pushManager.getSubscription();
    const sub =
      existing ||
      (await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      }));

    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });

    statusEl.textContent = "Push uključen ✅ (čekaj notifikaciju nakon sync-a)";
    toast("Push uključen ✅", "ok");
  } catch (err) {
    console.error(err);
    statusEl.textContent =
      "Neuspjelo uključivanje push-a (provjeri HTTPS na cloudu).";
    toast("Push nije uspio. Na Renderu mora biti HTTPS.", "warn");
  }
}

async function startCameraOrFallback() {
  const note = $("#cameraNote");
  const btnPick = $("#btnPickFile");
  const fileInput = $("#fileFallback");
  const btnSnap = $("#btnSnap");

  const supported = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  if (!supported) {
    note.textContent = "Kamera API nije podržan. Koristi fallback upload.";
    btnPick.style.display = "inline-block";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    const video = $("#video");
    video.srcObject = stream;
    await video.play();
    btnSnap.disabled = false;
    note.textContent = "Kamera radi. Snimi fotku.";
  } catch (err) {
    console.warn(err);
    // progressive enhancement / graceful degradation
    note.textContent =
      "Ne mogu pristupiti kameri (dozvola/uređaj). Koristi fallback upload.";
    btnPick.style.display = "inline-block";
    btnSnap.disabled = true;
  }

  btnPick.addEventListener("click", () => fileInput.click());
}

function captureFromVideo() {
  const video = $("#video");
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d");

  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);

  return canvas.toDataURL("image/png");
}

async function queuePhoto(dataUrl) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    dataUrl,
    createdAt: Date.now(),
  };

  await window.PQ_IDB.put(item);
  await registerSync();
  await renderQueue();
}

async function registerSync() {
  if (swReg && swReg.sync) {
    try {
      await swReg.sync.register("sync-uploads");
    } catch (err) {
      console.warn("sync.register failed", err);
    }
  }
}

async function uploadOne(item) {
  const resp = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl: item.dataUrl, createdAt: item.createdAt }),
  });
  if (!resp.ok) throw new Error("upload failed");
  return resp.json();
}

async function tryImmediateOrQueue(dataUrl) {
  if (navigator.onLine) {
    try {
      await uploadOne({ dataUrl, createdAt: Date.now() });
      toast("Poslano odmah ✅ (online)", "ok");
      return;
    } catch (err) {
      console.warn(err);
    }
  }

  await queuePhoto(dataUrl);
  toast("Spremljeno u queue. Sync će poslati kad bude online.", "info");
}

async function forceFlushFallback() {
  if (!navigator.onLine) {
    toast("Offline si. Vrati mrežu pa probaj.", "warn");
    return;
  }

  const items = await window.PQ_IDB.getAll();
  if (items.length === 0) {
    toast("Queue je prazan.", "info");
    return;
  }

  // Fallback kada Bg Sync nije podržan (ili za ručno testiranje)
  for (const item of items) {
    try {
      await uploadOne(item);
      await window.PQ_IDB.del(item.id);
    } catch (err) {
      console.warn(err);
      toast("Nije uspjelo poslati sve. Pokušaj opet.", "warn");
      break;
    }
  }

  await renderQueue();
  toast("Queue poslan (fallback) ✅", "ok");
}

async function renderQueue() {
  const list = $("#queueList");
  const items = await window.PQ_IDB.getAll();

  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML =
      '<div class="hint">Nema queued fotki. Snimi jednu, pa prebaci Network → Offline i testiraj.</div>';
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "queue-card";

    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.alt = "queued photo";

    const meta = document.createElement("div");
    meta.className = "queue-meta";
    const dt = new Date(item.createdAt);
    meta.innerHTML = `<div class="queue-title">Queued</div><div class="hint">${dt.toLocaleString()}</div>`;

    const actions = document.createElement("div");
    actions.className = "queue-actions";

    const btnSend = document.createElement("button");
    btnSend.textContent = "Pošalji";
    btnSend.addEventListener("click", async () => {
      if (!navigator.onLine) {
        toast("Offline si.", "warn");
        return;
      }
      try {
        await uploadOne(item);
        await window.PQ_IDB.del(item.id);
        await renderQueue();
        toast("Poslano ✅", "ok");
      } catch (err) {
        console.warn(err);
        toast("Neuspjelo. Ostaje u queue-u.", "warn");
      }
    });

    const btnDel = document.createElement("button");
    btnDel.textContent = "Obriši";
    btnDel.className = "secondary";
    btnDel.addEventListener("click", async () => {
      await window.PQ_IDB.del(item.id);
      await renderQueue();
    });

    actions.appendChild(btnSend);
    actions.appendChild(btnDel);

    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function wireUi() {
  $("#btnEnableNotifs").addEventListener("click", () => enablePush());

  $("#btnStartCam").addEventListener("click", async () => {
    await startCameraOrFallback();
  });

  $("#btnSnap").addEventListener("click", async () => {
    try {
      const dataUrl = captureFromVideo();
      await tryImmediateOrQueue(dataUrl);
      await renderQueue();
    } catch (err) {
      console.error(err);
      toast("Ne mogu snimiti fotku.", "bad");
    }
  });

  $("#fileFallback").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Odaberi sliku.", "warn");
      return;
    }

    const r = new FileReader();
    r.onload = async () => {
      await tryImmediateOrQueue(String(r.result));
      await renderQueue();
    };
    r.onerror = () => toast("Ne mogu pročitati datoteku.", "bad");
    r.readAsDataURL(file);
  });

  $("#btnForceFlush").addEventListener("click", () => {
    forceFlushFallback();
  });

  window.addEventListener("online", async () => {
    setOnlineBadge();
    toast("Online ✅", "ok");
    // if Bg Sync isn't supported, do a manual flush to demonstrate graceful degradation
    if (!(swReg && swReg.sync)) {
      await forceFlushFallback();
    }
  });
  window.addEventListener("offline", () => {
    setOnlineBadge();
    toast("Offline. App shell radi iz cache-a.", "warn");
  });
}

window.addEventListener("load", async () => {
  if (!window.PQ_IDB) {
    console.error("Missing idb.js");
    toast("Nedostaje idb helper.", "bad");
    return;
  }

  setOnlineBadge();
  wireInstallPrompt();
  wireUi();
  await registerServiceWorker();
  await renderQueue();

  // Show fallback pick button if camera unsupported
  const supportsCamera = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  if (!supportsCamera) {
    $("#cameraNote").textContent = "Kamera API nije podržan. Koristi upload.";
    $("#btnPickFile").style.display = "inline-block";
    $("#btnPickFile").addEventListener("click", () =>
      $("#fileFallback").click(),
    );
  }
});
