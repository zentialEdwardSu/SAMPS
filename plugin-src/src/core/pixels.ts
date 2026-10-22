import { SampsError } from "./errors";

export interface PixelInfo { width: number; height: number; components: number; componentSize: number }
export interface Bounds { left: number; top: number }
type Samples = Uint8Array | Uint16Array | Float32Array;

// Photoshop 16-bit samples span 0..32768 rather than 0..65535.
const PS16_MAX = 32768;
// 4×4 Bayer matrix, used to dither 16-bit composites down to the 8-bit model input
// so that smooth RAW gradients do not band before the model sees them.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16 - .5);

function to8(value: number, componentSize: number, x: number, y: number): number {
  if (componentSize === 8) return value;
  if (componentSize === 16) {
    const scaled = value * 255 / PS16_MAX + BAYER[(y & 3) * 4 + (x & 3)];
    return scaled <= 0 ? 0 : scaled >= 255 ? 255 : Math.round(scaled);
  }
  // 32-bit linear light is not expected here; clamp defensively.
  return value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
}

/**
 * Places a trimmed Imaging read into a full-canvas RGBA (or single alpha) buffer.
 * Accepts 8- or 16-bit samples; 16-bit input is dithered to 8 bits.
 */
export function expandPixels(data: Samples, info: PixelInfo, bounds: Bounds, width: number, height: number,
  alphaOnly = false): Uint8Array {
  const { components, componentSize } = info;
  if (![8, 16, 32].includes(componentSize) || (components !== 3 && components !== 4)) {
    throw new SampsError("PIXEL_FORMAT", "Photoshop 没有返回预期的 RGB 像素。");
  }
  // getData returns an owned typed array; keep a full-canvas 8-bit RGBA read directly.
  if (!alphaOnly && componentSize === 8 && components === 4 && bounds.left === 0 && bounds.top === 0 &&
      info.width === width && info.height === height && data instanceof Uint8Array) return data;
  const output = new Uint8Array(width * height * (alphaOnly ? 1 : 4));
  for (let y = 0; y < info.height; y++) {
    const dy = bounds.top + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < info.width; x++) {
      const dx = bounds.left + x;
      if (dx < 0 || dx >= width) continue;
      const source = (y * info.width + x) * components;
      const target = dy * width + dx;
      const alpha = components === 4 ? to8(data[source + 3], componentSize, dx, dy) : 255;
      if (alphaOnly) output[target] = alpha;
      else {
        output[target * 4] = to8(data[source], componentSize, dx, dy);
        output[target * 4 + 1] = to8(data[source + 1], componentSize, dx, dy);
        output[target * 4 + 2] = to8(data[source + 2], componentSize, dx, dy);
        output[target * 4 + 3] = alpha;
      }
    }
  }
  return output;
}

/** Places a trimmed single-channel read (selection, mask) into a full-canvas buffer. */
export function expandGray(data: Samples, info: PixelInfo, bounds: Bounds, width: number, height: number): Uint8Array {
  if (info.components !== 1) throw new SampsError("PIXEL_FORMAT", "Photoshop 没有返回单通道选区数据。");
  const output = new Uint8Array(width * height);
  for (let y = 0; y < info.height; y++) {
    const dy = bounds.top + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < info.width; x++) {
      const dx = bounds.left + x;
      if (dx < 0 || dx >= width) continue;
      output[dy * width + dx] = to8(data[y * info.width + x], info.componentSize, dx, dy);
    }
  }
  return output;
}

// Target bin of every source column / row for a box downsample.
function bins(source: number, target: number): Int32Array {
  const out = new Int32Array(source);
  for (let i = 0; i < source; i++) out[i] = Math.min(target - 1, Math.floor(i * target / source));
  return out;
}

/**
 * Box-downsamples full-width 8-bit RGBA rows, fed top to bottom in strips, into a smaller
 * canvas. Pixels are composited over white first (as the models do), so the output is opaque.
 */
export class RgbaDownsampler {
  readonly output: Uint8Array;
  private columns: Int32Array;
  private sum: Float64Array;
  private count: Uint32Array;
  private row = -1;
  constructor(private sourceWidth: number, private sourceHeight: number, private width: number, private height: number) {
    this.output = new Uint8Array(width * height * 4);
    this.columns = bins(sourceWidth, width);
    this.sum = new Float64Array(width * 3);
    this.count = new Uint32Array(width);
  }
  /** `rows` holds `count` full-width rows starting at source row `top`. */
  push(rows: Uint8Array, top: number, count: number) {
    const { columns, sum, sourceWidth } = this;
    for (let y = 0; y < count; y++) {
      const target = Math.min(this.height - 1, Math.floor((top + y) * this.height / this.sourceHeight));
      if (target !== this.row) { this.flush(); this.row = target; }
      let i = y * sourceWidth * 4;
      for (let x = 0; x < sourceWidth; x++, i += 4) {
        const t = columns[x], a = rows[i + 3], white = 255 - a;
        sum[t * 3] += rows[i] * a / 255 + white;
        sum[t * 3 + 1] += rows[i + 1] * a / 255 + white;
        sum[t * 3 + 2] += rows[i + 2] * a / 255 + white;
        this.count[t]++;
      }
    }
  }
  finish(): Uint8Array { this.flush(); return this.output; }
  private flush() {
    if (this.row < 0) return;
    const base = this.row * this.width * 4;
    for (let t = 0; t < this.width; t++) {
      const n = this.count[t] || 1, o = base + t * 4;
      this.output[o] = Math.round(this.sum[t * 3] / n);
      this.output[o + 1] = Math.round(this.sum[t * 3 + 1] / n);
      this.output[o + 2] = Math.round(this.sum[t * 3 + 2] / n);
      this.output[o + 3] = 255;
    }
    this.sum.fill(0); this.count.fill(0);
  }
}

