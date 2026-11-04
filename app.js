// Lectures: watch Echo360 lecture recordings downloaded from Learn.UQ by tools/get.py.
// Google sign-in (Firebase Auth) + Firestore, no billing. Only Alex can read anything
// (firestore.rules). Data:
//   videos/{id}               { course, kind, title, echoTitle, page, where, date, start, duration,
//                               width, height, layout: "single"|"dual", mime, size, chunks,
//                               chunkBytes, times: [...], offsets: [...], done, uploadedAt }
//   videos/{id}/chunks/{i}    { d: Bytes }  i = "00000", "00001", …  (1 MB pieces of the MP4)
//   users/{uid}               { progress: { videoId: { pos, done, t } } }
// The videos are written by tools/get.py (as Alex, through the REST API); the site only reads
// them. stream.js plays a video by fetching just the chunks around the playhead.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, query, where, getDocs, getDoc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { Streamer, mseSupported, typeSupported } from "./stream.js";
import { VERSION } from "./version.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDgEbqEwI9KHnFlBLRJ8RQIgdntISQPty0",
  authDomain: "lecture-player-d77815.firebaseapp.com",
  projectId: "lecture-player-d77815",
  appId: "1:905522641482:web:f737cbe4b19eeead1a04b3",
};

const KEY = "lecture-player:"; // localStorage prefix (all of Alex's sites share one origin)
const DONE_WITHIN = 60;        // seconds from the end that count as watched
const PUSH_DELAY = 15000;      // debounce for saving progress to Firestore
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

const app = initializeApp(FIREBASE_CONFIG);
// Sign-in is kept in localStorage, not Firebase's default IndexedDB: all of Alex's sites share
// one origin and so one sign-in database, and Firebase waits forever if another site's page
// blocks opening it (seen on Android 2026-11-02).
const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const video = $("video");

let me = null;
let videos = [];          // [{id, ...data}]
let course = localStorage.getItem(KEY + "course") || "";
let current = null;       // video open in the player
let streamer = null;
let userUnsub = null;

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false && c !== "") e.append(c);
  return e;
}

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function fmtLength(s) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// ---------- progress (localStorage + Firestore users/{uid}) ----------

const Progress = {
  data: JSON.parse(localStorage.getItem(KEY + "progress") || "{}"),
  dirty: new Set(),
  timer: null,
  get(id) { return this.data[id] || { pos: 0, done: false, t: 0 }; },
  set(id, patch) {
    this.data[id] = { ...this.get(id), ...patch, t: Date.now() };
    localStorage.setItem(KEY + "progress", JSON.stringify(this.data));
    this.dirty.add(id);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), PUSH_DELAY);
  },
  applyRemote(remote = {}) {
    let changed = false;
    for (const [id, p] of Object.entries(remote)) {
      if (!this.data[id] || (p.t || 0) > (this.data[id].t || 0)) { this.data[id] = p; changed = true; }
    }
    if (changed) localStorage.setItem(KEY + "progress", JSON.stringify(this.data));
    return changed;
  },
  async flush() {
    clearTimeout(this.timer);
    if (!me || !this.dirty.size) return;
    const progress = {};
    for (const id of this.dirty) progress[id] = this.data[id];
    this.dirty.clear();
    try {
      await setDoc(doc(db, "users", me.uid), { progress }, { merge: true });
    } catch (e) {
      console.warn("progress sync:", e);
      for (const id of Object.keys(progress)) this.dirty.add(id);
    }
  },
};

// ---------- views ----------

function show(view) {
  for (const id of ["boot", "gate", "list-view", "player-view"]) $(id).hidden = id !== view;
  $("back").hidden = view !== "player-view";
  document.body.classList.toggle("playing-view", view === "player-view");
}

function gate(msg) {
  $("gate-msg").textContent = msg;
  show("gate");
}

function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("v");
  const v = id && videos.find((x) => x.id === id);
  if (v) openVideo(v);
  else { closeVideo(); renderList(); show("list-view"); $("title").textContent = "Lectures"; document.title = "Lectures"; }
}

function courses() {
  return [...new Set(videos.map((v) => v.course))].sort();
}

