// Streams a fragmented MP4 that is stored as 1 MB chunk documents into a <video>, using Media
// Source Extensions (ManagedMediaSource on iPhone). Only the part around the playhead is
// fetched, so playback starts quickly and seeking anywhere works without the whole file.
//
// meta (from the video's Firestore doc):
//   mime      'video/mp4; codecs="avc1.640029, mp4a.40.2"'
//   duration  seconds
//   size      total bytes;  chunkBytes  bytes per chunk doc
//   times[i]  start time (s) of fragment i;  offsets[i]  its byte offset
//             (bytes before offsets[0] are the init segment: ftyp + moov)
// readChunk(n) resolves to the Uint8Array of chunk n.

const AHEAD = 90;        // seconds to keep buffered ahead of the playhead
const BEHIND = 30;       // seconds kept behind it (older data is removed to save memory)
const BATCH_BYTES = 1_500_000; // fragments fetched and appended together
const CHUNK_CACHE = 8;   // chunk docs kept in memory

export function mseSupported() {
  return Boolean(window.ManagedMediaSource || window.MediaSource);
}

export function typeSupported(mime) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  return Boolean(MS && MS.isTypeSupported(mime));
}

export class Streamer {
  constructor(video, meta, readChunk, { onError = () => {}, onWaiting = () => {} } = {}) {
    this.video = video;
    this.meta = meta;
    this.readChunk = readChunk;
    this.onError = onError;
    this.onWaiting = onWaiting;
    this.cache = new Map();   // chunk number -> Promise<Uint8Array>
    this.appended = new Set(); // fragment numbers currently in the buffer
    this.closed = false;
    this.wake = null;
    const MS = window.ManagedMediaSource || window.MediaSource;
    this.ms = new MS();
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) {
      video.disableRemotePlayback = true; // required for ManagedMediaSource without an AirPlay source
    }
    this.url = URL.createObjectURL(this.ms);
    video.src = this.url;
    this.ready = new Promise((resolve, reject) => {
      this.ms.addEventListener("sourceopen", () => this.open().then(resolve, reject), { once: true });
    });
    this.onSeeking = () => this.poke();
    this.onTime = () => this.poke();
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("timeupdate", this.onTime);
  }

  async open() {
    this.sb = this.ms.addSourceBuffer(this.meta.mime);
    this.sb.mode = "segments";
    this.ms.duration = this.meta.duration;
    await this.append(await this.bytes(0, this.meta.offsets[0]));
    this.loop().catch((e) => { if (!this.closed) this.onError(e); });
  }

  destroy() {
    this.closed = true;
    this.poke();
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("timeupdate", this.onTime);
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
    this.cache.clear();
  }

  poke() {
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
  }

  // ---- bytes from chunk docs ----

  chunk(n) {
    if (!this.cache.has(n)) {
      const p = this.readChunk(n).catch((e) => { this.cache.delete(n); throw e; });
      this.cache.set(n, p);
      while (this.cache.size > CHUNK_CACHE) this.cache.delete(this.cache.keys().next().value);
    } else {
      const p = this.cache.get(n); // move to the end (most recently used)
      this.cache.delete(n);
      this.cache.set(n, p);
    }
    return this.cache.get(n);
  }

  async bytes(start, end) {
    const cb = this.meta.chunkBytes;
    const first = Math.floor(start / cb);
    const last = Math.floor((end - 1) / cb);
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.chunk(first + i)));
    const out = new Uint8Array(end - start);
    let pos = 0;
    parts.forEach((c, i) => {
      const n = first + i;
      const from = n === first ? start - n * cb : 0;
      const to = n === last ? end - n * cb : c.length;
      out.set(c.subarray(from, to), pos);
      pos += to - from;
    });
    // Start fetching the next chunk early so playback doesn't wait on it.
    if ((last + 1) * cb < this.meta.size) this.chunk(last + 1).catch(() => {});
    return out;
  }

  // ---- fragments ----

  fragAt(t) {
    const times = this.meta.times;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  fragEnd(i) {
    return i + 1 < this.meta.offsets.length ? this.meta.offsets[i + 1] : this.meta.size;
  }

  bufferedEnd(t) {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.3 && t < b.end(i)) return b.end(i);
    }
    return t;
  }

  async append(data) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.waitIdle();
        this.sb.appendBuffer(data);
        await this.waitIdle();
        return;
      } catch (e) {
        if (e.name !== "QuotaExceededError" || attempt > 2) throw e;
        await this.evict(true);
      }
    }
  }

  waitIdle() {
    if (!this.sb.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { this.sb.removeEventListener("updateend", done); this.sb.removeEventListener("error", fail); resolve(); };
      const fail = () => { this.sb.removeEventListener("updateend", done); this.sb.removeEventListener("error", fail); reject(new Error("The video data couldn't be decoded.")); };
      this.sb.addEventListener("updateend", done);
      this.sb.addEventListener("error", fail);
    });
  }

  async evict(hard = false) {
    const t = this.video.currentTime;
    const keepFrom = Math.max(0, t - (hard ? 5 : BEHIND));
    const keepTo = t + AHEAD + (hard ? 0 : 60);
    const b = this.video.buffered;
    const ranges = [];
    for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
    let removed = false;
    for (const [s, e] of ranges) {
      if (s < keepFrom) { await this.waitIdle(); this.sb.remove(s, Math.min(e, keepFrom)); await this.waitIdle(); removed = true; }
      if (e > keepTo) { await this.waitIdle(); this.sb.remove(Math.max(s, keepTo), e); await this.waitIdle(); removed = true; }
    }
    if (removed) {
      // Forget fragments that are no longer (fully) buffered so they get fetched again if needed.
      for (const i of [...this.appended]) {
        const start = this.meta.times[i];
        if (start < keepFrom - 1 || start > keepTo) this.appended.delete(i);
      }
    }
  }

  async loop() {
    const n = this.meta.times.length;
    while (!this.closed) {
      const t = this.video.currentTime;
      const end = this.bufferedEnd(t);
      if (end - t >= AHEAD || (end >= this.meta.duration - 0.5)) {
        if (end >= this.meta.duration - 0.5 && this.ms.readyState === "open" && !this.sb.updating) {
          try { this.ms.endOfStream(); } catch { /* already ended */ }
        }
        await this.sleep(2000);
        continue;
      }
      let i = this.fragAt(end + 0.05);
      while (i < n && this.appended.has(i) && this.meta.times[i] < end + 0.05) i++;
      if (i >= n) { await this.sleep(2000); continue; }
      let j = i + 1;
      while (j < n && !this.appended.has(j) && this.fragEnd(j) - this.meta.offsets[i] < BATCH_BYTES) j++;
      if (end - t < 2) this.onWaiting(true);
      const data = await this.bytes(this.meta.offsets[i], this.fragEnd(j - 1));
      if (this.closed) return;
      // If the user seeked far away while this was downloading, drop it and start again there.
      const now = this.video.currentTime;
      if (this.meta.times[i] > now + AHEAD * 1.5 || (this.meta.times[j] ?? this.meta.duration) < now - BEHIND) continue;
      await this.evict();
      await this.append(data);
      for (let k = i; k < j; k++) this.appended.add(k);
      this.onWaiting(false);
    }
  }
}