/**
 * Downsamples full-width gray rows, fed in strips, keeping each bin's maximum so thin brush
 * strokes survive the reduction.
 */
export class GrayMaxDownsampler {
  readonly output: Uint8Array;
  private columns: Int32Array;
  constructor(private sourceWidth: number, private sourceHeight: number, private width: number, private height: number) {
    this.output = new Uint8Array(width * height);
    this.columns = bins(sourceWidth, width);
  }
  push(rows: Uint8Array, top: number, count: number) {
    for (let y = 0; y < count; y++) {
      const target = Math.min(this.height - 1, Math.floor((top + y) * this.height / this.sourceHeight)) * this.width;
      const source = y * this.sourceWidth;
      for (let x = 0; x < this.sourceWidth; x++) {
        const value = rows[source + x], t = target + this.columns[x];
        if (value > this.output[t]) this.output[t] = value;
      }
    }
  }
}

export function downsampleMax(plane: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  if (width === sourceWidth && height === sourceHeight) return plane;
  const sampler = new GrayMaxDownsampler(sourceWidth, sourceHeight, width, height);
  sampler.push(plane, 0, sourceHeight);
  return sampler.output;
}

export interface MaskInstance { left: number; top: number; width: number; height: number; mask: Uint8Array }

/**
 * Merges masks found at working size and scales them to the document with bilinear filtering.
 * Only the instances' bounds are interpolated; the rest of the document stays unselected.
 */
export function documentMask(instances: MaskInstance[], work: { width: number; height: number },
  doc: { width: number; height: number }): Uint8Array {
  const merged = mergeMasks(instances, work.width, work.height);
  if (work.width === doc.width && work.height === doc.height) return merged;
  const output = new Uint8Array(doc.width * doc.height);
  if (!instances.length) return output;
  const sx = work.width / doc.width, sy = work.height / doc.height;
  const left = Math.min(...instances.map(item => item.left)), top = Math.min(...instances.map(item => item.top));
  const right = Math.max(...instances.map(item => item.left + item.width)), bottom = Math.max(...instances.map(item => item.top + item.height));
  const x0 = Math.max(0, Math.floor(left / sx) - 1), x1 = Math.min(doc.width, Math.ceil(right / sx) + 1);
  const y0 = Math.max(0, Math.floor(top / sy) - 1), y1 = Math.min(doc.height, Math.ceil(bottom / sy) + 1);
  // Per document column: the two working columns and the weight of the right one.
  const columnA = new Int32Array(x1 - x0), columnB = new Int32Array(x1 - x0), columnW = new Float32Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    const f = Math.min(work.width - 1, Math.max(0, (x + .5) * sx - .5)), a = Math.floor(f);
    columnA[x - x0] = a; columnB[x - x0] = Math.min(work.width - 1, a + 1); columnW[x - x0] = f - a;
  }
  for (let y = y0; y < y1; y++) {
    const f = Math.min(work.height - 1, Math.max(0, (y + .5) * sy - .5)), a = Math.floor(f), wy = f - a;
    const rowA = a * work.width, rowB = Math.min(work.height - 1, a + 1) * work.width, target = y * doc.width;
    for (let x = x0; x < x1; x++) {
      const i = x - x0, wx = columnW[i];
      const upper = merged[rowA + columnA[i]] * (1 - wx) + merged[rowA + columnB[i]] * wx;
      const lower = merged[rowB + columnA[i]] * (1 - wx) + merged[rowB + columnB[i]] * wx;
      output[target + x] = Math.round(upper * (1 - wy) + lower * wy);
    }
  }
  return output;
}

/** Unions cropped masks into a full-canvas plane; soft (0..255) edges combine by maximum. */
export function mergeMasks(instances: MaskInstance[], width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height);
  for (const item of instances) {
    if (!Number.isInteger(item.left) || !Number.isInteger(item.top) || item.left < 0 || item.top < 0 ||
        item.left + item.width > width || item.top + item.height > height || item.mask.length !== item.width * item.height) {
      throw new SampsError("MASK_BOUNDS", "分割蒙版的尺寸或坐标无效。");
    }
    for (let y = 0; y < item.height; y++) {
      const source = y * item.width, target = (y + item.top) * width + item.left;
      for (let x = 0; x < item.width; x++) {
        const value = item.mask[source + x];
        if (value > output[target + x]) output[target + x] = value;
      }
    }
  }
  return output;
}
