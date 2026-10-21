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

export interface MaskInstance { left: number; top: number; width: number; height: number; mask: Uint8Array }

export function mergeMasks(instances: MaskInstance[], width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height);
  for (const item of instances) {
    if (!Number.isInteger(item.left) || !Number.isInteger(item.top) || item.left < 0 || item.top < 0 ||
        item.left + item.width > width || item.top + item.height > height || item.mask.length !== item.width * item.height) {
      throw new SampsError("MASK_BOUNDS", "分割蒙版的尺寸或坐标无效。");
    }
    for (let y = 0; y < item.height; y++) {
      const source = y * item.width, target = (y + item.top) * width + item.left;
      for (let x = 0; x < item.width; x++) output[target + x] |= item.mask[source + x];
    }
  }
  return output;
}
