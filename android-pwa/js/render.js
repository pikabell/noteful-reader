/* Compose a .noteful page into a read-only SVG. Ported from reader/render.py. */
(function (root) {
  'use strict';
  const NF = (typeof require !== 'undefined') ? require('./noteful.js') : root.Noteful;
  const values = NF.values, fld = NF.fld, visibleRuns = NF.visibleRuns,
        decodeEraserMask = NF.decodeEraserMask;

  const HIGHLIGHTER_OPACITY = 0.5, TAPE_OPEN = 0.18;
  const num = v => Number(v || 0).toFixed(5);
  function color(rgba) {
    return 'rgb(' + rgba.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',') + ')';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function composite(element, opacity, tool) {
    opacity = opacity === undefined ? 1 : opacity;
    tool = tool || 0;
    opacity *= tool === 1 ? HIGHLIGHTER_OPACITY : 1;
    const mode = tool === 1 ? ' style="mix-blend-mode:multiply"' : '';
    return '<g opacity="' + num(opacity) + '"' + mode + '>' + element + '</g>';
  }
  function tapeGroup(element, ident, revealed) {
    return '<g data-tape="' + esc(ident) + '" data-revealed="' + (revealed ? 1 : 0) +
      '" opacity="' + num(revealed ? TAPE_OPEN : 1) + '">' + element + '</g>';
  }
  function tapeWithPattern(el) { return el + '<g class="nc-tape-pattern">' + el + '</g>'; }

  function pathGeometry(coords, commands) {
    const arities = { 0: ['M', 2], 1: ['L', 2], 3: ['C', 6], 4: ['Z', 0] };
    let cursor = 0;
    const result = [];
    for (const cmd of commands) {
      const a = arities[cmd];
      if (!a) throw new NF.FormatError('Unsupported shape path command ' + cmd);
      if (cursor + a[1] > coords.length) throw new NF.FormatError('Truncated shape coordinates');
      result.push(a[0] + ' ' + coords.slice(cursor, cursor + a[1]).map(num).join(' '));
      cursor += a[1];
    }
    if (cursor !== coords.length) throw new NF.FormatError('Unconsumed shape coordinates');
    return result.join(' ');
  }

  function variableInk(points, radii, rgba) {
    const parts = [];
    points.forEach((p, i) => parts.push('<circle cx="' + num(p[0]) + '" cy="' + num(p[1]) + '" r="' + num(radii[i]) + '"/>'));
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i], [x1, y1] = points[i + 1];
      const r0 = radii[i], r1 = radii[i + 1];
      const dx = x1 - x0, dy = y1 - y0, distance = Math.hypot(dx, dy);
      if (distance <= Math.abs(r1 - r0) || distance < 1e-9) continue;
      const ux = dx / distance, uy = dy / distance;
      const k = (r0 - r1) / distance, q = Math.sqrt(1 - k * k);
      const ax = k * ux - q * uy, ay = k * uy + q * ux;
      const bx = k * ux + q * uy, by = k * uy - q * ux;
      const quad = [[x0 + r0 * ax, y0 + r0 * ay], [x1 + r1 * ax, y1 + r1 * ay],
                    [x1 + r1 * bx, y1 + r1 * by], [x0 + r0 * bx, y0 + r0 * by]];
      parts.push('<polygon points="' + quad.map(p => num(p[0]) + ',' + num(p[1])).join(' ') + '"/>');
    }
    return '<g fill="' + color(rgba) + '">' + parts.join('') + '</g>';
  }

  function shapeElement(obj, payload) {
    const sw = obj.size[0], sh = obj.size[1];
    const ow = obj.transform[2], oh = obj.transform[3];
    const st = values(fld(payload, 7, []));
    const stroke = fld(values(fld(st, 7, [])), 0, [0, 0, 0, 1]);
    const width = fld(st, 2, 0);
    const fill = fld(values(fld(values(fld(payload, 5, [])), 1, [])), 0, null);
    let attrs = 'stroke="' + color(stroke) + '" stroke-opacity="' + num(stroke[3]) +
      '" stroke-width="' + num(width) + '" stroke-linecap="round" stroke-linejoin="round"';
    attrs += fill ? ' fill="' + color(fill) + '" fill-opacity="' + num(fill[3]) + '"' : ' fill="none"';
    let el;
    if (payload[13] !== undefined) {
      const g = values(payload[13]);
      el = '<path d="' + pathGeometry(fld(g, 1, []), fld(g, 2, [])) + '" ' + attrs + '/>';
    } else if (obj.kind === 6) {
      el = '<ellipse cx="' + num(sw / 2) + '" cy="' + num(sh / 2) + '" rx="' + num(sw / 2) +
           '" ry="' + num(sh / 2) + '" ' + attrs + '/>';
    } else if (obj.kind === 3) {
      el = '<rect width="' + num(sw) + '" height="' + num(sh) + '" rx="' + num(fld(payload, 20, 0)) + '" ' + attrs + '/>';
    } else return null;
    const sx = Math.abs(sw) > 1e-9 ? ow / sw : 1, sy = Math.abs(sh) > 1e-9 ? oh / sh : 1;
    return '<g transform="scale(' + num(sx) + ' ' + num(sy) + ')">' + el + '</g>';
  }

  function imageCrop(payload, width, height, sw, sh) {
    const outline = payload[12];
    if (!outline || !outline.bytes) return null;
    const o = values(outline);
    const coords = fld(o, 1, []), commands = fld(o, 2, []);
    if (coords.length < 4 || !commands.length) return null;
    const pts = [];
    for (let i = 0; i < coords.length - 1; i += 2) pts.push([coords[i], coords[i + 1]]);
    if (pts.some(p => !isFinite(p[0]) || !isFinite(p[1]))) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) return null;
    const sx = width / (x1 - x0), sy = height / (y1 - y0);
    const scaled = [];
    for (const p of pts) scaled.push((p[0] - x0) * sx, (p[1] - y0) * sy);
    return { left: -x0 * sx, top: -y0 * sy, width: sw * sx, height: sh * sy,
             outline: pathGeometry(scaled, commands) };
  }

  function dataUrl(bytes, mime) {
    let bin = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }

  function runSvg(points, radii, radius, rgba) {
    if (!radii.length) {
      if (points.length === 1) {
        return '<circle cx="' + num(points[0][0]) + '" cy="' + num(points[0][1]) + '" r="' + num(radius) +
          '" fill="' + color(rgba) + '" opacity="' + num(rgba[3]) + '"/>';
      }
      return '<polyline points="' + points.map(p => num(p[0]) + ',' + num(p[1])).join(' ') +
        '" fill="none" stroke="' + color(rgba) + '" stroke-width="' + num(radius * 2) +
        '" stroke-linecap="round" stroke-linejoin="round" opacity="' + num(rgba[3]) + '"/>';
    }
    return variableInk(points, radii, rgba);
  }

  function strokeSvg(stroke, index) {
    const rgba = stroke.style.rgba;
    let el = stroke.runs.map(run => runSvg(run[0], run[1], stroke.thickness, rgba)).join('');
    el = composite(el, rgba[3], stroke.style.tool);
    if (stroke.style.tool === 2) el = tapeGroup(tapeWithPattern(el), 'stroke:' + index, !!(stroke.flags & 4));
    return el;
  }

  function decodeRichText(v) {
    const def = () => ({ text: '', size: 15, family: 'Helvetica', name: '', bold: false,
                         italic: false, underline: 0, strike: 0, rgba: [0, 0, 0, 1],
                         align: 0, lineHeight: 0, spacing: 8 });
    const runs = fld(v, 2, []).map(s => Object.assign(def(), { text: typeof s === 'string' ? s : '' }));
    const warnings = [];
    const style = def();
    const counts = fld(v, 3, []), keys = fld(v, 4, []);
    if (counts.length !== runs.length) warnings.push('Text run/count mismatch');
    else {
      let cursor = 0;
      const cursors = { 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 };
      const poolFor = { 1: 5, 2: 6, 3: 6, 4: 8, 5: 8, 6: 7, 7: 7, 8: 8, 9: 9, 10: 10, 11: 10, 12: 10, 13: 5, 14: 5 };
      for (let i = 0; i < runs.length; i++) {
        const count = counts[i];
        for (let j = 0; j < count; j++) {
          const key = keys[cursor++], pool = poolFor[key];
          if (!pool) { warnings.push('Unknown text attribute ' + key); continue; }
          const data = fld(v, pool, []);
          const item = data[cursors[pool]++];
          if (item === undefined) { warnings.push('Truncated text pool ' + pool); continue; }
          if (key === 1 || key === 13 || key === 14) style[key === 14 ? 'name' : 'family'] = item;
          else if (key === 2) style.bold = !!item;
          else if (key === 3) style.italic = !!item;
          else if (key === 4) style.underline = item;
          else if (key === 5) style.strike = item;
          else if (key === 8) style.align = item;
          else if (key === 6) { const c = fld(values(item), 0, []); if (c.length === 4) style.rgba = c; }
          else if (key === 10) style.size = item;
          else if (key === 11) style.lineHeight = item;
          else if (key === 12) style.spacing = item;
        }
        const content = runs[i].text;
        Object.assign(runs[i], JSON.parse(JSON.stringify(style)), { text: content });
      }
    }
    return { runs: runs, warnings: warnings };
  }

  function textSvg(text, width) {
    const lines = [[]];
    for (const run of text.runs) {
      const parts = String(run.text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u200b/g, '').split('\n');
      parts.forEach((part, i) => { if (i) lines.push([]); if (part) lines[lines.length - 1].push([run, part]); });
    }
    const out = [];
    let y = 8;
    for (const line of lines) {
      const size = Math.max.apply(null, [15].concat(line.map(p => p[0].size)));
      y += size;
      const align = line.length ? line[0][0].align : 0;
      const x = align === 1 ? width / 2 : align === 2 ? width - 5 : 5;
      const anchor = align === 1 ? 'middle' : align === 2 ? 'end' : 'start';
      out.push('<text x="' + num(x) + '" y="' + num(y) + '" text-anchor="' + anchor + '" xml:space="preserve">');
      for (const [run, content] of line) {
        const deco = [(run.underline > 0 ? 'underline' : ''), (run.strike > 0 ? 'line-through' : '')].filter(Boolean).join(' ') || 'none';
        const lower = String(run.family).toLowerCase();
        const generic = /courier|mono/.test(lower) ? "'Courier New', monospace"
          : /times|georgia|serif/.test(lower) ? "'Times New Roman', serif"
          : /noteworthy|marker|chalk/.test(lower) ? "'Comic Neue', cursive" : 'Arial, sans-serif';
        const fonts = "'" + run.family.replace(/'/g, "\\'") + "', '" + run.name.replace(/'/g, "\\'") + "', " + generic;
        out.push('<tspan font-family="' + esc(fonts) + '" font-size="' + num(run.size) +
          '" font-weight="' + (run.bold ? 700 : 400) + '" font-style="' + (run.italic ? 'italic' : 'normal') +
          '" text-decoration="' + deco + '" fill="' + color(run.rgba) + '" fill-opacity="' + num(run.rgba[3]) +
          '">' + esc(content) + '</tspan>');
      }
      out.push('</text>');
      y += Math.max.apply(null, [8].concat(line.map(([r]) => r.lineHeight > 0 ? Math.max(r.lineHeight - size, 0) : size * 0.2 + r.spacing)));
    }
    return out.join('');
  }

  async function renderPage(report, summary, data, pageIndex, pdfImage) {
    const page = summary.pages[pageIndex];
    if (!page) throw new Error('Page out of range');
    const w = page.size[0], h = page.size[1];
    const warnings = [];
    const blocks = {};
    for (const b of report.blocks) blocks[b.id] = b;
    const parts = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' +
      num(w) + ' ' + num(h) + '" width="' + num(w) + '" height="' + num(h) + '">'];

    const paper = page.paper || {};
    parts.push('<rect width="100%" height="100%" fill="#' + (fld(paper, 'pc', 16777215).toString(16).padStart(6, '0')) + '"/>');
    if (paper.lt === 1 || paper.lt === 2) {
      const gap = fld(paper, 'lh', 24) * 11 / 6, linew = fld(paper, 'lw', 0.5) * 11 / 6;
      let path = 'M 0 ' + num(gap) + ' L ' + num(gap) + ' ' + num(gap);
      if (paper.lt === 2) path += ' M ' + num(gap) + ' 0 L ' + num(gap) + ' ' + num(gap);
      parts.push('<defs><pattern id="paper" width="' + num(gap) + '" height="' + num(gap) +
        '" patternUnits="userSpaceOnUse"><path d="' + path + '" fill="none" stroke="#9a9888" stroke-width="' +
        num(linew) + '"/></pattern></defs><rect width="100%" height="100%" fill="url(#paper)"/>');
    }
    const block = blocks[page.pdfId];
    if (block && pdfImage) {
      try {
        const url = await pdfImage(block, page.pdfPage);
        if (url) {
          let x = 0, y = 0, rw = w, rh = h;
          const r = page.pdfRect;
          if (Array.isArray(r) && r.length === 4 && r.every(v => typeof v === 'number')) [x, y, rw, rh] = r;
          parts.push('<image x="' + num(x) + '" y="' + num(y) + '" width="' + num(rw) + '" height="' + num(rh) +
            '" preserveAspectRatio="xMidYMid meet" href="' + url + '"/>');
        }
      } catch (e) { warnings.push('PDF background unavailable: ' + (e.message || e)); }
    } else if (!paper) warnings.push('Embedded PDF background could not be located.');

    const editable = blocks[page.setId] || {};
    const strokes = editable.strokes || [];
    if (editable.stroke_decode_error) warnings.push(editable.stroke_decode_error);
    const objects = summary.objects.filter(o => o.setId === page.setId);
    const elements = [];
    strokes.forEach((s, i) => { if (s.points.length) elements.push([s.z || 0, strokeSvg(s, i)]); });

    const unsupported = [];
    for (const obj of objects) {
      const [x, y, ow, oh, angle] = obj.transform;
      const sw = obj.size[0], sh = obj.size[1];
      const payload = values(obj.payloadFields);
      const transform = 'translate(' + num(x) + ' ' + num(y) + ') rotate(' + num(angle * 180 / Math.PI) +
        ') translate(' + num(-ow / 2) + ' ' + num(-oh / 2) + ')';
      let el = null;
      if (obj.kindName === 'image' && blocks[obj.assetId]) {
        const b = blocks[obj.assetId];
        const mime = b.kind === 'png' ? 'image/png' : 'image/jpeg';
        const url = dataUrl(data.subarray(b.offset, b.offset + b.size), mime);
        const crop = imageCrop(payload, ow, oh, sw, sh);
        if (crop) {
          const clip = 'nc-crop-' + obj.id;
          el = '<clipPath id="' + clip + '"><path d="' + crop.outline + '"/></clipPath>' +
            '<image x="' + num(crop.left) + '" y="' + num(crop.top) + '" width="' + num(crop.width) +
            '" height="' + num(crop.height) + '" preserveAspectRatio="none" clip-path="url(#' + clip + ')" href="' + url + '"/>';
        } else {
          el = '<image width="' + num(ow) + '" height="' + num(oh) + '" preserveAspectRatio="none" href="' + url + '"/>';
        }
      } else if (obj.kind === 2 || obj.kind === 19) {
        const text = decodeRichText(values(fld(payload, 4, [])));
        warnings.push.apply(warnings, text.warnings);
        const sx = Math.abs(sw) > 1e-9 ? ow / sw : 1, sy = Math.abs(sh) > 1e-9 ? oh / sh : 1;
        const pill = obj.kind === 19 ? '<rect width="' + num(sw) + '" height="' + num(sh) + '" rx="' + num(sh / 2) +
          '" fill="#e8eefb" stroke="#9fb3df" stroke-width="0.8"/>' : '';
        el = '<g transform="scale(' + num(sx) + ' ' + num(sy) + ')">' + pill + textSvg(text, sw) + '</g>';
      } else if ([3, 6, 12, 20, 21].includes(obj.kind)) {
        try { el = shapeElement(obj, payload); }
        catch (e) { warnings.push(e.message || String(e)); }
        if (el !== null && obj.kind === 3 && obj.tool === 2)
          el = tapeGroup(tapeWithPattern(el), 'object:' + obj.index, payload[15] === 1);
      }
      if (el === null) unsupported.push(obj.kind);
      else elements.push([obj.z || 0, composite('<g transform="' + transform + '">' + el + '</g>', obj.opacity, obj.tool)]);
    }
    if (unsupported.length) warnings.push(unsupported.length + ' objects without a renderer (types ' + Array.from(new Set(unsupported)).sort().join(',') + ').');
    elements.sort((a, b) => a[0] - b[0]);
    parts.push.apply(parts, elements.map(e => e[1]));
    parts.push('</svg>');
    return { svg: parts.join(''), stats: { strokes: strokes.length, objects: objects.length, warnings: warnings } };
  }

  const api = { renderPage: renderPage, dataUrl: dataUrl, decodeRichText: decodeRichText, textSvg: textSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NotefulRender = api;
})(typeof window !== 'undefined' ? window : globalThis);
