// Lab (D50, as Photoshop stores it) → sRGB (D65) 8-bit, used only when Photoshop
// refuses an RGB conversion of the composite. Lab is device independent, so no ICC
// profile is needed for this path.

const D50 = [0.96422, 1, 0.82521];
// Bradford-adapted XYZ(D50) → linear sRGB.
const M = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.0334540,
  0.0719453, -0.2289914, 1.4052427
];

const finv = (t: number) => t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29);
const encode = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
};

/** L in 0..100, a/b in -128..127. Returns sRGB 0..255. */
export function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = D50[0] * finv(fx), Y = D50[1] * finv(fy), Z = D50[2] * finv(fz);
  return [
    encode(M[0] * X + M[1] * Y + M[2] * Z),
    encode(M[3] * X + M[4] * Y + M[5] * Z),
    encode(M[6] * X + M[7] * Y + M[8] * Z)
  ];
}

/**
 * Converts Photoshop chunky Lab samples (3 or 4 components) to 8-bit RGBA.
 * 8-bit Lab: L 0..255, a/b 0..255 centred on 128. 16-bit Lab: 0..32768, a/b centred on 16384.
 */
export function labPixelsToRgba(data: Uint8Array | Uint16Array, components: number, componentSize: 8 | 16): Uint8Array {
  const count = data.length / components;
  const out = new Uint8Array(count * 4);
  const max = componentSize === 8 ? 255 : 32768, mid = componentSize === 8 ? 128 : 16384;
  const ab = componentSize === 8 ? 1 : 128 / 16384;
  // Cache by quantized Lab key; RAW images contain many repeats after 8-bit quantization.
  const cache = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const s = i * components;
    const L = data[s] * 100 / max, A = (data[s + 1] - mid) * ab, B = (data[s + 2] - mid) * ab;
    const key = (Math.round(L * 2) << 16) | ((Math.round(A) + 128) << 8) | (Math.round(B) + 128);
    let rgb = cache.get(key);
    if (rgb === undefined) {
      const [r, g, b] = labToSrgb(L, A, B);
      rgb = (r << 16) | (g << 8) | b;
      if (cache.size < 1 << 20) cache.set(key, rgb);
    }
    out[i * 4] = rgb >> 16; out[i * 4 + 1] = (rgb >> 8) & 255; out[i * 4 + 2] = rgb & 255;
    out[i * 4 + 3] = components === 4 ? (componentSize === 8 ? data[s + 3] : Math.round(data[s + 3] * 255 / 32768)) : 255;
  }
  return out;
}
