// PNG-8 (palette) encoder: much smaller files for diagrams with few colours.
// Exact when the image has 256 colours or fewer, otherwise uses the 256 most common colours.

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** img: { w, h, d } RGBA. Returns a PNG Blob with a palette. */
export async function encodePng8(img) {
  const { w, h, d } = img;
  const n = w * h;
  const index = new Uint8Array(n);
  let palette = [];

  // exact palette when possible
  const exact = new Map();
  let fits = true;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = exact.get(key);
    if (v === undefined) {
      if (exact.size >= 256) { fits = false; break; }
      v = exact.size;
      exact.set(key, v);
    }
    index[p] = v;
  }
  if (fits) {
    palette = [...exact.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  } else {
    // popularity on 5-bit bins, palette colour = mean of the bin
    const cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const b = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      cnt[b]++; sr[b] += d[i]; sg[b] += d[i + 1]; sb[b] += d[i + 2];
    }
    const bins = [];
    for (let b = 0; b < 32768; b++) if (cnt[b]) bins.push(b);
    bins.sort((a, b) => cnt[b] - cnt[a]);
    const top = bins.slice(0, 256);
    palette = top.map((b) => [Math.round(sr[b] / cnt[b]), Math.round(sg[b] / cnt[b]), Math.round(sb[b] / cnt[b])]);
    const map = new Int16Array(32768).fill(-1);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const b = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      let v = map[b];
      if (v < 0) {
        let best = 0, bd = Infinity;
        const r = d[i], g = d[i + 1], bl = d[i + 2];
        for (let k = 0; k < palette.length; k++) {
          const [pr, pg, pb] = palette[k];
          const dd = (pr - r) ** 2 + (pg - g) ** 2 + (pb - bl) ** 2;
          if (dd < bd) { bd = dd; best = k; }
        }
        map[b] = v = best;
      }
      index[p] = v;
    }
  }

  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(index.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // palette
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((c, k) => plte.set(c, k * 3));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))],
    { type: 'image/png' });
}
