"""Write videos to the site's Firestore database through the REST API, as Alex.

gcloud's access token is used, so IAM applies and the security rules (which stop browsers
writing) don't. Bytes are split into 1 MB chunk documents, as File drop does, because
Firebase Storage needs a billing account.
"""
import base64
import json
import os
import subprocess
import time
from pathlib import Path

import requests

HOME = Path.home() / ".lecture-player"
PROJECT = (HOME / "project-id").read_text().strip() if (HOME / "project-id").exists() else "lecture-player-d77815"
DOCS = f"projects/{PROJECT}/databases/(default)/documents"
API = f"https://firestore.googleapis.com/v1/{DOCS}"
CHUNK_BYTES = 1_000_000          # Firestore documents are capped at 1 MiB
COMMIT_BYTES = 8_000_000         # a commit is capped at 10 MiB
# Billing (Blaze) has been on since 2026-11-04, so the free 1 GiB is no longer a hard stop.
# This is a safety limit against uploading far more than intended (Firestore storage costs
# about US$0.18/GB a month). Raise it with LP_LIMIT_GB=<n>.
QUOTA_BYTES = int(float(os.environ.get("LP_LIMIT_GB", "20")) * 1e9)


class Store:
    def __init__(self):
        self._token = None
        self._token_at = 0

    def headers(self):
        if not self._token or time.time() - self._token_at > 1800:
            self._token = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True,
                                         text=True, check=True).stdout.strip()
            self._token_at = time.time()
        return {"Authorization": f"Bearer {self._token}", "x-goog-user-project": PROJECT,
                "Content-Type": "application/json"}

    def call(self, method, url, **kw):
        for attempt in range(5):
            r = requests.request(method, url, headers=self.headers(), timeout=120, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"{method} {url.split('/documents')[-1]}: HTTP {r.status_code}: {r.text[:300]}")
            return r.json() if r.text else {}
        raise RuntimeError(f"{method} {url}: gave up after retries")

    def commit(self, writes):
        return self.call("POST", f"{API}:commit", data=json.dumps({"writes": writes}))

    def videos(self):
        """All video docs as {id: fields (decoded)}."""
        out = {}
        token = None
        while True:
            url = f"{API}/videos?pageSize=300" + (f"&pageToken={token}" if token else "")
            d = self.call("GET", url)
            for doc in d.get("documents", []):
                out[doc["name"].rsplit("/", 1)[1]] = decode(doc["fields"])
            token = d.get("nextPageToken")
            if not token:
                return out

    def used_bytes(self):
        return sum(v.get("size", 0) for v in self.videos().values())

    def upload(self, vid, path, meta, log=print):
        """Upload a processed MP4 as videos/{vid} + chunks. The doc is written last with done=True,
        so a half-finished upload never shows up as playable."""
        data = Path(path).read_bytes()
        n = (len(data) + CHUNK_BYTES - 1) // CHUNK_BYTES
        self.commit([{"update": {"name": f"{DOCS}/videos/{vid}", "fields": encode({**meta, "size": len(data),
                     "chunks": n, "chunkBytes": CHUNK_BYTES, "done": False})}}])
        batch, size, last = [], 0, 0
        for i in range(n):
            part = data[i * CHUNK_BYTES:(i + 1) * CHUNK_BYTES]
            batch.append({"update": {"name": f"{DOCS}/videos/{vid}/chunks/{i:05d}",
                                     "fields": {"d": {"bytesValue": base64.b64encode(part).decode()}}}})
            size += len(part)
            if size >= COMMIT_BYTES or i == n - 1:
                self.commit(batch)
                batch, size = [], 0
                if time.time() - last > 5 or i == n - 1:
                    log(f"  uploaded {i + 1}/{n} MB")
                    last = time.time()
        self.commit([{"update": {"name": f"{DOCS}/videos/{vid}", "fields": encode({**meta, "size": len(data),
                     "chunks": n, "chunkBytes": CHUNK_BYTES, "done": True, "uploadedAt": int(time.time() * 1000)})}}])

    def delete(self, vid, log=print):
        doc = self.call("GET", f"{API}/videos/{vid}")
        n = int(doc["fields"]["chunks"]["integerValue"])
        names = [f"{DOCS}/videos/{vid}/chunks/{i:05d}" for i in range(n)]
        for i in range(0, len(names), 400):
            self.commit([{"delete": x} for x in names[i:i + 400]])
        self.commit([{"delete": f"{DOCS}/videos/{vid}"}])
        log(f"  deleted {vid} ({n} chunks)")


def encode_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [encode_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": encode(v)}}
    raise TypeError(type(v))


def encode(d):
    return {k: encode_value(v) for k, v in d.items()}


def decode_value(v):
    (kind, x), = v.items()
    if kind == "integerValue":
        return int(x)
    if kind == "arrayValue":
        return [decode_value(y) for y in x.get("values", [])]
    if kind == "mapValue":
        return decode(x.get("fields", {}))
    if kind == "nullValue":
        return None
    return x


def decode(fields):
    return {k: decode_value(v) for k, v in fields.items()}
