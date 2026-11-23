"""Compose a single Noteful page as a read-only SVG.

Ink / shapes / images / text are decoded from the .noteful archive using the
same grammar as the reference implementation (``format.py``, ``rich_text.py``).
On top of that, unlike the research preview, the actual embedded PDF page is
rendered as the paper background so imported documents are readable.

The PDF rasterizer is injected by the caller (see ``app.py``) so that rendered
pages can be cached on disk instead of being regenerated for every request.
"""
from __future__ import annotations

import base64
import html
import math

from format import FormatError, values, decode_eraser_mask, visible_runs
from rich_text import decode_rich_text, text_svg

HIGHLIGHTER_OPACITY = 0.5  # /ca and /CA in Noteful's own PDF exports
TAPE_OPEN = 0.18


def num(v):
    return "%.5f" % v


def color(rgba):
    return "rgb(" + ",".join(str(round(max(0, min(1, v)) * 255)) for v in rgba[:3]) + ")"


def composite(element, opacity=1.0, tool=0):
    if tool not in (0, 1, 2):
        raise FormatError("Unsupported drawing tool %s" % tool)
    if not math.isfinite(opacity) or not 0 <= opacity <= 1:
        raise FormatError("Invalid object opacity")
    opacity *= HIGHLIGHTER_OPACITY if tool == 1 else 1
    mode = ' style="mix-blend-mode:multiply"' if tool == 1 else ""
    return '<g opacity="%s"%s>%s</g>' % (num(opacity), mode, element)


def tape_group(element, ident, revealed):
    return ('<g data-tape="%s" data-revealed="%d" opacity="%s">%s</g>'
            % (html.escape(str(ident)), 1 if revealed else 0,
               num(TAPE_OPEN if revealed else 1.0), element))


def tape_with_pattern(element):
    return element + '<g class="nc-tape-pattern">%s</g>' % element


def path_geometry(coords, commands):
    arities = {0: ("M", 2), 1: ("L", 2), 3: ("C", 6), 4: ("Z", 0)}
    cursor, result = 0, []
    for command in commands:
        if command not in arities:
            raise FormatError("Unsupported shape path command %s" % command)
        letter, count = arities[command]
        if cursor + count > len(coords):
            raise FormatError("Truncated shape coordinates")
        result.append(letter + " " + " ".join(num(v) for v in coords[cursor:cursor + count]))
        cursor += count
    if cursor != len(coords):
        raise FormatError("Unconsumed shape coordinates")
    return " ".join(result)


def variable_ink(points, radii, rgba):
    parts = []
    for (x, y), r in zip(points, radii):
        parts.append('<circle cx="%s" cy="%s" r="%s"/>' % (num(x), num(y), num(r)))
    for (x0, y0), (x1, y1), r0, r1 in zip(points, points[1:], radii, radii[1:]):
        dx, dy = x1 - x0, y1 - y0
        distance = math.hypot(dx, dy)
        if distance <= abs(r1 - r0) or distance < 1e-9:
            continue
        ux, uy = dx / distance, dy / distance
        k = (r0 - r1) / distance
        q = math.sqrt(1 - k * k)
        ax, ay = k * ux - q * uy, k * uy + q * ux
        bx, by = k * ux + q * uy, k * uy - q * ux
        quad = [(x0 + r0 * ax, y0 + r0 * ay), (x1 + r1 * ax, y1 + r1 * ay),
                (x1 + r1 * bx, y1 + r1 * by), (x0 + r0 * bx, y0 + r0 * by)]
        parts.append('<polygon points="%s"/>' %
                     " ".join("%s,%s" % (num(x), num(y)) for x, y in quad))
    return '<g fill="%s">%s</g>' % (color(rgba), "".join(parts))


def shape_element(obj, payload):
    sw, sh = obj["size"]
    _, _, ow, oh, _ = obj["transform_raw"]
    st = values(payload.get(7, []))
    stroke = values(st.get(7, [])).get(0, [0, 0, 0, 1])
    width = st.get(2, 0)
    fill_data = values(payload.get(5, []))
    fill = values(fill_data.get(1, [])).get(0)
    attrs = ('stroke="%s" stroke-opacity="%s" stroke-width="%s" stroke-linecap="round" '
             'stroke-linejoin="round"' % (color(stroke), num(stroke[3]), num(width)))
    attrs += ' fill="%s" fill-opacity="%s"' % (color(fill), num(fill[3])) if fill else ' fill="none"'
    if 13 in payload:
        geometry = values(payload[13])
        path = path_geometry(geometry.get(1, []), geometry.get(2, []))
        element = '<path d="%s" %s/>' % (path, attrs)
    elif obj["type_raw"] == 6:
        element = '<ellipse cx="%s" cy="%s" rx="%s" ry="%s" %s/>' % (
            num(sw / 2), num(sh / 2), num(sw / 2), num(sh / 2), attrs)
    elif obj["type_raw"] == 3:
        radius = payload.get(20, 0)
        element = '<rect width="%s" height="%s" rx="%s" %s/>' % (
            num(sw), num(sh), num(radius), attrs)
    else:
        return None
    sx = ow / sw if abs(sw) > 1e-9 else 1
    sy = oh / sh if abs(sh) > 1e-9 else 1
    return '<g transform="scale(%s %s)">%s</g>' % (num(sx), num(sy), element)


