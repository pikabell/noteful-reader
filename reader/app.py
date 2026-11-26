#!/usr/bin/env python3
"""A minimal, read-only web reader for Noteful iPad backups.

Nothing in the backup is ever modified. Page SVGs and rasterized PDF pages are
produced on demand and cached under ./cache only.

Run:  python3 reader/app.py            (then open http://127.0.0.1:8090)
"""
from __future__ import annotations

import hashlib
import html
import io
import mmap
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path

try:  # PyMuPDF >= 1.24 exposes the canonical `pymupdf` name
    import pymupdf as fitz
except ImportError:  # older releases only provide `fitz`
    import fitz
from flask import Flask, Response, abort, render_template, request, send_file

import format as nf
from render import render_page

ROOT = Path(__file__).resolve().parent.parent
BACKUP = Path(os.environ.get("NOTEFUL_BACKUP",
                             ROOT / "Noteful Backup - 1HWv45ymtAqmA9ZymPGp8uliPhRZSBk0j"))
CACHE = ROOT / "cache"
PDF_CACHE = CACHE / "pdf"
THUMB_CACHE = CACHE / "thumbs"
PDF_CACHE.mkdir(parents=True, exist_ok=True)
THUMB_CACHE.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 1

# ---------------------------------------------------------------------------
# Catalog: cheap index + metadata scan of every .noteful file at startup.
# ---------------------------------------------------------------------------

def note_id(relpath: str) -> str:
    return hashlib.sha1(relpath.encode("utf-8")).hexdigest()[:16]


class Catalog:
    def __init__(self, root: Path):
        self.root = root
        self.notes = OrderedDict()
        self.paths = {}
        self.error = None
        self.scan()

    def scan(self):
        if not self.root.is_dir():
            self.error = ("Backup folder not found: %s. Set NOTEFUL_BACKUP to the "
                          "folder containing your .noteful files, then restart."
                          % self.root)
            return
        files = sorted(self.root.rglob("*.noteful"))
        for path in files:
            rel = str(path.relative_to(self.root))
            nid = note_id(rel)
            try:
                with path.open("rb") as fh:
                    mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
                    try:
                        report = nf.parse_lite(mm)
                        summary = nf.semantic_summary(report)
                        title = summary.get("title") or path.stem
                        folder = path.parent.name if path.parent != self.root else ""
                        jpeg = next((b for b in report["blocks"] if b["kind"] == "jpeg"), None)
                        self.notes[nid] = {
                            "id": nid, "title": str(title), "folder": folder,
                            "filename": path.name, "path": path, "rel": rel,
                            "size": path.stat().st_size,
                            "pages": len(summary["pages"]),
                            "cover": (jpeg["offset"], jpeg["size"]) if jpeg else None,
                        }
                    finally:
                        mm.close()
            except Exception as exc:
                self.notes[nid] = {
                    "id": nid, "title": path.stem, "folder": path.parent.name,
                    "filename": path.name, "path": path, "rel": rel,
                    "size": path.stat().st_size, "pages": 0, "cover": None,
                    "error": str(exc),
                }
            self.paths[nid] = path

    def get(self, nid):
        return self.notes.get(nid)


CATALOG = Catalog(BACKUP)

# ---------------------------------------------------------------------------
# Lazy note loading + PDF rasterization, with small in-memory LRU caches.
# ---------------------------------------------------------------------------

_load_lock = threading.Lock()
_pdf_lock = threading.Lock()
_notes_lru = OrderedDict()   # nid -> (report, summary, mmap)
_pdfs_lru = OrderedDict()    # (nid, offset) -> fitz.Document
MAX_NOTES = 3
MAX_PDFS = 4
PDF_SCALE = 11.0 / 6.0      # internal Noteful units per PDF point


def load_note(nid):
    with _load_lock:
        if nid in _notes_lru:
            _notes_lru.move_to_end(nid)
            return _notes_lru[nid]
        info = CATALOG.get(nid)
        if not info:
            abort(404)
        fh = info["path"].open("rb")
        mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        fh.close()
        try:
            report = nf.parse_lite(mm)
            summary = nf.semantic_summary(report)
        except Exception:
            mm.close()
            raise
        entry = (report, summary, mm)
        _notes_lru[nid] = entry
        # Evict from the cache only. Dropping our reference lets Python close the
        # mmap once any in-flight request using it is finished; closing it here
        # could invalidate another thread's view mid-render.
        while len(_notes_lru) > MAX_NOTES:
            _notes_lru.popitem(last=False)
        return entry


def _pdf_key(nid, block, page_index):
    raw = "%s|%d|%d|%s" % (nid, block["offset"], page_index, PDF_SCALE)
    return hashlib.sha1(raw.encode("ascii")).hexdigest()


