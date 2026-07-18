import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

/* ============================================================
   Oathforge Cloud Save  (Firebase Auth + Firestore)
   - Local save stays primary. Cloud is a synced backup.
   - This file builds its own UI panel and hooks the game's
     existing global save() function, so no edits are needed
     inside the large index.html game code.
   - The save is read/written from IndexedDB (the game's real
     storage): database "lifequest" -> object store "sheets"
     -> key "lifequest_afk_v1", stored as a JSON string.
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyBKAzO572bQ64NsI2w6YlvlL8YR6QAQCVI",
  authDomain: "oathforge.firebaseapp.com",
  projectId: "oathforge",
  storageBucket: "oathforge.firebasestorage.app",
  messagingSenderId: "759560585061",
  appId: "1:759560585061:web:c08c02877ef081f8f06b8c",
  measurementId: "G-Y33HK9MGCZ"
};

/* The game persists its save to IndexedDB, not localStorage. */
const IDB_NAME = "lifequest";
const IDB_STORE = "sheets";
const IDB_SAVE_KEY = "lifequest_afk_v1";

const LOCAL_UPDATED_KEY = "OF_LAST_LOCAL_SAVE_MS";
const LAST_SYNC_KEY = "OF_LAST_CLOUD_SYNC_MS";
const DEVICE_ID_KEY = "OF_DEVICE_ID";

/* ---------- IndexedDB helpers (match the game's storage) ---------- */
function ofIdbOpen() {
  return new Promise((resolve, reject) => {
    let r;
    try { r = indexedDB.open(IDB_NAME, 1); }
    catch (e) { reject(e); return; }
    r.onupgradeneeded = () => {
      try {
        const db = r.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      } catch (e) {}
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("IndexedDB open failed"));
  });
}

function idbGetRawSave() {
  return ofIdbOpen().then(db => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(IDB_STORE, "readonly"); }
    catch (e) { resolve(null); return; } // store may not exist yet
    const rq = tx.objectStore(IDB_STORE).get(IDB_SAVE_KEY);
    rq.onsuccess = () => {
      const v = rq.result;
      resolve(v == null ? null : (typeof v === "string" ? v : JSON.stringify(v)));
    };
    rq.onerror = () => reject(rq.error || new Error("IndexedDB get failed"));
  }));
}

function idbPutRawSave(raw) {
  return ofIdbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(raw, IDB_SAVE_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB put failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB put aborted"));
  }));
}

/* ---------- Compression (gzip) so large game-state saves fit Firestore's 1MB doc limit ----------
   The persisted save is portrait-stripped JSON (heroes + gear), which compresses ~7x. */