def image_crop(payload, width, height, source_width, source_height):
    outline = payload.get(12)
    if not isinstance(outline, dict):
        return None
    coords, commands = outline.get(1, []), outline.get(2, [])
    if len(coords) < 4 or not commands:
        return None
    points = list(zip(coords[0::2], coords[1::2]))
    if any(not all(math.isfinite(v) for v in point) for point in points):
        return None
    x0, x1 = min(x for x, _ in points), max(x for x, _ in points)
    y0, y1 = min(y for _, y in points), max(y for _, y in points)
    if x1 - x0 < 1e-9 or y1 - y0 < 1e-9:
        return None
    sx, sy = width / (x1 - x0), height / (y1 - y0)
    scaled = []
    for x, y in points:
        scaled.extend(((x - x0) * sx, (y - y0) * sy))
    return {"left": -x0 * sx, "top": -y0 * sy,
            "width": source_width * sx, "height": source_height * sy,
            "outline": path_geometry(scaled, commands)}


def run_svg(points, radii, radius, rgba):
    if not radii:
        if len(points) == 1:
            return ('<circle cx="%s" cy="%s" r="%s" fill="%s" opacity="%s"/>'
                    % (num(points[0][0]), num(points[0][1]), num(radius),
                       color(rgba), num(rgba[3])))
        attrs = ('fill="none" stroke="%s" stroke-width="%s" '
                 'stroke-linecap="round" stroke-linejoin="round"'
                 % (color(rgba), num(radius * 2)))
        return ('<polyline points="%s" %s opacity="%s"/>'
                % (" ".join(",".join(num(v) for v in xy) for xy in points),
                   attrs, num(rgba[3])))
    return variable_ink(points, radii, rgba)


def stroke_svg(stroke, index):
    points = stroke["candidate_points"]
    radii = stroke.get("radii") or []
    auxiliary = bytes.fromhex(stroke.get("auxiliary_hex", ""))
    mask = decode_eraser_mask(stroke["flags"], stroke.get("point_count", len(points)), auxiliary)
    rgba = stroke["style"]["rgba"]
    element = "".join(
        run_svg(part, part_radii, stroke["thickness_candidate"], rgba)
        for part, part_radii in visible_runs(points, radii, mask))
    element = composite(element, rgba[3], stroke["style"]["tool_raw"])
    if stroke["style"]["tool_raw"] == 2:
        element = tape_group(tape_with_pattern(element), "stroke:%d" % index,
                             bool(stroke["flags"] & 4))
    return element


def background_svg(page, blocks, data, pdf_image, warnings):
    """Return the paper + imported-PDF layers for a page."""
    w, h = page["size"]
    paper = page.get("paper") or {}
    parts = ['<rect width="100%%" height="100%%" fill="#%06x"/>' %
             int(paper.get("pc", 16777215))]
    if paper.get("lt") in (1, 2):
        gap = paper.get("lh", 24) * 11 / 6
        linew = paper.get("lw", 0.5) * 11 / 6
        path = "M 0 %s L %s %s" % (num(gap), num(gap), num(gap))
        if paper["lt"] == 2:
            path += " M %s 0 L %s %s" % (num(gap), num(gap), num(gap))
        parts.append(
            '<defs><pattern id="paper" width="%s" height="%s" patternUnits="userSpaceOnUse">'
            '<path d="%s" fill="none" stroke="#9a9888" stroke-width="%s"/></pattern></defs>'
            '<rect width="100%%" height="100%%" fill="url(#paper)"/>'
            % (num(gap), num(gap), path, num(linew)))

    pdf_id = page.get("background_pdf_id")
    block = blocks.get(pdf_id)
    if block and pdf_image:
        try:
            png, iw, ih = pdf_image(block, page.get("background_page_raw", 0))
            if png:
                rect = page.get("pdf_rect")
                if (isinstance(rect, list) and len(rect) == 4
                        and all(isinstance(v, (int, float)) for v in rect)):
                    x, y, rw, rh = rect
                else:
                    x, y, rw, rh = 0.0, 0.0, w, h
                href = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
                parts.append('<image x="%s" y="%s" width="%s" height="%s" '
                             'preserveAspectRatio="xMidYMid meet" href="%s"/>'
                             % (num(x), num(y), num(rw), num(rh), href))
        except Exception as exc:  # keep the page readable even if one PDF fails
            warnings.append("PDF background unavailable: %s" % exc)
    elif not paper:
        warnings.append("Embedded PDF background could not be located for this page.")
    return "".join(parts)


