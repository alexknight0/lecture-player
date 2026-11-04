"""Read the fragment layout of a fragmented MP4 (ftyp+moov, then moof+mdat pairs).

The player streams a video by appending the init segment (everything before the first moof)
and then whole fragments to a MediaSource, so it needs each fragment's start time and byte
offset, and the codec string for MediaSource.isTypeSupported / addSourceBuffer.
"""
import struct


def boxes(data, start=0, end=None):
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        header = 8
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
            header = 16
        elif size == 0:
            size = end - i
        yield kind.decode("latin-1"), i, i + header, i + size
        i += size


def find(data, path, start=0, end=None):
    """First box at a path like ['moov', 'trak'] (None if missing)."""
    for kind, s, body, e in boxes(data, start, end):
        if kind == path[0]:
            if len(path) == 1:
                return s, body, e
            r = find(data, path[1:], body, e)
            if r:
                return r
    return None


def tracks(data, moov):
    """{track_id: (timescale, handler)} from the moov box."""
    out = {}
    _, mb, me = moov
    for kind, s, body, e in boxes(data, mb, me):
        if kind != "trak":
            continue
        tkhd = find(data, ["tkhd"], body, e)
        version = data[tkhd[1]]
        tid = struct.unpack(">I", data[tkhd[1] + (20 if version == 1 else 12):][:4])[0]
        mdhd = find(data, ["mdia", "mdhd"], body, e)
        v = data[mdhd[1]]
        timescale = struct.unpack(">I", data[mdhd[1] + (20 if v == 1 else 12):][:4])[0]
        hdlr = find(data, ["mdia", "hdlr"], body, e)
        handler = data[hdlr[1] + 8:hdlr[1] + 12].decode("latin-1")
        out[tid] = (timescale, handler)
    return out


def codecs(data, moov):
    """RFC 6381 codec strings, e.g. ['avc1.640029', 'mp4a.40.2']."""
    _, mb, me = moov
    blob = data[mb:me]
    out = []
    i = blob.find(b"avcC")
    if i >= 0:
        p, c, lv = blob[i + 5], blob[i + 6], blob[i + 7]
        out.append(f"avc1.{p:02x}{c:02x}{lv:02x}")
    if b"mp4a" in blob:
        out.append("mp4a.40.2")
    return out


def layout(path):
    """Return {init: bytes before the first fragment, index: [[seconds, offset], ...], mime}."""
    with open(path, "rb") as f:
        data = f.read()
    moov = find(data, ["moov"])
    if not moov:
        raise ValueError(f"{path}: no moov box")
    tr = tracks(data, moov)
    index = []
    init = None
    for kind, s, body, e in boxes(data):
        if kind != "moof":
            continue
        if init is None:
            init = s
        t = None
        for k2, s2, b2, e2 in boxes(data, body, e):
            if k2 != "traf":
                continue
            tfhd = find(data, ["tfhd"], b2, e2)
            tid = struct.unpack(">I", data[tfhd[1] + 4:tfhd[1] + 8])[0]
            tfdt = find(data, ["tfdt"], b2, e2)
            if not tfdt:
                continue
            v = data[tfdt[1]]
            base = struct.unpack(">Q" if v == 1 else ">I", data[tfdt[1] + 4:tfdt[1] + (12 if v == 1 else 8)])[0]
            sec = base / tr[tid][0]
            t = sec if t is None else min(t, sec)
        index.append([round(t or 0, 3), s])
    if init is None:
        raise ValueError(f"{path}: not a fragmented MP4")
    return {"init": init, "index": index, "size": len(data),
            "mime": 'video/mp4; codecs="' + ", ".join(codecs(data, moov)) + '"'}
