"""Find the Echo360 stream files behind a player page and download them.

Every Echo360 recording here is stored as one fragmented MP4 per source:
  s0q<N>.mp4  audio
  s1q<N>.mp4  video source 1 (s2q<N>.mp4 = source 2, if the room recorded two)
The .m3u8 playlists only point at byte ranges of those files, so downloading the
whole .mp4 is the same as downloading the stream. q1 is the high-quality version.

Access is granted either by a signed query string (secure links, public links) or
by CloudFront cookies on .echo360.net.au (course recordings). We capture both from
the browser: the first request the player makes to content.echo360.net.au.
"""
import re
import time
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

import requests

CONTENT = "content.echo360.net.au"
CHUNK = 1 << 20


class Capture:
    def __init__(self, base, qs, cookies, title, duration):
        self.base = base          # https://content.echo360.net.au/0000.<inst>/<media>/1
        self.qs = qs              # signed query string, may be ""
        self.cookies = cookies    # dict of cookies for .echo360.net.au
        self.title = title
        self.duration = duration  # seconds, may be None

    def url(self, name):
        return f"{self.base}/{name}" + (f"?{self.qs}" if self.qs else "")

    def session(self):
        s = requests.Session()
        s.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156 Safari/537.36"
        s.headers["Referer"] = "https://echo360.net.au/"
        s.headers["Origin"] = "https://echo360.net.au"
        for k, v in self.cookies.items():
            s.cookies.set(k, v)
        return s

    def sources(self):
        """Return {'audio': name, 'video': [names]} for the best quality available."""
        s = self.session()
        out = {"audio": None, "video": []}

        def best(n):
            for q in (1, 0):
                r = s.get(self.url(f"s{n}q{q}.m3u8"), timeout=30)
                if r.status_code == 200 and "#EXTM3U" in r.text:
                    m = re.search(r'#EXT-X-MAP:URI="([^"]+)"', r.text)
                    return m.group(1) if m else f"s{n}q{q}.mp4"
            return None

        out["audio"] = best(0)
        for n in range(1, 5):
            v = best(n)
            if v:
                out["video"].append(v)
            elif n > 1:
                break
        return out

    def size(self, name):
        r = self.session().get(self.url(name), headers={"Range": "bytes=0-0"}, timeout=30)
        r.raise_for_status()
        m = re.search(r"/(\d+)$", r.headers.get("Content-Range", ""))
        return int(m.group(1)) if m else int(r.headers.get("Content-Length", 0))

    def download(self, name, path, label=""):
        """Download a whole file, resuming a partial one, with progress output."""
        s = self.session()
        total = self.size(name)
        have = path.stat().st_size if path.exists() else 0
        if have == total:
            print(f"  {label}{name}: already downloaded ({total / 1e6:.0f} MB)", flush=True)
            return
        headers = {"Range": f"bytes={have}-"} if have else {}
        with s.get(self.url(name), headers=headers, stream=True, timeout=60) as r:
            r.raise_for_status()
            if have and r.status_code != 206:
                have = 0
            last = 0
            with open(path, "ab" if have else "wb") as f:
                for chunk in r.iter_content(CHUNK):
                    f.write(chunk)
                    have += len(chunk)
                    if time.time() - last > 5:
                        print(f"  {label}{name}: {have / 1e6:.0f}/{total / 1e6:.0f} MB", flush=True)
                        last = time.time()
        if have != total:
            raise RuntimeError(f"{name}: got {have} of {total} bytes")
        print(f"  {label}{name}: done ({total / 1e6:.0f} MB)", flush=True)


def _cookies(context):
    return {c["name"]: c["value"] for c in context.cookies("https://content.echo360.net.au/")}


def playlist_url(url, media):
    """The same Echo360 playlist page with another item selected."""
    s = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(s.query) if k != "currentMediaId"] + [("currentMediaId", media)]
    return urlunsplit(s._replace(query=urlencode(q)))


def capture(context, url, timeout=60, attempts=3, media=None):
    """Open an Echo360 player page (or anything that launches one), start playback,
    and return a Capture for its streams. Retries, because Learn.UQ/Echo360 pages
    sometimes abort the first navigation.
    media: for a link that opens a playlist (echo360.net.au/ui/playlist/…), the Echo360
    media id of the item to capture; the playlist page is reopened with that item selected."""
    for n in range(attempts):
        try:
            return _capture(context, url, timeout, media)
        except Exception as e:
            if n == attempts - 1:
                raise
            print(f"  retrying after: {str(e).splitlines()[0][:120]}", flush=True)
            time.sleep(3)


def _capture(context, url, timeout, media=None):
    page = context.new_page()
    hits = []
    # With media set, only that item's streams count (a playlist first loads its current item).
    page.on("request", lambda r: hits.append(r.url) if CONTENT in r.url and (".m3u8" in r.url or ".mp4" in r.url)
            and (not media or f"/{media}/" in r.url) else None)
    info = {}

    def on_resp(r):
        if "player-properties" in r.url and r.status == 200 and (not media or f"/{media}/" in r.url):
            try:
                info["props"] = r.json()["data"]
            except Exception:
                pass

    page.on("response", on_resp)
    try:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
        except Exception as e:
            # A redirect inside the page can abort the first navigation; the player may still load.
            if "ERR_ABORTED" not in str(e):
                raise
        deadline = time.time() + timeout
        switched = not media
        while not hits and time.time() < deadline:
            time.sleep(1)
            if not switched:
                pl = next((f for f in page.frames if "echo360.net.au/ui/playlist/" in f.url), None)
                if pl:
                    switched = True
                    if parse_qs(urlsplit(pl.url).query).get("currentMediaId") != [media]:
                        pl.goto(playlist_url(pl.url, media), wait_until="domcontentloaded")
            for f in page.frames:
                if "echo360.net.au" not in f.url:
                    continue
                try:
                    f.evaluate("() => document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); })")
                except Exception:
                    pass
        if not hits:
            raise RuntimeError(f"No Echo360 stream started on {url} (frames: {[f.url[:80] for f in page.frames]})")
        first = hits[0]
        path, _, qs = first.partition("?")
        base = path.rsplit("/", 1)[0]
        title, duration = None, None
        props = info.get("props")
        if props:
            title = props.get("mediaName")
            duration = props["playableAudioVideo"].get("duration")
        if not title:
            for f in page.frames:
                if "echo360.net.au" in f.url:
                    try:
                        title = f.evaluate("() => (document.querySelector('video') || {}).getAttribute?.('aria-label')") or f.title()
                    except Exception:
                        pass
        if duration:
            m = re.match(r"PT([\d.]+)S", duration)
            duration = float(m.group(1)) if m else None
        # The CloudFront signature covers the x-* parameters too, so keep the query string whole.
        return Capture(base, qs if "Signature=" in qs else "", _cookies(context), title, duration)
    finally:
        page.close()