async function gzipToBase64(str) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function base64ToGunzip(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// iOS Safari / restrictive networks often block Firestore's default streaming
// (WebChannel) connection, surfacing as "client is offline". Force long-polling.
const db = initializeFirestore(app, { experimentalForceLongPolling: true });
const googleProvider = new GoogleAuthProvider();

await setPersistence(auth, browserLocalPersistence);

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("device-" + Date.now() + "-" + Math.random());
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getCurrentUserOrThrow() {
  const user = auth.currentUser;
  if (!user) throw new Error("You must sign in before using cloud save.");
  return user;
}

function getSaveRef() {
  const user = getCurrentUserOrThrow();
  return doc(db, "users", user.uid, "saves", "main");
}

async function getLocalRawSave() {
  return await idbGetRawSave();
}

async function getLocalSaveObject() {
  const raw = await getLocalRawSave();
  if (!raw) {
    throw new Error(
      "No local Oathforge save found in IndexedDB (" + IDB_NAME + "/" + IDB_STORE + "/" + IDB_SAVE_KEY + "). " +
      "Open the game so it loads/creates a save, then try again."
    );
  }
  return JSON.parse(raw);
}

async function writeLocalSaveObject(saveObj) {
  const raw = JSON.stringify(saveObj);
  // Safety backup of the existing local save before overwriting.
  try {
    const existing = await idbGetRawSave();
    if (existing) localStorage.setItem("OF_PRE_CLOUD_RESTORE_" + Date.now(), existing);
  } catch (e) {}
  /* CRITICAL: the game's save coalescer flushes on pagehide, so the reload below
     would persist the OLD in-memory state right over this restore. Swap the global
     game state to the restored object first — any late flush then writes the
     restored save. Local custom portrait crops are carried over (device-local). */
  try {
    if (typeof S !== "undefined" && S && typeof S === "object") {
      try { if (S.heroPortraits) saveObj.heroPortraits = S.heroPortraits; } catch (e) {}
      try { if (S.portraitCustom) saveObj.portraitCustom = S.portraitCustom; } catch (e) {}
      S = saveObj;
    }
  } catch (e) {}
  await idbPutRawSave(raw);
  markLocalSaveUpdated();
  alert("Cloud save restored. Oathforge will reload now.");
  location.reload();
}

function markLocalSaveUpdated() {
  localStorage.setItem(LOCAL_UPDATED_KEY, String(Date.now()));
}

function getLocalUpdatedMs() {
  const stored = Number(localStorage.getItem(LOCAL_UPDATED_KEY) || "0");
  return Number.isFinite(stored) ? stored : 0;
}

function getAppVersion() {
  return window.OATHFORGE_VERSION || window.APP_VERSION || window.SAVE_VERSION || "unknown";
}

function summarizeSave(save) {
  try {
    return {
      playerName: (save && (save.playerName || (save.profile && save.profile.name))) || null,
      level: (save && (save.level || save.playerLevel || (save.profile && save.profile.level))) || null,
      campaignStage: (save && (save.highestStage || (save.campaign && save.campaign.highestStage))) || null,
      heroes: (save && Array.isArray(save.heroes)) ? save.heroes.length : null,
      gold: (save && (save.gold != null ? save.gold : (save.currencies && save.currencies.gold))) ?? null
    };
  } catch (e) { return {}; }
}

function formatDate(ms) {
  if (!ms) return "Never";
  return new Date(ms).toLocaleString();
}

function updateCloudStatus(message) {
  const userStatus = document.getElementById("cloudUserStatus");
  const lastSynced = document.getElementById("cloudLastSynced");
  const user = auth.currentUser;
  if (userStatus) {
    userStatus.textContent = user
      ? ("Signed in as " + (user.email || user.displayName || "Firebase user"))
      : "Not signed in";
  }
  if (lastSynced) {
    const lastSyncMs = Number(localStorage.getItem(LAST_SYNC_KEY) || "0");
    lastSynced.textContent = "Last synced: " + formatDate(lastSyncMs) + (message ? (" \u2014 " + message) : "");
  }
}

async function signInGoogle() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (
      err.code === "auth/popup-blocked" ||
      err.code === "auth/popup-closed-by-user" ||
      err.code === "auth/cancelled-popup-request"
    ) {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    throw err;
  }
}

async function getCloudSave() {
  const ref = getSaveRef();
  const snap = await getDoc(ref);
  if (!snap.exists()) return { exists: false, data: null };
  return { exists: true, data: snap.data() };
}

