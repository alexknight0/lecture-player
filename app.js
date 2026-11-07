// Lectures: watch Echo360 lecture recordings downloaded from Learn.UQ by tools/get.py.
// Google sign-in (Firebase Auth) + Firestore. Only Sophie and Alex can read anything
// (firestore.rules). Data:
//   videos/{id}               { course, courseName, kind, title, echoTitle, page, where, date, start,
//                               order, key, done, and once uploaded: duration, width, height,
//                               layout: "single"|"dual", mime, size, chunks, chunkBytes, times: [...],
//                               offsets: [...], uploadedAt }
//                             done: false = listed but not uploaded yet (shown greyed out).
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
  getFirestore, collection, doc, getDocs, getDoc, setDoc, onSnapshot,
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

// Row icons (static strings, no user data).
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M9 6.5v11l9-5.5z" fill="currentColor"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WAIT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8.5V12l2.5 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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

// Page title and video title that say the same thing (e.g. "Knee ROM" vs "PHTY1200_Knee ROM").
function similar(a, b) {
  const norm = (s) => s.toLowerCase().replace(/^[a-z]{4}\d{4}[_\s-]*/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
}

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
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
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
  const v = id && videos.find((x) => x.id === id && x.done === true);
  if (v) openVideo(v);
  else {
    // While the video floats in Picture in Picture, going back to the list keeps it playing.
    if (!inPip()) closeVideo();
    renderList(); show("list-view"); $("title").textContent = "Lectures"; document.title = "Lectures";
  }
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
    const b = el("button", { type: "button", textContent: c, title: videos.find((v) => v.course === c)?.courseName || c });
    b.setAttribute("aria-pressed", String(c === course));
    b.onclick = () => { course = c; localStorage.setItem(KEY + "course", c); renderList(); };
    return b;
  }));
  tabs.hidden = cs.length < 2;
  $("course-name").textContent = videos.find((v) => v.course === course)?.courseName || "";
  const list = $("list");
  if (!videos.length) {
    list.replaceChildren(el("p", { class: "empty", textContent: "No videos uploaded yet. Run tools/get.py on the Mac to add some." }));
    return;
  }
  const mine = videos.filter((v) => v.course === course);
  const recordings = mine.filter((v) => v.kind === "recording").sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  // Videos on course pages, in Learn.UQ's order, grouped by the folder they're in.
  const pages = mine.filter((v) => v.kind !== "recording").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const latest = lastWatched(mine);
  const row = (v, n) => {
    const p = Progress.get(v.id);
    const ready = v.done === true;
    const pct = !ready ? 0 : p.done ? 100 : Math.min(100, (p.pos / v.duration) * 100);
    const date = fmtDate(v.start || v.date);
    const title = v.kind === "recording" ? (v.title || `Lecture ${n}`) : v.title;
    const meta = [];
    if (v === latest) meta.push(el("span", { class: "last-tag", textContent: "Last watched" }));
    if (v.kind === "recording" && date) meta.push(el("span", { textContent: date }));
    if (v.kind !== "recording" && v.page && !similar(v.page, v.title)) meta.push(el("span", { textContent: v.page }));
    if (ready && v.duration) meta.push(el("span", { textContent: fmtLength(v.duration) }));
    if (!ready) meta.push(el("span", { class: "missing-tag", textContent: "Not uploaded yet" }));
    else if (p.done) meta.push(el("span", { class: "done-tag", textContent: "✓ Watched" }));
    else if (p.pos > 5) meta.push(el("span", { textContent: `${fmtTime(p.pos)} watched` }));
    const b = el("button", { type: "button", disabled: !ready },
      el("span", { class: "row-icon", ariaHidden: "true", innerHTML: !ready ? ICON_WAIT : p.done ? ICON_DONE : ICON_PLAY }),
      el("span", { class: "row-text" },
        el("span", { class: "row-title", textContent: title }),
        el("span", { class: "row-meta" }, ...meta),
        pct > 0 && !p.done ? el("span", { class: "row-bar" }, el("i", { style: `width:${pct}%` })) : null));
    if (ready) b.onclick = () => { location.hash = `v=${encodeURIComponent(v.id)}`; route(); };
    return el("li", { class: [p.done && ready ? "done" : "", ready ? "" : "missing"].join(" ").trim() }, b);
  };
  const parts = [];
  if (recordings.length) {
    parts.push(folder(`${course}|rec`, "Lecture recordings", recordings.map((v, i) => row(v, i + 1)), recordings, true));
  }
  parts.push(...renderTree(buildTree(pages), row, latest));
  if (!parts.length) parts.push(el("p", { class: "empty", textContent: `No ${course} videos yet.` }));
  list.replaceChildren(...parts);
  updateFoldAll();
  const ready = mine.filter((v) => v.done === true).length;
  $("list-status").textContent = ready < mine.length ? `${ready} of ${mine.length} videos uploaded so far.` : "";
}

