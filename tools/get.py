"""Download Echo360 videos found by scan.py, make them streamable, and upload them to the site.

Usage:
  get.py --list                     numbered list of the videos in the catalog
  get.py 3 7                        download + upload catalog entries 3 and 7
  get.py --course COSC7502 --all    every video of a course that isn't uploaded yet
  get.py 3 --no-upload              download and process only (file kept in ~/.lecture-player/videos)
  get.py --delete 3                 remove an uploaded video from the site (frees database space)

Processing: the audio and video streams are downloaded as whole files (the HLS playlists are
byte ranges of them), then muxed into one fragmented MP4 with ffmpeg. Video is copied as is.
Audio is re-encoded to 96 kbit/s AAC, which roughly halves the size of most recordings.
If a recording has two video sources, they're placed side by side (re-encoded with x264 at
constant quality, 720p each; lecture video is mostly still, so this stays small), and the site
can show both or either one.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from bb import Browser
from echo import capture
from mp4frag import layout
from scan import CATALOG, HOME
from store import QUOTA_BYTES, Store

VIDEOS = HOME / "videos"


def load():
    if not CATALOG.exists():
        sys.exit("No catalog yet. Run scan.py first.")
    return json.loads(CATALOG.read_text())


def save(cat):
    CATALOG.write_text(json.dumps(cat, indent=1))


def video_id(v):
    return re.sub(r"[^A-Za-z0-9-]", "-", v["key"])


def label(v):
    date = v.get("date") or ""
    return f"{v['course']} {v['kind']:9} {date:10} {v['title'][:70]}"


def nice_title(v):
    """Echo360's titles are often section codes or file names; make them readable.
    Recordings named only by their section code (e.g. "[ANAT1012_…]/LEC02/01") get no title,
    and the site shows "Lecture N · date" instead."""
    t = v["title"]
    if v["kind"] == "recording":
        return "" if re.search(r"(_IN\]?|/LEC\d+/\d+)$", t) or t.startswith("[") else t
    t = re.sub(r"\.(mp4|mov|m4v)$", "", t, flags=re.I)
    return t


def listing(v, order, course_names):
    """The fields the site needs to list a video, whether or not it has been uploaded."""
    return {
        "course": v["course"], "courseName": course_names.get(v["course"], ""), "kind": v["kind"],
        "title": nice_title(v), "echoTitle": v.get("echoTitle") or v["title"], "page": v.get("page") or "",
        "where": v.get("where") or "", "date": v.get("date") or (v.get("modified") or "")[:10],
        "start": v.get("start") or "", "order": order, "key": v["key"],
    }


def course_names(cat):
    return {c["code"]: re.sub(r"^\[[^\]]+\]\s*", "", c["name"]).split(" (St Lucia)")[0].split(". Semester")[0]
            for c in cat.get("courses", [])}


def ffprobe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def process(v, files, out, log=print):
    """Mux the downloaded source files into one fragmented MP4. Returns 'single' or 'dual'."""
    audio_files = [f for f in files if any(s["codec_type"] == "audio" for s in ffprobe(f)["streams"])]
    video_files = [f for f in files if any(s["codec_type"] == "video" for s in ffprobe(f)["streams"])]
    if not audio_files:
        raise RuntimeError("no audio stream in the download")
    if not video_files:
        raise RuntimeError("no video stream in the download")
    a = audio_files[0]
    frag = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"]
    if len(video_files) == 1:
        cmd = ["ffmpeg", "-y", "-v", "error", "-stats", "-i", str(video_files[0]), "-i", str(a),
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", *frag, str(out)]
        kind = "single"
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-stats", "-i", str(video_files[0]), "-i", str(video_files[1]), "-i", str(a),
               "-filter_complex", "[0:v]scale=-2:720,setsar=1,fps=25[l];[1:v]scale=-2:720,setsar=1,fps=25[r];[l][r]hstack[v]",
               "-map", "[v]", "-map", "2:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
               "-g", "250", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "96k", *frag, str(out)]
        kind = "dual"
    log(f"  muxing ({kind})…")
    subprocess.run(cmd, check=True)
    return kind


def fetch(b, v, log=print):
    """Download and process one catalog entry. Returns the processed file path."""
    vid = video_id(v)
    d = VIDEOS / vid
    d.mkdir(parents=True, exist_ok=True)
    out = d / "video.mp4"
    if out.exists() and (d / "done").exists():
        log("  already downloaded")
        return out
    log("  opening the player…")
    cap = capture(b.context, v["launch"])
    src = cap.sources()
    names = [n for n in [src["audio"], *src["video"]] if n]
    log(f"  sources: {', '.join(names)}")
    files = []
    for n in names:
        p = d / n
        cap.download(n, p, label="")
        files.append(p)
    process(v, files, out, log)
    (d / "done").write_text(time.strftime("%Y-%m-%dT%H:%M:%S"))
    if cap.title:
        v["echoTitle"] = cap.title
    return out


def meta_for(v, path, kind, base):
    lay = layout(path)
    info = ffprobe(path)
    duration = float(info["format"]["duration"])
    vs = next(s for s in info["streams"] if s["codec_type"] == "video")
    return {
        **base, "duration": round(duration, 3), "width": int(vs["width"]), "height": int(vs["height"]),
        "layout": kind, "mime": lay["mime"],
        "times": [t for t, _ in lay["index"]], "offsets": [o for _, o in lay["index"]],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("numbers", nargs="*", type=int, help="catalog numbers (see --list)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--course")
    ap.add_argument("--all", action="store_true", help="with --course: every video not uploaded yet")
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--delete", action="store_true", help="remove the given videos from the site")
    ap.add_argument("--list-all", action="store_true",
                    help="put every catalog video on the site's list (titles etc. only; not uploaded ones show as such)")
    args = ap.parse_args()
    cat = load()
    vids = cat["videos"]

    if args.list_all:
        store = Store()
        names = course_names(cat)
        todo = [(i, v) for i, v in enumerate(vids) if not v.get("duplicateOf")]
        for n, (i, v) in enumerate(todo, 1):
            store.put_meta(video_id(v), listing(v, i, names))
            if n % 25 == 0 or n == len(todo):
                print(f"{n}/{len(todo)} listed", flush=True)
        return

    if args.list:
        for i, v in enumerate(vids, 1):
            if args.course and v["course"] != args.course:
                continue
            state = "uploaded" if v.get("uploaded") else ("duplicate" if v.get("duplicateOf") else "")
            size = f"{v['bytes'] / 1e6:5.0f} MB" if v.get("bytes") else "        "
            print(f"{i:3}. {label(v)}  {size} {state}")
        return

    chosen = [vids[n - 1] for n in args.numbers]
    if args.all:
        if not args.course:
            sys.exit("--all needs --course")
        chosen += [v for v in vids if v["course"] == args.course and not v.get("uploaded") and not v.get("duplicateOf")]
    if not chosen:
        sys.exit("Nothing chosen. See --list.")

    store = Store()
    names = course_names(cat)
    if args.delete:
        for v in chosen:
            store.delete(video_id(v))
            v.pop("uploaded", None)
        save(cat)
        return

    used = None if args.no_upload else store.used_bytes()
    if used is not None:
        print(f"Database: {used / 1e6:.0f} MB of {QUOTA_BYTES / 1e6:.0f} MB used", flush=True)
    b = Browser()
    try:
        for i, v in enumerate(chosen, 1):
            print(f"{i}/{len(chosen)}: {label(v)}", flush=True)
            if v.get("duplicateOf"):
                print("  same video as another entry; skipped")
                continue
            path = fetch(b, v, log=lambda s: print(s, flush=True))
            save(cat)
            v["file"] = str(path)
            if args.no_upload:
                continue
            kind = "dual" if len([n for n in path.parent.iterdir() if re.match(r"s[1-9]q\d\.mp4", n.name)]) > 1 else "single"
            meta = meta_for(v, path, kind, listing(v, vids.index(v), names))
            size = path.stat().st_size
            if used + size > QUOTA_BYTES:
                print(f"  not uploaded: {size / 1e6:.0f} MB would go over the {QUOTA_BYTES / 1e9:.0f} GB safety limit "
                      f"({used / 1e6:.0f} MB used). Raise it with LP_LIMIT_GB=<n> or delete something with --delete.")
                continue
            print(f"  uploading {size / 1e6:.0f} MB…", flush=True)
            store.upload(video_id(v), path, meta, log=lambda s: print(s, flush=True))
            used += size
            v["uploaded"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            v["videoId"] = video_id(v)
            save(cat)
    finally:
        b.close()
        save(cat)


if __name__ == "__main__":
    main()