async function cloudBackup(opts) {
  const force = !!(opts && opts.force);
  const localSave = await getLocalSaveObject();
  const raw = JSON.stringify(localSave);

  // Compress (gzip) so large game-state saves fit Firestore's 1MB doc limit.
  let payload = raw;
  let compressed = false;
  if (typeof CompressionStream !== "undefined") {
    try {
      payload = await gzipToBase64(raw);
      compressed = true;
    } catch (e) {
      console.warn("Oathforge cloud: gzip failed, sending uncompressed:", e);
      payload = raw;
      compressed = false;
    }
  }
  if (payload.length > 1000000) {
    throw new Error(
      "Save is too large for Firestore even compressed (" + payload.length + " chars, raw " + raw.length + "). " +
      "Firestore caps documents at ~1MB. Your game state has grown past what a single doc holds — use the Backup Center's file export for now."
    );
  }
  const ref = getSaveRef();
  if (!force) {
    const cloud = await getCloudSave();
    if (cloud.exists) {
      const localUpdated = getLocalUpdatedMs();
      const cloudUpdated = cloud.data.updatedAtClientMs || 0;
      if (cloudUpdated > localUpdated) {
        const ok = confirm(
          "The cloud save appears newer than this device.\n\n" +
          "Cloud updated: " + formatDate(cloudUpdated) + "\n" +
          "This device updated: " + formatDate(localUpdated) + "\n\n" +
          "Cloud Backup will overwrite the cloud save with this device's save.\n\nContinue?"
        );
        if (!ok) return;
      }
    }
  }
  const saveVersion = localSave.saveVersion || localSave.SAVE_VERSION || window.SAVE_VERSION || null;
  await setDoc(ref, {
    schema: 2,
    compressed: compressed,
    saveJson: payload,
    rawLength: raw.length,
    updatedAt: serverTimestamp(),
    updatedAtClientMs: Date.now(),
    deviceId: getDeviceId(),
    appVersion: String(getAppVersion()),
    saveVersion: saveVersion ? String(saveVersion) : null,
    summary: summarizeSave(localSave)
  });
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  updateCloudStatus("Cloud backup complete");
}

async function restoreCloudSave() {
  const cloud = await getCloudSave();
  if (!cloud.exists) {
    alert("No cloud save exists yet for this account.");
    return;
  }
  const data = cloud.data;
  const localUpdated = getLocalUpdatedMs();
  const cloudUpdated = data.updatedAtClientMs || 0;
  const ok = confirm(
    "Restore Cloud Save will replace this device's local save.\n\n" +
    "Cloud updated: " + formatDate(cloudUpdated) + "\n" +
    "This device updated: " + formatDate(localUpdated) + "\n\n" +
    "A local safety backup will be created before restore.\n\nContinue?"
  );
  if (!ok) return;
  const rawJson = data.compressed ? await base64ToGunzip(data.saveJson) : data.saveJson;
  const saveObj = JSON.parse(rawJson);
  await writeLocalSaveObject(saveObj);
}

async function syncNow() {
  const localRaw = await getLocalRawSave();
  const cloud = await getCloudSave();
  if (!localRaw && !cloud.exists) {
    alert("No local save or cloud save found.");
    return;
  }
  if (localRaw && !cloud.exists) {
    const ok = confirm("No cloud save exists yet. Upload this device's Oathforge save to cloud?");
    if (ok) await cloudBackup({ force: true });
    return;
  }
  if (!localRaw && cloud.exists) {
    await restoreCloudSave();
    return;
  }
  const localUpdated = getLocalUpdatedMs();
  const cloudUpdated = cloud.data.updatedAtClientMs || 0;
  if (localUpdated > cloudUpdated) {
    const ok = confirm(
      "This device appears newer than the cloud save.\n\n" +
      "This device updated: " + formatDate(localUpdated) + "\n" +
      "Cloud updated: " + formatDate(cloudUpdated) + "\n\nUpload this device to cloud?"
    );
    if (ok) await cloudBackup({ force: true });
    return;
  }
  if (cloudUpdated > localUpdated) {
    const ok = confirm(
      "The cloud save appears newer than this device.\n\n" +
      "Cloud updated: " + formatDate(cloudUpdated) + "\n" +
      "This device updated: " + formatDate(localUpdated) + "\n\nRestore cloud save to this device?"
    );
    if (ok) await restoreCloudSave();
    return;
  }
  alert("Local and cloud saves appear to be in sync.");
  updateCloudStatus("Already synced");
}

function queueAutoBackup() {
  clearTimeout(window.__ofCloudBackupTimer);
  window.__ofCloudBackupTimer = setTimeout(async () => {
    if (!auth.currentUser) return;
    try {
      await cloudBackup();
    } catch (err) {
      console.warn("Oathforge auto cloud backup failed:", err);
      updateCloudStatus("Auto backup failed");
    }
  }, 10000);
}

