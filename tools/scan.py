"""Find every Echo360 video in a set of Learn.UQ courses.

Usage:
  scan.py                      scan the courses in courses.txt (or this semester's if it's empty)
  scan.py _207591_1 ...        scan these course ids (or Learn.UQ course URLs)
  scan.py --verify             also open every video's player to check it can be downloaded
  scan.py --playlists          also open every link/embed; a link to an Echo360 playlist becomes
                               one entry per item, listed in a folder named after the link

Scanning only some courses keeps the other courses' entries in the catalog.
Writes ~/.lecture-player/catalog.json. Kinds of video found:
  recording  a lesson in the course's Echo360 "Lecture Recordings" section
  embed      an Echo360 secure link embedded in a Learn.UQ page
  link       an Echo360 secure link added as its own content item
  public     an echo360.net.au/media/<id>/public link in a page
Any other mention of Echo360 in course content is reported as "unrecognised" so that
nothing is missed silently.
"""
import argparse
import html
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

from bb import LEARN, Browser
from echo import capture

HOME = Path.home() / ".lecture-player"
CATALOG = HOME / "catalog.json"
COURSES_FILE = Path(__file__).with_name("courses.txt")

SECURE_LINK = re.compile(r"https://api\.echo360integrate\.net\.au/lti/secure-links/([0-9a-f-]{36})/access")
PUBLIC_LINK = re.compile(r"https://echo360\.net\.au/media/([0-9a-f-]{36})/public")
BBFILE = re.compile(r'data-bbfile="([^"]*)"')
# Learn.UQ's placement id for the Echo360 "Lecture Recordings" tool (the same in every course,
# seen 2026-11-04). If UQ reinstalls the tool, find the new id in the URL that opens when you
# click Lecture Recordings.
ECHO_PLACEMENT = "_1088_1"


def course_code(name):
    m = re.match(r"\[([A-Z]{4}\d{4})", name)
    return m.group(1) if m else name[:12]


def parse_course_arg(a):
    m = re.search(r"(_\d+_1)", a)
    if not m:
        sys.exit(f"Not a Learn.UQ course id or URL: {a}")
    return m.group(1)


def list_courses(b, wanted):
    """Return [{id, name, code}] for the wanted course ids, or the current semester's."""
    m = b.get_json("/learn/api/v1/users/me/memberships?expand=course&limit=200")
    out = []
    terms = {}
    for r in m["results"]:
        c = r["course"]
        term = (c.get("term") or {})
        terms[c["id"]] = term
        if wanted and c["id"] not in wanted:
            continue
        out.append({"id": c["id"], "name": c["displayName"], "code": course_code(c["displayName"]),
                    "term": term.get("name"), "termEnd": term.get("endDate")})
    if not wanted:
        latest = max((c["termEnd"] or "" for c in out if c["termEnd"] and c["name"].startswith("[")), default="")
        out = [c for c in out if c["termEnd"] == latest and c["name"].startswith("[")]
    missing = set(wanted) - {c["id"] for c in out}
    if missing:
        sys.exit(f"You aren't enrolled in: {', '.join(sorted(missing))}")
    return out


def list_contents(b, course_id):
    items = []
    url = f"/learn/api/public/v1/courses/{course_id}/contents?recursive=true&limit=200"
    while url:
        d = b.get_json(url)
        items += d["results"]
        url = (d.get("paging") or {}).get("nextPage")
    return items


def page_path(items_by_id, item):
    """Titles of the folders above an item, e.g. 'Learning Resources / Lectures'."""
    names = []
    p = item.get("parentId")
    while p in items_by_id:
        t = items_by_id[p]["title"]
        if t != "ultraDocumentBody":
            names.append(t)
        p = items_by_id[p].get("parentId")
    return " / ".join(reversed(names))