def render_page(report, summary, data, page_index, pdf_image):
    """Render one page to an SVG string and a small stats/warnings dict."""
    page = summary["pages"][page_index]
    w, h = page["size"]
    blocks = {b["id"]: b for b in report["blocks"]}
    warnings = []
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" '
             'xmlns:xlink="http://www.w3.org/1999/xlink" '
             'viewBox="0 0 %s %s" width="%s" height="%s">' % (num(w), num(h), num(w), num(h))]
    parts.append(background_svg(page, blocks, data, pdf_image, warnings))

    editable = blocks.get(page.get("stroke_object_set_id"), {})
    strokes = editable.get("strokes", [])
    if editable.get("stroke_decode_error"):
        warnings.append(editable["stroke_decode_error"])
    objects = [o for o in summary["objects"]
               if o["stroke_object_set_id"] == page.get("stroke_object_set_id")]

    elements = []
    for index, stroke in enumerate(strokes):
        if not stroke["candidate_points"]:
            continue
        elements.append((stroke["z_order_raw"], stroke_svg(stroke, index)))

    unsupported = []
    for obj in objects:
        x, y, ow, oh, angle = obj["transform_raw"]
        sw, sh = obj["size"]
        payload = values(obj["payload_fields"])
        transform = ("translate(%s %s) rotate(%s) translate(%s %s)"
                     % (num(x), num(y), num(math.degrees(angle)), num(-ow / 2), num(-oh / 2)))
        el = None
        if obj["kind_in_samples"] == "image" and obj["asset_id"] in blocks:
            b = blocks[obj["asset_id"]]
            raw = data[b["offset"]:b["offset"] + b["size"]]
            mime = {"jpeg": "image/jpeg", "png": "image/png"}.get(b["kind"])
            if mime:
                href = "data:" + mime + ";base64," + base64.b64encode(bytes(raw)).decode("ascii")
                crop = image_crop(payload, ow, oh, sw, sh)
                if crop:
                    clip = "nc-crop-%s" % obj["id"]
                    el = ('<clipPath id="%s"><path d="%s"/></clipPath>'
                          '<image x="%s" y="%s" width="%s" height="%s" '
                          'preserveAspectRatio="none" clip-path="url(#%s)" href="%s"/>'
                          % (clip, crop["outline"], num(crop["left"]), num(crop["top"]),
                             num(crop["width"]), num(crop["height"]), clip, href))
                else:
                    el = '<image width="%s" height="%s" preserveAspectRatio="none" href="%s"/>' % (
                        num(ow), num(oh), href)
        elif obj["type_raw"] in (2, 19):
            text = decode_rich_text(values(payload.get(4, [])))
            warnings.extend(text["warnings"])
            sx = ow / sw if abs(sw) > 1e-9 else 1
            sy = oh / sh if abs(sh) > 1e-9 else 1
            pill = ('<rect width="%s" height="%s" rx="%s" fill="#e8eefb" '
                    'stroke="#9fb3df" stroke-width="0.8"/>' % (num(sw), num(sh), num(sh / 2))
                    if obj["type_raw"] == 19 else "")
            el = '<g transform="scale(%s %s)">%s%s</g>' % (num(sx), num(sy), pill, text_svg(text, sw))
        elif obj["type_raw"] in (3, 6, 12, 20, 21):
            try:
                el = shape_element(obj, payload)
            except FormatError as exc:
                warnings.append(str(exc))
            if el is not None and obj["type_raw"] == 3 and obj["tool_raw"] == 2:
                el = tape_group(tape_with_pattern(el), "object:%d" % obj.get("index", 0),
                                payload.get(15) == 1)
        if el is None:
            unsupported.append(obj["type_raw"])
        else:
            el = composite('<g transform="%s">%s</g>' % (transform, el),
                           obj["opacity"], obj["tool_raw"])
            elements.append((obj.get("z_order_raw", 0), el))
    if unsupported:
        warnings.append("%d objects without a renderer (types %s)." %
                        (len(unsupported), sorted(set(unsupported))))

    parts.extend(el for _, el in sorted(elements, key=lambda pair: pair[0]))
    parts.append("</svg>")
    return "".join(parts), {
        "stroke_count": len(strokes),
        "object_count": len(objects),
        "warnings": warnings,
    }