/* ---------- UI: build the Cloud Save panel ourselves ---------- */
function buildPanel() {
  if (document.getElementById("cloudSyncPanel")) return;
  const section = document.createElement("section");
  section.id = "cloudSyncPanel";
  section.className = "settings-card";
  section.style.cssText = "border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:12px;margin:12px 0;background:rgba(0,0,0,0.25);font-family:inherit;";
  section.innerHTML =
    '<h3 style="margin:0 0 8px 0;">Cloud Save</h3>' +
    '<div id="cloudUserStatus">Not signed in</div>' +
    '<div id="cloudLastSynced">Last synced: Never</div>' +
    '<div class="settings-actions" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">' +
      '<button id="ofSignInGoogleBtn" type="button">Sign In with Google</button>' +
      '<button id="ofSignOutBtn" type="button">Sign Out</button>' +
      '<button id="ofSyncNowBtn" type="button">Sync Now</button>' +
      '<button id="ofCloudBackupBtn" type="button">Cloud Backup</button>' +
      '<button id="ofRestoreCloudBtn" type="button">Restore Cloud Save</button>' +
    '</div>' +
    '<p class="small-note" style="opacity:0.75;font-size:0.85em;margin-top:8px;">Cloud stores game state only (portraits stay on-device). Backup is manual: tap <b>Cloud Backup</b> to push this device up. To move progress, back up on the newer device, then <b>Restore Cloud Save</b> on the other. Restore always asks first.</p>';

  const btn = document.getElementById("backupCenter");
  const host =
    (btn && btn.parentElement) ||
    document.querySelector('[id*="settings" i]') ||
    document.querySelector('[class*="settings" i]');
  if (host && host.appendChild) {
    host.appendChild(section);
  } else {
    section.style.position = "fixed";
    section.style.right = "12px";
    section.style.bottom = "12px";
    section.style.zIndex = "99999";
    section.style.maxWidth = "320px";
    document.body.appendChild(section);
  }
  wireButtons();
  updateCloudStatus();
}

function wireButtons() {
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el && !el.__wired) { el.__wired = true; el.addEventListener("click", fn); }
  };
  on("ofSignInGoogleBtn", async () => {
    try { await signInGoogle(); } catch (err) { console.error(err); alert("Sign-in failed: " + err.message); }
  });
  on("ofSignOutBtn", async () => {
    try { await signOut(auth); updateCloudStatus("Signed out"); } catch (err) { console.error(err); alert("Sign-out failed: " + err.message); }
  });
  on("ofSyncNowBtn", async () => {
    try { await syncNow(); } catch (err) { console.error(err); alert("Sync failed: " + err.message); }
  });
  on("ofCloudBackupBtn", async () => {
    try { await cloudBackup(); alert("Cloud backup complete."); } catch (err) { console.error(err); alert("Cloud backup failed: " + err.message); }
  });
  on("ofRestoreCloudBtn", async () => {
    try { await restoreCloudSave(); } catch (err) { console.error(err); alert("Cloud restore failed: " + err.message); }
  });
}

/* ---------- Hook the game's existing global save() ---------- */
function hookGameSave() {
  if (typeof window.save === "function" && !window.save.__ofHooked) {
    const original = window.save;
    const wrapped = function () {
      const r = original.apply(this, arguments);
      // Track local-save time for sync comparisons, but do NOT auto-push to
      // cloud: auto-backup made whatever device was active overwrite the cloud,
      // which silently defeated cross-device restore. Cloud writes are now
      // explicit (Cloud Backup / Sync Now) so backup-here -> restore-there works.
      try { markLocalSaveUpdated(); } catch (e) {}
      return r;
    };
    wrapped.__ofHooked = true;
    window.save = wrapped;
    return true;
  }
  return false;
}

(function attachHook() {
  if (hookGameSave()) return;
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (hookGameSave() || tries > 40) clearInterval(t);
  }, 250);
})();

onAuthStateChanged(auth, () => { updateCloudStatus(); });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildPanel);
} else {
  buildPanel();
}

window.OathforgeCloud = {
  markLocalSaveUpdated,
  queueAutoBackup,
  cloudBackup,
  restoreCloudSave,
  syncNow
};