def find_in_item(course, item, where):
    """Yield (video dict, matched text) for every Echo360 reference in one content item."""
    cid = course["id"]
    handler = item.get("contentHandler") or {}
    hid = handler.get("id", "")
    title = item["title"] if item["title"] != "ultraDocumentBody" else (where.split(" / ")[-1] if where else "Page")
    base = {"course": course["code"], "courseId": cid, "contentId": item["id"], "page": title, "where": where,
            "modified": item.get("modified")}

    if hid == "resource/x-bb-bltiplacement-echoalp":
        yield {**base, "kind": "section", "launch": f"{LEARN}/webapps/blackboard/execute/blti/launchPlacement?"
               f"blti_placement_id={ECHO_PLACEMENT}&content_id={item['id']}&course_id={cid}&wrapped=true&from_ultra=true"}, "echoalp"

    url = handler.get("url") or ""
    m = SECURE_LINK.fullmatch(url)
    if hid == "resource/x-bb-blti-link" and m:
        yield {**base, "kind": "link", "key": "sl:" + m.group(1), "title": item["title"],
               "launch": f"{LEARN}/webapps/blackboard/execute/blti/launchLink?course_id={cid}"
                         f"&content_id={item['id']}&from_ultra=true"}, url

    body = item.get("body") or ""
    for raw in BBFILE.findall(body):
        try:
            f = json.loads(html.unescape(raw))
        except ValueError:
            continue
        u = f.get("url") or ""
        m = SECURE_LINK.fullmatch(u)
        if not m:
            continue
        yield {**base, "kind": "embed", "key": "sl:" + m.group(1),
               "title": f.get("title") or f.get("text") or title,
               "launch": f"{LEARN}/webapps/blackboard/execute/blti/launchLink?cim_placement_id={f.get('linkRefId')}"
                         f"&course_id={cid}&url={quote(u, safe='')}&from_ultra=true"}, u
    text = html.unescape(body)
    for m in PUBLIC_LINK.finditer(text):
        # The link text is usually the best title; fall back to the page title.
        after = text[m.end():m.end() + 400]
        t = re.search(r">([^<]{3,120})</a>", after)
        yield {**base, "kind": "public", "key": "pl:" + m.group(1), "title": (t.group(1).strip() if t else title),
               "launch": m.group(0)}, m.group(0)


def echo_mentions(item):
    """Every Echo360 URL (or placement) in an item, to check nothing was left unclassified."""
    s = html.unescape(json.dumps(item))
    found = set(re.findall(r"https?://[\w.-]*echo360[\w.-]*/[^\s\"'<>\\]*", s))
    if "echoalp" in s:
        found.add("echoalp")
    return found


def section_lessons(b, course, sec):
    """Open the course's Lecture Recordings and list the lessons that have a recording."""
    page = b.context.new_page()
    try:
        page.goto(sec["launch"], wait_until="domcontentloaded")
        frame = None
        for _ in range(60):
            time.sleep(0.5)
            frame = next((f for f in page.frames if "echo360.net.au/section/" in f.url), None)
            if frame:
                break
        if not frame:
            raise RuntimeError(f"{course['code']}: Lecture Recordings didn't open an Echo360 section")
        section_id = frame.url.split("/section/")[1].split("/")[0]
        for _ in range(20):
            res = frame.evaluate("""async s => { const r = await fetch('/section/' + s + '/syllabus',
                {headers: {Accept: 'application/json'}, credentials: 'same-origin'});
                return [r.status, await r.text()]; }""", section_id)
            if res[0] == 200:
                break
            time.sleep(1)
        data = json.loads(res[1])["data"]
    finally:
        page.close()

    out = []

    def walk(entries):
        for e in entries:
            if "lessons" in e:  # a folder of lessons
                walk(e["lessons"])
                continue
            les = e.get("lesson") or {}
            info = les.get("lesson") or {}
            medias = [m for m in les.get("medias", []) if m.get("isAvailable") and m.get("mediaType") in ("Video", "Audio")]
            # Some lessons are flagged isFuture although their video is already up (seen in
            # ANAT1012), so only skip a lesson when nothing in it is available.
            if not info or les.get("isLive") or not medias:
                continue
            start = (info.get("timing") or {}).get("start", "")
            for n, media in enumerate(medias):
                out.append({"course": course["code"], "courseId": course["id"], "kind": "recording",
                            "key": "m:" + media["id"], "mediaId": media["id"], "sectionId": section_id,
                            "lessonId": info["id"], "date": start[:10], "start": start,
                            "title": info.get("displayName") or media.get("title") or "Recording",
                            "page": "Lecture Recordings", "where": "",
                            "launch": f"https://echo360.net.au/lesson/{quote(info['id'])}/classroom"
                                      + (f"#media={media['id']}" if n else "")})
    walk(data)
    return out


def scan(b, courses, log=print):
    videos, problems = [], []
    for c in courses:
        log(f"{c['code']}: reading course content…")
        items = list_contents(b, c["id"])
        by_id = {it["id"]: it for it in items}
        found = []
        for it in items:
            where = page_path(by_id, it)
            matched = set()
            for v, text in find_in_item(c, it, where):
                matched.add(text)
                found.append(v)
            for u in echo_mentions(it) - matched:
                problems.append({"course": c["code"], "contentId": it["id"], "title": it["title"], "where": where, "url": u})
        sections = [v for v in found if v["kind"] == "section"]
        found = [v for v in found if v["kind"] != "section"]
        for sec in sections:
            log(f"{c['code']}: reading Lecture Recordings…")
            found += section_lessons(b, c, sec)
        counts = {}
        for v in found:
            counts[v["kind"]] = counts.get(v["kind"], 0) + 1
        log(f"{c['code']}: {len(found)} videos " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())))
        videos += found
    # The same video can be embedded on several pages: keep the first, note the others.
    seen = {}
    unique = []
    for v in videos:
        if v["key"] in seen:
            seen[v["key"]].setdefault("alsoOn", []).append(v["page"])
            continue
        seen[v["key"]] = v
        unique.append(v)
    return unique, problems


