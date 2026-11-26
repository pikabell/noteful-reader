/* Strict reader for the observed Noteful container format.
 * Ported from reader/format.py (which itself derives from the independent
 * noteful-re reverse-engineering research). Standard JS only, no dependencies.
 */
(function (root) {
  'use strict';

  class FormatError extends Error {}

  const MAGIC = [0xaa, 0xbb, 0xcc, 0xde];
  const decoder = new TextDecoder('utf-8');

  function hasMagic(b) {
    return b.length >= 4 && b[0] === MAGIC[0] && b[1] === MAGIC[1] &&
           b[2] === MAGIC[2] && b[3] === MAGIC[3];
  }
  function isFinite4(v) { return typeof v === 'number' && isFinite(v); }

  class Reader {
    constructor(data, origin, depth) {
      this.d = data;
      this.origin = origin || 0;
      this.depth = depth || 0;
      this.pos = 0;
      if (this.depth > 40) throw new FormatError('Nesting limit exceeded');
    }
    take(n) {
      if (n < 0 || n > this.d.length - this.pos)
        throw new FormatError('Read outside buffer at 0x' + (this.origin + this.pos).toString(16));
      const b = this.d.subarray(this.pos, this.pos + n);
      this.pos += n;
      return b;
    }
    u8() { return this.take(1)[0]; }
    u16() { const b = this.take(2); return (b[0] << 8) | b[1]; }
    u32() { const b = this.take(4); return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0); }
    u64() {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.d[this.pos + i]);
      this.pos += 8;
      return v;
    }
    f32() {
      const b = this.take(4);
      return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
    }
    f64() {
      const b = this.take(8);
      return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
    }
    scalar(kind) {
      switch (kind) {
        case 1: return this.u8();
        case 2: case 0x13: return Number(this.u64());
        case 3: return this.f32();
        case 4: case 0x20: return this.f64();
        case 0x11: return this.u16();
        case 0x12: case 0x14: return this.u32();
        case 0x21: return [this.f64(), this.f64()];
        case 0x23: return [this.f64(), this.f64(), this.f64(), this.f64()];
        case 5: case 6: case 7: {
          const n = this.u32();
          const origin = this.origin + this.pos;
          const bytes = this.take(n);
          if (kind === 5) return decoder.decode(bytes);
          if (kind === 6) return { offset: origin, size: n, bytes: bytes, hex: hex(bytes) };
          return new Reader(bytes, origin, this.depth + 1).fields();
        }
        default: throw new FormatError('Unknown type 0x' + kind.toString(16));
      }
    }
    fields() {
      const fields = [];
      while (this.pos < this.d.length) {
        const start = this.origin + this.pos;
        const tag = this.u16(), typ = this.u16();
        if (typ & ~0x0cff) throw new FormatError('Unknown type flags 0x' + typ.toString(16) + ' at 0x' + start.toString(16));
        let value;
        if (typ & 0x400) {
          const n = this.u32();
          if (n > this.d.length - this.pos) throw new FormatError('Array count exceeds remaining bytes');
          value = [];
          for (let i = 0; i < n; i++) value.push(this.scalar(typ & 0xff));
        } else {
          value = this.scalar(typ & 0xff);
        }
        const f = { tag: tag, type: '0x' + typ.toString(16).padStart(4, '0'), offset: start, value: value };
        if (typ & 0x800) f.clock_raw = Number(this.u64());
        f.size = this.origin + this.pos - start;
        fields.push(f);
      }
      return fields;
    }
  }

  function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }
  function values(fields) {
    const out = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(out, f.tag)) throw new FormatError('Duplicate tag ' + f.tag);
      out[f.tag] = f.value;
    }
    return out;
  }
  function fld(v, tag, def) { return v[tag] !== undefined ? v[tag] : def; }
  function walkFields(fields, out) {
    out = out || [];
    for (const f of fields) {
      out.push(f);
      const typ = parseInt(f.type, 16);
      if ((typ & 0xff) === 7) {
        const groups = (typ & 0x400) ? f.value : [f.value];
        for (const g of groups) walkFields(g, out);
      }
    }
    return out;
  }
  function audioKind(raw) {
    if (raw.length >= 4 && raw[0] === 0x63 && raw[1] === 0x61 && raw[2] === 0x66 && raw[3] === 0x66) return 'caf';
    if (raw.length >= 12 && str(raw, 0, 4) === 'RIFF' && str(raw, 8, 12) === 'WAVE') return 'wav';
    if (raw.length >= 12 && str(raw, 4, 8) === 'ftyp' && ['M4A ', 'M4B '].includes(str(raw, 8, 12))) return 'm4a';
    if (str(raw, 0, 3) === 'ID3') return 'mp3';
    if (str(raw, 0, 4) === 'fLaC') return 'flac';
    if (str(raw, 0, 4) === 'OggS') return 'ogg';
    return null;
  }
  function str(bytes, a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]); return s; }

  function decodeEraserMask(flags, count, aux) {
    if (!(flags & 2) || count < 2 || aux.length !== count * 8) return null;
    let opaque = 0, n = 0;
    for (let i = 0; i < 4; i++) { opaque = (opaque << 8) | aux[i]; n = (n << 8) | aux[4 + i]; }
    if (opaque !== 0 || n !== count - 1) return null;
    const dv = new DataView(aux.buffer, aux.byteOffset, aux.byteLength);
    const pairs = [];
    for (let i = 0; i < count - 1; i++) {
      const a = dv.getFloat32(8 + i * 8, false), b = dv.getFloat32(12 + i * 8, false);
      if (!isFinite4(a) || !isFinite4(b) || a < -1e-3 || a > 1 + 1e-3 || b < -1e-3 || b > 1 + 1e-3) return null;
      pairs.push([a, b]);
    }
    return pairs;
  }

  function visibleRuns(points, radii, mask) {
    if (mask === null) return [[points.slice(), radii.slice()]];
    const point = i => [points[i], radii[i] !== undefined ? radii[i] : null];
    const at = (i, t) => {
      const p = points[i], q = points[i + 1];
      const r = radii.length ? radii[i] + (radii[i + 1] - radii[i]) * t : null;
      return [[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], r];
    };
    const out = [];
    let cur = [];
    const flush = () => { if (cur.length > 1) out.push([cur.map(x => x[0]), cur.map(x => x[1]).filter(r => r !== null)]); cur = []; };
    for (let i = 0; i < mask.length; i++) {
      const a = mask[i][0], b = mask[i][1];
      if (a <= 0 && b <= 0) {
        if (!cur.length) cur.push(point(i));
        cur.push(point(i + 1));
        continue;
      }
      if (a + b >= 1) { flush(); continue; }
      if (b > 0) { flush(); cur.push(at(i, b)); }
      else if (!cur.length) cur.push(point(i));
      cur.push(at(i, 1 - a));
      if (a > 0) flush();
    }
    flush();
    return out;
  }

  function decodeSampleStrokes(blob) {
    const r = new Reader(blob);
    const strokes = [];
    let style = { rgba: [0, 0, 0, 1], tool: 0 };
    while (r.pos < blob.length) {
      const start = r.pos;
      const cmd = r.take(2);
      if (cmd[0] === 0xf1 && cmd[1] === 0x02) {
        const rgba = [r.f64(), r.f64(), r.f64(), r.f64()];
        const tool = r.u16();
        r.take(8);
        if (rgba.some(v => !isFinite4(v) || v < 0 || v > 1)) throw new FormatError('Invalid RGBA at +0x' + start.toString(16));
        style = { rgba: rgba, tool: tool };
        continue;
      }
      if (!(cmd[0] === 0xf1 && cmd[1] === 0x01)) throw new FormatError('Unsupported stroke command at +0x' + start.toString(16));
      const prefix = r.take(38);
      const flags = (prefix[8] << 8) | prefix[9];
      if (flags & ~0x17) throw new FormatError('Unsupported stroke flags 0x' + flags.toString(16));
      if (flags & 0x10) { const len = r.u32(); r.take(len); }
      const thickness = r.f64();
      r.u32();                 // unknown
      const count = r.u32();
      const dim = (flags & 1) ? 3 : 2;
      if (count > Math.floor(blob.length / 4)) throw new FormatError('Stroke point count exceeds buffer');
      const aux = (flags & 2) ? r.take(count * 8) : new Uint8Array(0);
      const raw = [];
      if (count <= 4) {
        for (let i = 0; i < count; i++) { const p = []; for (let j = 0; j < dim; j++) p.push(r.f32()); raw.push(p); }
      } else {
        const bounds = []; for (let j = 0; j < dim * 2; j++) bounds.push(r.f32());
        for (let i = 0; i < count; i++) {
          const p = [];
          for (let j = 0; j < dim; j++) p.push(bounds[j * 2] + r.u16() / 65535 * bounds[j * 2 + 1]);
          raw.push(p);
        }
      }
      if (!isFinite4(thickness) || raw.some(p => p.some(v => !isFinite4(v)))) throw new FormatError('Non-finite stroke values');
      const points = raw.map(p => p.slice(0, 2));
      const radii = dim === 3 ? raw.map(p => p[2]) : [];
      const mask = decodeEraserMask(flags, count, aux);
      strokes.push({
        flags: flags,
        z: Number((function () { let v = 0n; for (let i = 26; i < 34; i++) v = (v << 8n) | BigInt(prefix[i]); return v; })()),
        thickness: thickness,
        points: points,
        radii: radii,
        runs: visibleRuns(points, radii, mask),
        style: Object.assign({}, style)
      });
    }
    return strokes;
  }

  function kindOf(sig, key, editable) {
    if (hasMagic(sig)) return 'structured';
    if (sig.length >= 5 && sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46 && sig[4] === 0x2d) return 'pdf';
    if (sig.length >= 3 && sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return 'jpeg';
    if (sig.length >= 4 && sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return 'png';
    const audio = audioKind(sig.length >= 12 ? sig : new Uint8Array(12));
    if (audio) return audio;
    if (key.startsWith('n:')) return 'note_metadata';
    if (key.startsWith('d:')) return 'drawing_metadata';
    return 'structured';
  }

  function parse(data) {
    if (data.length < 20 || !hasMagic(data.subarray(0, 4)) || !hasMagic(data.subarray(data.length - 16, data.length - 12)))
      throw new FormatError('Noteful start/end magic missing');
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const indexOffset = Number(dv.getBigUint64(data.length - 12, false));
    const indexSize = dv.getUint32(data.length - 4, false);
    if (indexOffset < 4 || indexOffset + indexSize !== data.length - 16) throw new FormatError('Invalid index extent');
    const indexFields = new Reader(data.subarray(indexOffset, indexOffset + indexSize), indexOffset).fields();
    const index = values(indexFields);
    const keys = fld(index, 10), offsets = fld(index, 11), sizes = fld(index, 12);
    if (!Array.isArray(keys) || !Array.isArray(offsets) || !Array.isArray(sizes)) throw new FormatError('Invalid index arrays');
    if (keys.length !== offsets.length || keys.length !== sizes.length || new Set(keys).size !== keys.length) throw new FormatError('Inconsistent index arrays');
    const editable = new Set(fld(index, 4, []));
    const blocks = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], offset = offsets[i], size = sizes[i];
      if (offset < 4 || size <= 0 || offset + size > indexOffset) throw new FormatError('Invalid block extent: ' + key);
      const sig = data.subarray(offset, offset + 5);
      let kind = kindOf(sig, key, editable);
      const block = { id: key, offset: offset, size: size, kind: kind };
      if (kind === 'note_metadata' || kind === 'drawing_metadata' || kind === 'structured') {
        block.fields = new Reader(data.subarray(offset, offset + size), offset).fields();
      }
      if (editable.has(key)) {
        block.kind = 'stroke_object_set';
        const v = values(block.fields);
        const blob = v[2];
        if (blob && blob.bytes) {
          try { block.strokes = decodeSampleStrokes(blob.bytes); }
          catch (e) { block.stroke_decode_error = String(e && e.message || e); }
        }
        if (Array.isArray(v[5])) block.object_ids = fld(values(v[5]), 1, []);
      }
      blocks.push(block);
    }
    return { size: data.length, indexOffset: indexOffset, indexSize: indexSize, blocks: blocks };
  }

  function objectSemantics(payload, tool) {
    const kind = payload[1];
    const names = { 1: 'image', 2: 'rich_text', 3: 'rounded_rectangle', 6: 'ellipse', 12: 'polygon', 19: 'tag', 20: 'line_shape', 21: 'curve' };
    return {
      kind: kind,
      kindName: names[kind] || 'unknown',
      locked: payload[21] === 1,
      revealed: kind === 3 && tool === 2 ? payload[15] === 1 : null
    };
  }

  function semanticSummary(report) {
    const result = { title: null, pages: [], layers: [], objects: [] };
    const blocks = {};
    for (const b of report.blocks) blocks[b.id] = b;
    for (const b of report.blocks) {
      if (b.kind === 'note_metadata') {
        const v = values(b.fields);
        result.title = fld(v, 3, null);
      } else if (b.kind === 'drawing_metadata') {
        const v = values(b.fields);
        const pagesGroup = values(fld(v, 2, []));
        for (const p of fld(pagesGroup, 0, [])) {
          const pv = values(p);
          const assets = values(fld(pv, 2, []));
          const bg = values(fld(pv, 4, []));
          const type = fld(bg, 0, 0);
          let paper = null;
          if (bg[6]) { try { paper = JSON.parse(bg[6]); } catch (e) { paper = null; } }
          result.pages.push({
            id: fld(pv, 1, null),
            setId: fld(assets, 0, null),
            size: fld(bg, 1, [1091.34, 1543.46]),
            pdfId: type === 1 ? fld(bg, 4, null) : fld(bg, 3, null),
            pdfPage: type === 1 ? fld(bg, 3, 0) : fld(bg, 7, 0),
            pdfRect: fld(bg, 9, null),
            paper: paper,
            provider: fld(bg, 5, null),
            order: fld(pv, 5, '')
          });
        }
        const layerGroup = values(fld(v, 3, []));
        for (const l of fld(layerGroup, 0, [])) {
          const lv = values(l);
          result.layers.push({ id: fld(lv, 2, null), name: fld(lv, 1, ''), opacity: fld(lv, 6, 1) });
        }
      } else if (b.kind === 'stroke_object_set') {
        const v = values(b.fields);
        const objs = values(fld(v, 5, []));
        for (let i = 0; i < fld(objs, 0, []).length; i++) {
          const ov = values(fld(objs, 0, [])[i]);
          const payload = values(fld(ov, 6, []));
          result.objects.push(Object.assign({
            id: fld(ov, 1, null),
            setId: b.id,
            index: i,
            transform: fld(values(fld(ov, 2, [])), 1, [0, 0, 100, 100, 0]),
            layer: fld(ov, 4, 0),
            z: fld(ov, 5, 0),
            opacity: fld(ov, 8, 1),
            tool: fld(ov, 9, 0),
            size: fld(payload, 2, [0, 0]),
            assetId: fld(payload, 10, null),
            payloadFields: fld(ov, 6, [])
          }, objectSemantics(payload, fld(ov, 9, 0))));
        }
      }
    }
    result.pages.sort((a, b) => String(a.order).localeCompare(String(b.order)));
    return result;
  }

  const api = {
    FormatError: FormatError, Reader: Reader, values: values, fld: fld,
    hex: hex, decodeSampleStrokes: decodeSampleStrokes,
    decodeEraserMask: decodeEraserMask, visibleRuns: visibleRuns,
    parse: parse, semanticSummary: semanticSummary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Noteful = api;
})(typeof window !== 'undefined' ? window : globalThis);