function lastWatched(list) {
  let best = null;
  for (const v of list) {
    const p = Progress.get(v.id);
    if ((p.pos > 0 || p.done) && (!best || p.t > Progress.get(best.id).t)) best = v;
  }
  return best;
}

function renderList() {
  const cs = courses();
  if (!cs.includes(course)) course = cs[0] || "";
  const tabs = $("course-tabs");
  tabs.replaceChildren(...cs.map((c) => {
    const b = el("button", { type: "button", textContent: c });
    b.setAttribute("aria-pressed", String(c === course));
    b.onclick = () => { course = c; localStorage.setItem(KEY + "course", c); renderList(); };
    return b;
  }));
  tabs.hidden = cs.length < 2;
  const list = $("list");
  if (!videos.length) {
    list.replaceChildren(el("p", { class: "empty", textContent: "No videos uploaded yet. Run tools/get.py on the Mac to add some." }));
    return;
  }
  const mine = videos.filter((v) => v.course === course);
  const recordings = mine.filter((v) => v.kind === "recording").sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  const pages = mine.filter((v) => v.kind !== "recording")
    .sort((a, b) => (a.where + a.page).localeCompare(b.where + b.page, undefined, { numeric: true }) || a.title.localeCompare(b.title, undefined, { numeric: true }));
  const latest = lastWatched(mine);
  const row = (v, n) => {
    const p = Progress.get(v.id);
    const pct = p.done ? 100 : Math.min(100, (p.pos / v.duration) * 100);
    const title = v.kind === "recording" ? `Lecture ${n} · ${fmtDate(v.start || v.date)}` : v.title;
    const meta = [];
    if (v === latest) meta.push(el("span", { class: "last-tag", textContent: "Last watched" }));
    if (v.kind !== "recording" && v.page && v.page !== v.title) meta.push(el("span", { textContent: v.page }));
    meta.push(el("span", { textContent: fmtLength(v.duration) }));
    if (p.done) meta.push(el("span", { class: "done-tag", textContent: "✓ Watched" }));
    else if (p.pos > 5) meta.push(el("span", { textContent: `${fmtTime(p.pos)} watched` }));
    const b = el("button", { type: "button" },
      el("span", { class: "row-title", textContent: title }),
      el("span", { class: "row-meta" }, ...meta),
      pct > 0 ? el("span", { class: "row-bar" }, el("i", { style: `width:${pct}%` })) : null);
    b.onclick = () => { location.hash = `v=${encodeURIComponent(v.id)}`; };
    return el("li", { class: p.done ? "done" : "" }, b);
  };
  const parts = [];
  if (recordings.length) parts.push(el("h2", { textContent: "Lecture recordings" }), el("ul", {}, ...recordings.map((v, i) => row(v, i + 1))));
  if (pages.length) parts.push(el("h2", { textContent: "Videos on course pages" }), el("ul", {}, ...pages.map((v) => row(v))));
  if (!parts.length) parts.push(el("p", { class: "empty", textContent: `No ${course} videos uploaded yet.` }));
  list.replaceChildren(...parts);
}

// ---------- player ----------

let layout = localStorage.getItem(KEY + "layout") || "both";
let lastSave = 0;
let seeking = false;

function setLayout(l) {
  layout = l;
  localStorage.setItem(KEY + "layout", l);
  const dual = current && current.layout === "dual";
  const frame = $("frame");
  frame.dataset.layout = dual ? l : "both";
  const w = current ? current.width / (dual && l !== "both" ? 2 : 1) : 16;
  const h = current ? current.height : 9;
  frame.style.setProperty("--ar", `${w} / ${h}`);
  for (const b of $("layout").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.layout === l));
}

function playerError(msg) {
  $("player-error").textContent = msg;
  $("player-error").hidden = !msg;
}