def _open_pdf(nid, block):
    key = (nid, block["offset"])
    with _pdf_lock:
        if key in _pdfs_lru:
            _pdfs_lru.move_to_end(key)
            return _pdfs_lru[key]
        with open(CATALOG.get(nid)["path"], "rb") as fh:
            fh.seek(block["offset"])
            raw = fh.read(block["size"])
        doc = fitz.open(stream=raw, filetype="pdf")
        _pdfs_lru[key] = doc
        # Same reasoning as note eviction: drop the cache reference and let
        # Python reclaim it once no request is still reading the document.
        while len(_pdfs_lru) > MAX_PDFS:
            _pdfs_lru.popitem(last=False)
        return doc


def pdf_image(nid):
    """Return a callable(block, page_index) -> (png_bytes, width, height)."""
    def render(block, page_index):
        page_index = int(page_index or 0)
        key = _pdf_key(nid, block, page_index)
        target = PDF_CACHE / (key + ".png")
        if target.exists():
            data = target.read_bytes()
        else:
            doc = _open_pdf(nid, block)
            if page_index < 0 or page_index >= doc.page_count:
                raise ValueError("PDF page %d out of range (0..%d)"
                                 % (page_index, doc.page_count - 1))
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=fitz.Matrix(PDF_SCALE, PDF_SCALE), alpha=False)
            data = pix.tobytes("png")
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
        # Dimensions in Noteful internal units are pixel count at PDF_SCALE.
        import struct
        w, h = struct.unpack(">II", data[16:24])
        return data, w, h
    return render


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    q = request.args.get("q", "").strip().lower()
    notes = list(CATALOG.notes.values())
    if q:
        notes = [n for n in notes
                 if q in n["title"].lower() or q in n["filename"].lower()
                 or q in n.get("folder", "").lower()]
    notes.sort(key=lambda n: (n["folder"], n["title"].lower()))
    return render_template("home.html", notes=notes, query=q,
                           catalog_error=CATALOG.error,
                           total_pages=sum(n["pages"] for n in CATALOG.notes.values()),
                           total_size=sum(n["size"] for n in CATALOG.notes.values()))


@app.route("/note/<nid>")
def note(nid):
    info = CATALOG.get(nid)
    if not info:
        abort(404)
    return render_template("reader.html", note=info,
                           total_pages=sum(n["pages"] for n in CATALOG.notes.values()))


@app.route("/page/<nid>/<int:p>.svg")
def page_svg(nid, p):
    info = CATALOG.get(nid)
    if not info:
        abort(404)
    report, summary, mm = load_note(nid)
    if p < 0 or p >= len(summary["pages"]):
        abort(404)
    svg, stats = render_page(report, summary, mm, p, pdf_image(nid))
    return Response(svg, mimetype="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.route("/thumb/<nid>/<int:p>.png")
def thumbnail(nid, p):
    """Small raster preview of one page for the overview grid.

    The full page SVG is composed as usual and rasterized with MuPDF, so ink
    and images appear in the thumbnail. Results are cached on disk.
    """
    info = CATALOG.get(nid)
    if not info:
        abort(404)
    report, summary, mm = load_note(nid)
    if p < 0 or p >= len(summary["pages"]):
        abort(404)
    key = hashlib.sha1(("%s|%d|v2" % (nid, p)).encode("ascii")).hexdigest()
    target = THUMB_CACHE / (key + ".png")
    if not target.exists():
        svg, _ = render_page(report, summary, mm, p, pdf_image(nid))
        w = summary["pages"][p]["size"][0]
        doc = fitz.open(stream=svg.encode("utf-8"), filetype="svg")
        try:
            pix = doc[0].get_pixmap(matrix=fitz.Matrix(170.0 / w, 170.0 / w), alpha=False)
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(pix.tobytes("png"))
            tmp.replace(target)
        finally:
            doc.close()
    return send_file(target, mimetype="image/png", conditional=True, max_age=86400)


@app.route("/cover/<nid>.jpg")
def cover(nid):
    info = CATALOG.get(nid)
    if not info or not info.get("cover"):
        abort(404)
    offset, size = info["cover"]
    with open(info["path"], "rb") as fh:
        fh.seek(offset)
        raw = fh.read(size)
    return send_file(io.BytesIO(raw), mimetype="image/jpeg",
                     conditional=True, max_age=86400)


@app.route("/health")
def health():
    return {"ok": CATALOG.error is None, "error": CATALOG.error,
            "notes": len(CATALOG.notes),
            "pages": sum(n["pages"] for n in CATALOG.notes.values())}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window automatically")
    args = parser.parse_args()
    url = "http://%s:%d/" % (args.host, args.port)
    print("Noteful reader -> %d notes, %d pages" %
          (len(CATALOG.notes), sum(n["pages"] for n in CATALOG.notes.values())))
    if CATALOG.error:
        print("WARNING: " + CATALOG.error)
    print("Open " + url)
    if not args.no_browser:
        import threading
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
