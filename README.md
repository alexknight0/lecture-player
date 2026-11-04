# Lectures

Watch Echo360 lecture recordings from Learn.UQ with progress sync: https://alexknight0.github.io/lecture-player/

Only Alex can sign in. The videos live in Firestore (project `lecture-player-d77815`), not in this repo.

## Adding videos (on the Mac)

```sh
cd tools
./browser.sh                 # opens a separate Chrome window; log in to Learn.UQ there once
python3 scan.py              # finds every Echo360 video in this semester's courses -> ~/.lecture-player/catalog.json
python3 get.py --list        # numbered list
python3 get.py 3 7           # download, process and upload entries 3 and 7
python3 get.py --delete 3    # remove one from the site (the free database holds 1 GiB)
```

Use the Python in `~/projects/ai-tool-venv` (needs playwright and requests) and ffmpeg.
`courses.txt` can list specific Learn.UQ course ids or URLs to scan instead of the current semester.