function openVideo(v) {
  if (current && current.id === v.id) { show("player-view"); return; }
  closeVideo();
  current = v;
  show("player-view");
  const title = v.kind === "recording" ? `${v.course} lecture · ${fmtDate(v.start || v.date)}` : v.title;
  $("title").textContent = title;
  document.title = title;
  $("layout").hidden = v.layout !== "dual";
  setLayout(layout);
  $("video-info").textContent = [v.course, v.kind !== "recording" ? v.page : "", fmtLength(v.duration)].filter(Boolean).join(" · ");
  $("time-total").textContent = fmtTime(v.duration);
  playerError("");
  updateMark();
  if (!mseSupported() || !typeSupported(v.mime)) {
    playerError("This browser can't stream this video (no Media Source support for " + v.mime + ").");
    return;
  }
  $("spinner").hidden = false;
  const read = async (n) => {
    const snap = await getDoc(doc(db, "videos", v.id, "chunks", String(n).padStart(5, "0")));
    if (!snap.exists()) throw new Error(`Part ${n} of this video is missing.`);
    return snap.data().d.toUint8Array();
  };
  streamer = new Streamer(video, v, read, {
    onError: (e) => { console.error(e); playerError(e.message || String(e)); $("spinner").hidden = true; },
    onWaiting: (w) => { if (w && video.paused) return; $("spinner").hidden = !w; },
  });
  const p = Progress.get(v.id);
  const resume = p.done || p.pos > v.duration - DONE_WITHIN ? 0 : p.pos;
  streamer.ready.then(() => {
    if (current !== v) return;
    if (resume > 1) video.currentTime = resume;
    $("spinner").hidden = true;
    updateSeek();
  }).catch((e) => { playerError(e.message || String(e)); $("spinner").hidden = true; });
  video.playbackRate = Number(localStorage.getItem(KEY + "speed")) || 1;
  $("speed").textContent = `${video.playbackRate}×`;
  setupMediaSession(v, title);
}

function closeVideo() {
  if (!current) return;
  saveProgress(true);
  if (streamer) streamer.destroy();
  streamer = null;
  current = null;
  Progress.flush();
}

function saveProgress(force = false) {
  if (!current || !Number.isFinite(video.currentTime) || video.currentTime < 0.5 && !force) return;
  const pos = video.currentTime;
  const p = Progress.get(current.id);
  if (!force && Math.abs(pos - p.pos) < 4) return;
  const patch = { pos };
  if (pos >= current.duration - DONE_WITHIN) patch.done = true;
  Progress.set(current.id, patch);
  updateMark();
}

function updateMark() {
  const done = current && Progress.get(current.id).done;
  $("mark").textContent = done ? "✓ Watched" : "Mark as watched";
  $("mark").classList.toggle("on", Boolean(done));
}

function updateSeek() {
  if (!current) return;
  const d = current.duration;
  const t = video.currentTime || 0;
  if (!seeking) $("seek").value = String(Math.round((t / d) * 1000));
  $("seek-played").style.width = `calc((100% - 18px) * ${Math.min(1, t / d)})`;
  let end = t;
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
  $("seek-buffered").style.width = `calc((100% - 18px) * ${Math.min(1, end / d)})`;
  $("time-now").textContent = fmtTime(seeking ? ($("seek").value / 1000) * d : t);
  $("play").classList.toggle("on", !video.paused);
  $("play").setAttribute("aria-label", video.paused ? "Play" : "Pause");
}

function skip(s) {
  if (!current) return;
  video.currentTime = Math.max(0, Math.min(current.duration - 0.5, video.currentTime + s));
  updateSeek();
}

function togglePlay() {
  if (!current) return;
  if (video.paused) video.play().catch((e) => { if (e.name !== "AbortError") playerError(e.message); });
  else video.pause();
}

function setupMediaSession(v, title) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: v.course, album: "Lectures" });
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
  set("play", () => video.play());
  set("pause", () => video.pause());
  set("seekbackward", () => skip(-10));
  set("seekforward", () => skip(10));
  set("seekto", (e) => { video.currentTime = e.seekTime; });
}

function fullscreen() {
  const frame = $("frame");
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (frame.requestFullscreen) frame.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
  else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone: shows the whole video
}