def open_link(b, v, timeout=60):
    """Open a link/embed's launch URL and return (page, Echo360 frame) once the player or
    playlist page has loaded. The caller closes the page."""
    page = b.context.new_page()
    try:
        page.goto(v["launch"], wait_until="domcontentloaded", timeout=timeout * 1000)
    except Exception as e:
        if "ERR_ABORTED" not in str(e):
            page.close()
            raise
    deadline = time.time() + timeout
    while time.time() < deadline:
        f = next((f for f in page.frames if re.search(r"echo360\.net\.au/ui/(player|playlist)/", f.url)), None)
        if f:
            return page, f
        time.sleep(0.5)
    urls = [f.url[:80] for f in page.frames]
    page.close()
    raise RuntimeError(f"no Echo360 player opened (frames: {urls})")


def playlist_media(b, v, attempts=3):
    """If a link/embed opens an Echo360 playlist, return (playlist, [media]); else None.
    A playlist page is echo360.net.au/ui/playlist/<id>; its items come from
    /playlist/media/getAllMedia/<id> (in order, with names and durations)."""
    for n in range(attempts):
        try:
            page, f = open_link(b, v)
            break
        except Exception:
            if n == attempts - 1:
                raise
            time.sleep(3)
    try:
        if "/ui/playlist/" not in f.url:
            return None
        pid = f.url.split("/ui/playlist/")[1].split("?")[0]
        res = f.evaluate("""async u => { const r = await fetch(u, {credentials: 'include', headers: {Accept: 'application/json'}});
            return [r.status, await r.text()]; }""", f"/playlist/media/getAllMedia/{pid}")
        if res[0] != 200:
            raise RuntimeError(f"playlist {pid}: HTTP {res[0]}")
        d = json.loads(res[1])["data"]
        by_id = {m["id"]: m for m in d["media"]}
        items = [by_id[m["mediaId"]] for m in sorted(d["playlist"]["playlistMedia"], key=lambda m: m["mediaOrder"])
                 if m["mediaId"] in by_id and m.get("mediaType") in ("Video", "Audio")]
        return d["playlist"], items
    finally:
        page.close()