// ---------- folders (collapsible, nested like Learn.UQ's) ----------

// Tree of {name, path, folders: Map, videos: []} from each video's `where` ("A / B / C").
function buildTree(vs) {
  const root = { name: "", path: "", folders: new Map(), videos: [] };
  for (const v of vs) {
    let node = root;
    for (const seg of (v.where ? v.where.split(" / ") : [])) {
      if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: node.path ? `${node.path} / ${seg}` : seg, folders: new Map(), videos: [] });
      node = node.folders.get(seg);
    }
    node.videos.push(v);
  }
  simplify(root);
  return root;
}

// Most videos sit alone in their own folder (the folder is their page): show those videos
// directly in the parent, and merge chains of folders that only contain one folder.
function simplify(node) {
  for (const [key, f] of [...node.folders]) {
    simplify(f);
    if (f.folders.size === 0 && f.videos.length === 1) {
      node.folders.delete(key);
      node.videos.push(f.videos[0]);
    } else if (f.videos.length === 0 && f.folders.size === 1) {
      const [only] = f.folders.values();
      node.folders.delete(key);
      node.folders.set(key, { ...only, name: `${f.name} / ${only.name}` });
    }
  }
  node.videos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function allVideos(node) {
  return [...node.videos, ...[...node.folders.values()].flatMap(allVideos)];
}

function firstOrder(node) {
  return Math.min(...allVideos(node).map((v) => v.order ?? 0));
}

// Folders and videos of one level, in Learn.UQ's order.
function renderTree(node, row, latest) {
  const items = [
    ...node.videos.map((v) => ({ order: v.order ?? 0, el: () => el("ul", { class: "loose" }, row(v)) })),
    ...[...node.folders.values()].map((f) => ({
      order: firstOrder(f),
      el: () => folder(`${course}|${f.path}`, f.name, renderTree(f, row, latest), allVideos(f), allVideos(f).includes(latest)),
    })),
  ].sort((a, b) => a.order - b.order);
  // Consecutive loose videos go in one list.
  const out = [];
  for (const it of items) {
    const e = it.el();
    const prev = out[out.length - 1];
    if (e.classList.contains("loose") && prev && prev.classList.contains("loose")) prev.append(...e.childNodes);
    else out.push(e);
  }
  return out;
}

// Folder open/closed state, remembered per folder once she opens or closes it. Until then:
// Lecture recordings start open, and so does the folder holding the last-watched video.
const folderState = JSON.parse(localStorage.getItem(KEY + "folders") || "{}");

function folder(id, name, children, vs, openByDefault) {
  const watched = vs.filter((v) => Progress.get(v.id).done).length;
  const count = [`${vs.length} video${vs.length === 1 ? "" : "s"}`];
  if (watched) count.push(`${watched} watched`);
  const rows = children.filter((c) => c.tagName === "LI");
  const rest = children.filter((c) => c.tagName !== "LI");
  const summary = el("summary", {}, el("span", { class: "folder-name", textContent: name }), el("span", { class: "folder-count", textContent: count.join(" · ") }));
  const d = el("details", { class: "folder", open: folderState[id] ?? Boolean(openByDefault) }, summary,
    rows.length ? el("ul", {}, ...rows) : null, ...rest);
  // Remember only what she chooses (a "toggle" listener would also fire for the default state).
  d.dataset.id = id;
  d.addEventListener("toggle", updateFoldAll);
  summary.addEventListener("click", () => setTimeout(() => {
    folderState[id] = d.open;
    localStorage.setItem(KEY + "folders", JSON.stringify(folderState));
  }));
  return d;
}

// "Expand all" when any folder in this course is closed, otherwise "Collapse all".
function updateFoldAll() {
  const ds = [...$("list").querySelectorAll("details.folder")];
  const btn = $("fold-all");
  btn.hidden = ds.length < 2;
  btn.textContent = ds.some((d) => !d.open) ? "Expand all" : "Collapse all";
}

$("fold-all").onclick = () => {
  const ds = [...$("list").querySelectorAll("details.folder")];
  const open = ds.some((d) => !d.open);
  for (const d of ds) { d.open = open; folderState[d.dataset.id] = open; }
  localStorage.setItem(KEY + "folders", JSON.stringify(folderState));
  updateFoldAll();
};

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
  const title = v.kind === "recording" ? [v.title || `${v.course} lecture`, fmtDate(v.start || v.date)].filter(Boolean).join(" · ") : v.title;
  $("title").textContent = title;
  $("fs-title").textContent = title;
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
    // A video linked from two pages is stored once; the second listing points at it (chunksFrom).
    const snap = await getDoc(doc(db, "videos", v.chunksFrom || v.id, "chunks", String(n).padStart(5, "0")));
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
  // Start playing straight away. When this runs inside the tap on a row (the row's click calls
  // route() directly), the browser counts it as a user gesture, so sound is allowed even on
  // iPhone/iPad. Opening from a link or a reload may be refused; then it just waits paused.
  video.play().catch((e) => { if (e.name !== "NotAllowedError" && e.name !== "AbortError") console.warn("autoplay:", e); updateSeek(); });
  poke();
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
  $("fs-play").classList.toggle("on", !video.paused);
  $("ov-play").classList.toggle("on", !video.paused);
  $("ov-play").setAttribute("aria-label", video.paused ? "Play" : "Pause");
  $("fs-play").setAttribute("aria-label", video.paused ? "Play" : "Pause");
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
  } else if (frame.requestFullscreen) {
    frame.requestFullscreen({ navigationUI: "hide" }).then(lockLandscape, () => video.webkitEnterFullscreen?.());
  } else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone: its own player, with its own controls
}