video.addEventListener("timeupdate", () => {
  updateSeek();
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveProgress(); }
});
video.addEventListener("play", updateSeek);
video.addEventListener("pause", () => { updateSeek(); saveProgress(true); Progress.flush(); });
video.addEventListener("progress", updateSeek);
video.addEventListener("waiting", () => { $("spinner").hidden = false; });
video.addEventListener("playing", () => { $("spinner").hidden = true; });
video.addEventListener("seeked", () => { $("spinner").hidden = true; updateSeek(); });
video.addEventListener("ended", () => { if (current) { Progress.set(current.id, { done: true, pos: current.duration }); updateMark(); Progress.flush(); } });
video.addEventListener("click", togglePlay);

const seek = $("seek");
seek.addEventListener("input", () => { seeking = true; updateSeek(); });
seek.addEventListener("change", () => {
  seeking = false;
  if (current) video.currentTime = (seek.value / 1000) * current.duration;
  updateSeek();
});

$("play").onclick = togglePlay;
$("back10").onclick = () => skip(-10);
$("fwd10").onclick = () => skip(10);
$("back").onclick = () => { if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back(); else location.hash = ""; };
$("speed").onclick = () => {
  const i = (SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length;
  video.playbackRate = SPEEDS[i];
  localStorage.setItem(KEY + "speed", String(SPEEDS[i]));
  $("speed").textContent = `${SPEEDS[i]}×`;
};
for (const b of $("layout").querySelectorAll("button")) b.onclick = () => setLayout(b.dataset.layout);
$("fullscreen").onclick = fullscreen;
$("mark").onclick = () => {
  if (!current) return;
  const done = !Progress.get(current.id).done;
  Progress.set(current.id, done ? { done } : { done, pos: 0 });
  if (!done) video.currentTime = 0;
  updateMark();
  Progress.flush();
};

document.addEventListener("keydown", (e) => {
  if (!current || e.target.closest("input, textarea") && e.target !== seek || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft" || e.key === "j") { e.preventDefault(); skip(-10); }
  else if (e.key === "ArrowRight" || e.key === "l") { e.preventDefault(); skip(10); }
  else if (e.key === "f") fullscreen();
  else if (e.key === "Escape" && !document.fullscreenElement) location.hash = "";
});

addEventListener("hashchange", route);
addEventListener("pagehide", () => { saveProgress(true); Progress.flush(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { saveProgress(true); Progress.flush(); } });

// ---------- sign-in and data ----------

$("signin").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
  if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") gate(`Sign-in failed: ${e.message}`);
});
$("signout").onclick = async () => { await Progress.flush(); await signOut(auth); location.hash = ""; location.reload(); };

async function loadVideos() {
  const snap = await getDocs(query(collection(db, "videos"), where("done", "==", true)));
  videos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; gate("Sign in to watch your lectures."); return; }
  $("boot-text").textContent = "Loading lectures…";
  try {
    await loadVideos();
  } catch (e) {
    if (e.code === "permission-denied") {
      gate(`${user.email} can't use this site. It's only for Alex.`);
      $("signout").hidden = false;
      return;
    }
    gate(`Couldn't load the lectures: ${e.message}`);
    return;
  }
  me = user;
  $("signout").hidden = false;
  if (userUnsub) userUnsub();
  // Wait (briefly) for the synced progress, so opening a video resumes where another device left off.
  let firstSnap;
  const gotFirst = new Promise((resolve) => { firstSnap = resolve; });
  userUnsub = onSnapshot(doc(db, "users", user.uid), (s) => {
    const changed = Progress.applyRemote(s.data()?.progress);
    firstSnap();
    if (changed && !current) renderList();
  }, (e) => { console.warn("progress listener:", e); firstSnap(); });
  await Promise.race([gotFirst, new Promise((r) => setTimeout(r, 3000))]);
  route();
});

// Update light (green = latest version) from the shared pages-common library
// (github.com/alexknight0/pages-common). Loaded dynamically so the site still works if
// jsDelivr is unreachable.
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: "#version",
    beforeUpdate: () => { saveProgress(true); return Progress.flush().then(() => true); },
  }))
  .catch((e) => {
    console.warn("update light:", e);
    for (const b of document.querySelectorAll(".version")) {
      b.dataset.state = "unknown";
      b.title = "Couldn't load the update check (offline?).";
    }
  });
