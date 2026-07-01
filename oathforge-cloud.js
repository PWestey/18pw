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
   - The local save key is auto-detected at runtime so it keeps
     working even if the game's storage key differs by build.
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

/* Preferred/known Oathforge localStorage save key. If this key holds
   data we use it; otherwise we auto-detect the real save key. */
const PREFERRED_SAVE_KEY = "lifequest_afk_v1";

const LOCAL_UPDATED_KEY = "OF_LAST_LOCAL_SAVE_MS";
const LAST_SYNC_KEY = "OF_LAST_CLOUD_SYNC_MS";
const DEVICE_ID_KEY = "OF_DEVICE_ID";
const RESOLVED_KEY_KEY = "OF_RESOLVED_SAVE_KEY";

/* Keys we must never treat as the game save. */
function isReservedKey(k) {
  return (
    k === LOCAL_UPDATED_KEY ||
    k === LAST_SYNC_KEY ||
    k === DEVICE_ID_KEY ||
    k === RESOLVED_KEY_KEY ||
    k.indexOf("firebase:") === 0 ||
    k.indexOf("firebaseLocalStorage") === 0 ||
    k.indexOf("OF_PRE_CLOUD_RESTORE_") === 0 ||
    k === "oathforge_stability_mode"
  );
}

function looksLikeSaveValue(raw) {
  if (!raw || raw.length < 20) return false;
  const t = raw.trim();
  if (t[0] !== "{" && t[0] !== "[") return false;
  try { JSON.parse(t); return true; } catch (e) { return false; }
}

/* Resolve the localStorage key that holds the real Oathforge save.
   Order: cached resolved key -> preferred key (if it has data) ->
   the largest localStorage entry that parses as JSON and is not a
   reserved key. Returns null if nothing plausible is found. */
function resolveSaveKey() {
  const cached = localStorage.getItem(RESOLVED_KEY_KEY);
  if (cached && localStorage.getItem(cached) != null) return cached;

  if (localStorage.getItem(PREFERRED_SAVE_KEY) != null) {
    localStorage.setItem(RESOLVED_KEY_KEY, PREFERRED_SAVE_KEY);
    return PREFERRED_SAVE_KEY;
  }

  let best = null;
  let bestLen = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || isReservedKey(k)) continue;
    const v = localStorage.getItem(k) || "";
    if (v.length > bestLen && looksLikeSaveValue(v)) {
      best = k;
      bestLen = v.length;
    }
  }
  if (best) localStorage.setItem(RESOLVED_KEY_KEY, best);
  return best; // may be null
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
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

function getLocalRawSave() {
  const key = resolveSaveKey();
  return key ? localStorage.getItem(key) : null;
}

function getLocalSaveObject() {
  const raw = getLocalRawSave();
  if (!raw) {
    throw new Error(
      "No local Oathforge save found. Open the game so it loads/creates a save, then try again. " +
      "(Looked for key \"" + PREFERRED_SAVE_KEY + "\" and any large JSON save in this browser.)"
    );
  }
  return JSON.parse(raw);
}

function writeLocalSaveObject(saveObj) {
  const key = resolveSaveKey() || PREFERRED_SAVE_KEY;
  const raw = JSON.stringify(saveObj);
  const backupKey = "OF_PRE_CLOUD_RESTORE_" + Date.now();
  const existing = localStorage.getItem(key);
  if (existing) localStorage.setItem(backupKey, existing);
  localStorage.setItem(key, raw);
  markLocalSaveUpdated();
  alert("Cloud save restored. Oathforge will reload now.\n\nSafety backup created in localStorage as:\n" + backupKey);
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
  const localSave = getLocalSaveObject();
  const raw = JSON.stringify(localSave);
  if (raw.length > 900000) {
    throw new Error("Save is too large for this simple Firestore setup: " + raw.length + " characters.");
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
    schema: 1,
    saveJson: raw,
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
  const saveObj = JSON.parse(data.saveJson);
  writeLocalSaveObject(saveObj);
}

async function syncNow() {
  const localRaw = getLocalRawSave();
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
    '<p class="small-note" style="opacity:0.75;font-size:0.85em;margin-top:8px;">Local save remains primary. Cloud restore always asks before replacing this device.</p>';

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
      try { markLocalSaveUpdated(); queueAutoBackup(); } catch (e) {}
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
  syncNow,
  resolveSaveKey
};