def expand_playlists(b, videos, old, log=print):
    """Replace every link/embed that opens an Echo360 playlist with one entry per playlist item.
    The item that was downloaded before (old entry's mediaId, else the first) keeps the link's
    key, so its upload and watch progress stay; the others get key '<link key>:<media id>'.
    Results are kept in the catalog (playlistChecked), so a rescan only opens new links."""
    out = []
    todo = [v for v in videos if v["kind"] in ("link", "embed")]
    n = 0
    for v in videos:
        if v["kind"] not in ("link", "embed"):
            out.append(v)
            continue
        n += 1
        prev = old.get(v["key"], {})
        if prev.get("playlistChecked") and not prev.get("playlistId"):
            v["playlistChecked"] = prev["playlistChecked"]
            out.append(v)
            continue
        try:
            found = playlist_media(b, v)
        except Exception as e:
            log(f"{n}/{len(todo)}: FAIL {v['course']} {v['title'][:60]}: {str(e)[:150]}")
            out.append(v)
            continue
        v["playlistChecked"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        if not found:
            log(f"{n}/{len(todo)}: video     {v['course']} {v['title'][:60]}")
            out.append(v)
            continue
        pl, items = found
        log(f"{n}/{len(todo)}: playlist  {v['course']} {v['title'][:60]}: {len(items)} items")
        keep = prev.get("mediaId") if prev.get("mediaId") in {m["id"] for m in items} else (items[0]["id"] if items else None)
        for i, m in enumerate(items):
            dur = re.match(r"PT([\d.]+)S", (m.get("media", {}).get("current", {}) or {}).get("duration") or "")
            out.append({**v, "key": v["key"] if m["id"] == keep else f"{v['key']}:{m['id']}",
                        "title": m.get("name") or f"Part {i + 1}", "page": v["title"],
                        "where": f"{v['where']} / {v['title']}" if v["where"] else v["title"],
                        "playlistId": pl["playlistId"], "playlistTitle": pl.get("title") or v["title"],
                        "playlistIndex": i, "playlistMedia": m["id"], "mediaId": m["id"],
                        "echoTitle": m.get("name"), **({"duration": float(dur.group(1))} if dur else {})})
    return out


def verify(b, videos, log=print):
    """Open every video's player and record its Echo360 media id, size and duration."""
    for i, v in enumerate(videos, 1):
        try:
            cap = capture(b.context, v["launch"], media=v.get("playlistMedia"))
            src = cap.sources()
            names = [src["audio"], *src["video"]]
            v["mediaId"] = cap.base.split("/")[-2]
            v["sources"] = len(src["video"])
            v["bytes"] = sum(cap.size(n) for n in names if n)
            if cap.duration:
                v["duration"] = cap.duration
            v["verified"] = True
            log(f"{i}/{len(videos)}: ok   {v['course']} {v['kind']:9} {v['bytes'] / 1e6:6.0f} MB  {v['title'][:60]}")
        except Exception as e:
            v["verified"] = False
            v["error"] = str(e)[:300]
            log(f"{i}/{len(videos)}: FAIL {v['course']} {v['kind']:9} {v['title'][:60]}: {e}")
    # Different secure links can point at the same Echo360 media.
    by_media = {}
    for v in videos:
        if v.get("mediaId"):
            by_media.setdefault(v["mediaId"], []).append(v)
    for vs in by_media.values():
        for dup in vs[1:]:
            dup["duplicateOf"] = vs[0]["key"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("courses", nargs="*", help="Learn.UQ course ids or URLs")
    ap.add_argument("--verify", action="store_true", help="open every player to check it can be downloaded")
    ap.add_argument("--recheck", action="store_true", help="verify again only the catalog entries that failed")
    ap.add_argument("--playlists", action="store_true",
                    help="open every link/embed to find Echo360 playlists and list each item (≈3 s per new link)")
    args = ap.parse_args()
    if args.recheck:
        cat = json.loads(CATALOG.read_text())
        bad = [v for v in cat["videos"] if v.get("verified") is False]
        b = Browser()
        try:
            verify(b, bad, log=lambda s: print(s, flush=True))
        finally:
            b.close()
        CATALOG.write_text(json.dumps(cat, indent=1))
        ok = sum(1 for v in cat["videos"] if v.get("verified"))
        print(f"Verified {ok}/{len(cat['videos'])}")
        return
    wanted = [parse_course_arg(a) for a in args.courses]
    if not wanted and COURSES_FILE.exists():
        wanted = [parse_course_arg(l.strip()) for l in COURSES_FILE.read_text().splitlines()
                  if l.strip() and not l.strip().startswith("#")]
    b = Browser()
    old_cat = json.loads(CATALOG.read_text()) if CATALOG.exists() else {}
    old = {v["key"]: v for v in old_cat.get("videos", [])}
    try:
        courses = list_courses(b, wanted)
        print("Courses:", ", ".join(f"{c['code']} ({c['id']})" for c in courses), flush=True)
        videos, problems = scan(b, courses, log=lambda s: print(s, flush=True))
        if args.playlists:
            print("Looking for playlists…", flush=True)
            videos = expand_playlists(b, videos, old, log=lambda s: print(s, flush=True))
        if args.verify:
            verify(b, videos, log=lambda s: print(s, flush=True))
    finally:
        b.close()
    for v in videos:  # keep download/upload state from earlier runs
        for k in ("file", "uploaded", "videoId", "mediaId", "echoTitle", "sameAs", "bytes", "sources"):
            if k in old.get(v["key"], {}) and k not in v:
                v[k] = old[v["key"]][k]
    # Scanning some courses keeps the other courses' entries (in front, as before).
    scanned = {c["code"] for c in courses}
    videos = [v for v in old_cat.get("videos", []) if v["course"] not in scanned] + videos
    problems = [p for p in old_cat.get("unrecognised", []) if p["course"] not in scanned] + problems
    courses = [c for c in old_cat.get("courses", []) if c["code"] not in scanned] + courses
    HOME.mkdir(exist_ok=True)
    CATALOG.write_text(json.dumps({"scanned": time.strftime("%Y-%m-%dT%H:%M:%S"), "courses": courses,
                                   "videos": videos, "unrecognised": problems}, indent=1))
    print(f"\n{len(videos)} videos written to {CATALOG}")
    if problems:
        print(f"{len(problems)} Echo360 references weren't recognised:")
        for p in problems:
            print(f"  {p['course']} {p['where']} / {p['title']}: {p['url'][:120]}")
    if args.verify:
        bad = [v for v in videos if not v.get("verified")]
        print(f"Verified {len(videos) - len(bad)}/{len(videos)}" + (f"; {len(bad)} failed" if bad else ""))


if __name__ == "__main__":
    main()
