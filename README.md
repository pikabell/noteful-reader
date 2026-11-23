# Noteful Reader (read-only, Linux)

A minimal local web UI for reading `.noteful` notebooks exported from an iPad.
It reads the backup **without ever modifying it**.

## Run

```bash
cd ~/Desktop/Noteful_reader
chmod +x run.sh
./run.sh                 # browser opens at http://127.0.0.1:8090 automatically
```

Options: `./run.sh --port 9000`, `./run.sh --host 0.0.0.0`, `./run.sh --no-browser`.

If your backup folder is renamed or moved, set `NOTEFUL_BACKUP` before running:

```bash
NOTEFUL_BACKUP="/path/to/Noteful Backup" ./run.sh
```

## What you get

- **Library** page listing all notebooks (folder, page count, cover thumbnail) with a filter box.
- **Reader** page with previous/next page, jump-to-page, zoom/fit, and arrow-key navigation.
  Switch between **1 page** and **2 pages** (side-by-side spread) with the button in the
  toolbar or the `2` key. Append `?spread=1` to a note URL to open directly in two-page mode.
- Each page is rendered as an SVG showing the **embedded PDF page** (your imported
  textbook / lecture notes) with **handwritten ink, shapes, images and text** layered on top.

## How it works

The `.noteful` format is an undocumented big-endian container. This reader uses a
strict parser of its typed-field grammar (adapted from the independent
`noteful-re` reverse-engineering research) to locate:

- the note title and page list,
- embedded PDF backgrounds and their page indices,
- handwriting stroke blobs, shapes, images, text boxes and layers.

Pages are rendered **on demand**, not up front (the backup contains ~8,600 pages).
Rasterized PDF pages are cached under `./cache/`; the original backup is opened
read-only. Nothing is written back to your notes.

## Requirements

Python 3.10+, Flask, PyMuPDF:

```bash
python3 -m pip install flask pymupdf
```

(They are already available on this machine.)

## Attribution

The binary parser and ink/text decoding are adapted from the MIT-licensed
research implementation in [`Emefedez/noteful-re`](https://github.com/Emefedez/noteful-re)
(`research/python/`), itself an independent reverse-engineering of the Noteful
format. Noteful is a trademark of its respective owner; this project is not
affiliated with or endorsed by Noteful.