// ---- Picture in Picture ----
// The standard API (requestPictureInPicture) where it exists; Safari's own
// webkitSetPresentationMode otherwise. In PiP the system's controls are used (play/pause and
// ±skip, from the media session handlers above); a dual video shows both cameras.
function pipSupported() {
  return (document.pictureInPictureEnabled && !video.disablePictureInPicture)
    || Boolean(video.webkitSupportsPresentationMode?.("picture-in-picture"));
}

function inPip() {
  return document.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture";
}

function togglePip() {
  if (!current) return;
  if (inPip()) {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.webkitSetPresentationMode("inline");
  } else if (video.requestPictureInPicture && document.pictureInPictureEnabled) {
    video.requestPictureInPicture().catch((e) => playerError(`Picture in Picture failed: ${e.message}`));
  } else if (video.webkitSetPresentationMode) {
    video.webkitSetPresentationMode("picture-in-picture");
  }
}

// Leaving PiP: if the video is still playing (the "back to page" button), show its player
// again; if it was paused or closed while the list is showing, stop it properly.
function onPipLeave() {
  if (!current || !$("player-view").hidden) return;
  if (video.paused) closeVideo();
  else location.hash = `v=${encodeURIComponent(current.id)}`;
}
video.addEventListener("leavepictureinpicture", onPipLeave);
video.addEventListener("webkitpresentationmodechanged", () => { if (!inPip()) onPipLeave(); });
$("pip").hidden = !pipSupported();
$("pip").onclick = togglePip;

// Android: turn landscape videos sideways in full screen (not supported on iPad/desktop; ignored there).
function lockLandscape() {
  if (current && current.width > current.height) screen.orientation?.lock?.("landscape").catch(() => {});
}

function isFullscreen() {
  return (document.fullscreenElement || document.webkitFullscreenElement) === $("frame");
}

function onFullscreenChange() {
  const fs = isFullscreen();
  $("frame").classList.toggle("fs", fs);
  $("fullscreen").setAttribute("aria-label", fs ? "Exit full screen" : "Full screen");
  $("fullscreen").title = fs ? "Exit full screen (f)" : "Full screen (f)";
  if (!fs) screen.orientation?.unlock?.();
  poke();
}
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);

// ---- Touch gestures on the video ----
// Full screen with a finger: tap shows/hides the controls; double-tap the left or right side
// skips 10 s, and further taps on that side keep adding 10 s (like YouTube). With a mouse, or
// outside full screen, a click plays/pauses and a double-click toggles full screen.
const TAP_WAIT = 260;   // ms to wait for a second tap
const STREAK = 700;     // ms after a skip in which one more tap on the same side skips again
let lastPointer = "mouse";
let tapTimer = null;
let lastTap = { t: 0, side: "" };
let streak = { t: 0, side: "", total: 0 };

function sideOf(e) {
  const r = $("frame").getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  return x < 0.35 ? "left" : x > 0.65 ? "right" : "middle";
}

function flashSkip(side, total) {
  const f = $(side === "left" ? "skip-left" : "skip-right");
  f.querySelector("span").textContent = `${side === "left" ? "−" : "+"}${total} s`;
  f.classList.add("on");
  clearTimeout(f._t);
  f._t = setTimeout(() => f.classList.remove("on"), 650);
}

function gestureSkip(side) {
  const now = Date.now();
  streak = now - streak.t < STREAK && streak.side === side ? { t: now, side, total: streak.total + 10 } : { t: now, side, total: 10 };
  skip(side === "left" ? -10 : 10);
  flashSkip(side, streak.total);
}

function toggleControls() {
  const frame = $("frame");
  if (frame.classList.contains("idle")) poke();
  else { clearTimeout(idleTimer); frame.classList.add("idle"); }
}

function onVideoTap(e) {
  if (!(lastPointer === "touch" && isFullscreen())) { togglePlay(); return; }
  const side = sideOf(e);
  const now = Date.now();
  if (side !== "middle" && now - streak.t < STREAK && streak.side === side) {
    gestureSkip(side);
  } else if (side !== "middle" && tapTimer && now - lastTap.t < TAP_WAIT && lastTap.side === side) {
    clearTimeout(tapTimer); tapTimer = null;
    gestureSkip(side);
  } else {
    clearTimeout(tapTimer);
    lastTap = { t: now, side };
    tapTimer = setTimeout(() => { tapTimer = null; toggleControls(); }, side === "middle" ? 0 : TAP_WAIT);
  }
}

video.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType; }, { passive: true });
video.addEventListener("dblclick", (e) => { if (lastPointer !== "touch") { e.preventDefault(); fullscreen(); } });

$("fs-play").onclick = () => { togglePlay(); poke(); };
$("ov-play").onclick = () => { togglePlay(); poke(); };
$("fs-back").onclick = () => { skip(-10); poke(); };
$("fs-fwd").onclick = () => { skip(10); poke(); };

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
video.addEventListener("click", onVideoTap);

// Overlay controls: hide them 2.5 s after the last pointer activity while playing (3.5 s in full
// screen). A finger on the video in full screen is handled by onVideoTap instead, so a tap can hide them.
let idleTimer = null;
function poke() {
  const frame = $("frame");
  frame.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && !seeking) frame.classList.add("idle"); }, isFullscreen() ? 3500 : 2500);
}
for (const ev of ["pointermove", "pointerdown"]) {
  $("frame").addEventListener(ev, (e) => {
    if (e.pointerType === "touch" && e.target === video && isFullscreen()) return;
    if (e.pointerType === "touch" && ev === "pointermove") return;
    poke();
  }, { passive: true });
}
video.addEventListener("play", poke);
video.addEventListener("pause", () => { clearTimeout(idleTimer); $("frame").classList.remove("idle"); });

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
  else if (e.key === "p") togglePip();
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
  // Every listed video, including ones not uploaded yet (done: false), which show greyed out.
  const snap = await getDocs(collection(db, "videos"));
  videos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; gate("Sign in to watch your lectures."); return; }
  $("boot-text").textContent = "Loading lectures…";
  try {
    await loadVideos();
  } catch (e) {
    if (e.code === "permission-denied") {
      gate(`${user.email} doesn't have access to this site.`);
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
