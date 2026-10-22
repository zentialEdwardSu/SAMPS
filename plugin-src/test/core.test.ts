import { describe, expect, test } from "vitest";
import { combineSelection, modeFromModifiers } from "../src/core/selection";
import { documentMask, downsampleMax, expandGray, expandPixels, mergeMasks, RgbaDownsampler } from "../src/core/pixels";
import { labToSrgb, labPixelsToRgba } from "../src/core/color";
import { assertDocument, assertFresh, workSize } from "../src/core/document";
import { ResultsHistory } from "../src/ui/history";
import { gpuFailureText, isGpuFailure, lighterOption } from "../src/ui/lighter";

describe("combineSelection", () => {
  const S = Uint8Array.of(0, 255, 255, 128, 0);
  const M = Uint8Array.of(255, 255, 0, 255, 0);
  test("new replaces", () => expect([...combineSelection("new", S, M)]).toEqual([...M]));
  test("add is per-pixel max", () => expect([...combineSelection("add", S, M)]).toEqual([255, 255, 255, 255, 0]));
  test("subtract removes the mask", () => expect([...combineSelection("subtract", S, M)]).toEqual([0, 0, 255, 0, 0]));
  test("intersect is per-pixel min", () => expect([...combineSelection("intersect", S, M)]).toEqual([0, 255, 0, 128, 0]));
  test("soft values are preserved", () => {
    expect([...combineSelection("subtract", Uint8Array.of(200), Uint8Array.of(100))]).toEqual([155]);
  });
  test("empty current selection", () => {
    expect([...combineSelection("add", null, M)]).toEqual([...M]);
    expect([...combineSelection("subtract", null, M)]).toEqual([0, 0, 0, 0, 0]);
    expect([...combineSelection("intersect", null, M)]).toEqual([0, 0, 0, 0, 0]);
  });
  test("size mismatch is rejected", () => expect(() => combineSelection("add", new Uint8Array(2), new Uint8Array(3))).toThrow());
  test("modifier keys follow Photoshop", () => {
    expect(modeFromModifiers(false, false, "new")).toBe("new");
    expect(modeFromModifiers(true, false, "new")).toBe("add");
    expect(modeFromModifiers(false, true, "new")).toBe("subtract");
    expect(modeFromModifiers(true, true, "add")).toBe("intersect");
  });
});

describe("pixels", () => {
  test("trimmed and negative layer origins map to document coordinates", () => {
    const pixels = Uint8Array.from([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]);
    const info = { width: 3, height: 1, components: 4, componentSize: 8 };
    expect([...expandPixels(pixels, info, { left: -1, top: 1 }, 3, 3).slice(12, 20)]).toEqual([40, 50, 60, 128, 70, 80, 90, 255]);
    expect([...expandPixels(pixels, info, { left: -1, top: 1 }, 3, 3, true)]).toEqual([0, 0, 0, 128, 255, 0, 0, 0, 0]);
  });
  test("opaque RGB expands with opaque alpha", () => {
    expect([...expandPixels(Uint8Array.of(1, 2, 3), { width: 1, height: 1, components: 3, componentSize: 8 }, { left: 0, top: 0 }, 1, 1)])
      .toEqual([1, 2, 3, 255]);
  });
  test("16-bit Photoshop range maps to 8-bit with bounded dither", () => {
    const data = Uint16Array.of(0, 16384, 32768, 32768);
    const out = expandPixels(data, { width: 1, height: 1, components: 4, componentSize: 16 }, { left: 0, top: 0 }, 1, 1);
    expect(out[0]).toBe(0); expect(Math.abs(out[1] - 127.5)).toBeLessThanOrEqual(1); expect(out[2]).toBe(255); expect(out[3]).toBe(255);
  });
  test("16-bit gradient dither preserves the mean", () => {
    const width = 64, value = Math.round(100.25 * 32768 / 255);
    const data = new Uint16Array(width * 4 * 3).fill(value);
    const out = expandPixels(data, { width, height: 4, components: 3, componentSize: 16 }, { left: 0, top: 0 }, width, 4);
    let sum = 0; for (let i = 0; i < out.length; i += 4) sum += out[i];
    expect(sum / (out.length / 4)).toBeCloseTo(100.25, 0);
  });
  test("gray selection data is placed by its bounds", () => {
    expect([...expandGray(Uint8Array.of(9, 8), { width: 2, height: 1, components: 1, componentSize: 8 }, { left: 1, top: 1 }, 3, 2)])
      .toEqual([0, 0, 0, 0, 9, 8]);
  });
  test("cropped masks union without filling their boxes", () => {
    expect([...mergeMasks([
      { left: 1, top: 0, width: 2, height: 2, mask: Uint8Array.of(255, 0, 0, 255) },
      { left: 0, top: 1, width: 2, height: 1, mask: Uint8Array.of(255, 255) }
    ], 3, 2)]).toEqual([0, 255, 0, 255, 255, 255]);
  });
  test("invalid mask extents are rejected", () => {
    expect(() => mergeMasks([{ left: -1, top: 0, width: 1, height: 1, mask: new Uint8Array(1) }], 2, 2)).toThrow(/无效/);
  });
});

describe("Lab fallback", () => {
  test("reference colors", () => {
    expect(labToSrgb(100, 0, 0)).toEqual([255, 255, 255]);
    expect(labToSrgb(0, 0, 0)).toEqual([0, 0, 0]);
    // sRGB red is Lab(D50) ≈ (54.29, 80.80, 69.89).
    const [r, g, b] = labToSrgb(54.29, 80.8, 69.89);
    expect(r).toBeGreaterThan(250); expect(g).toBeLessThan(8); expect(b).toBeLessThan(8);
  });
  test("16-bit Photoshop Lab encoding", () => {
    const out = labPixelsToRgba(Uint16Array.of(32768, 16384, 16384), 3, 16);
    expect([...out]).toEqual([255, 255, 255, 255]);
  });
});

test("document switching, undo and edits invalidate writeback", () => {
  const doc = { id: 3, width: 4, height: 4, activeHistoryState: { id: 9 } };
  const stamp = { documentId: 3, historyId: 9, width: 4, height: 4 };
  assertFresh(doc, stamp);
  for (const changed of [{ ...doc, id: 4 }, { ...doc, activeHistoryState: { id: 8 } }, { ...doc, width: 5 }]) {
    expect(() => assertFresh(changed, stamp)).toThrow(/文档已切换/);
  }
  expect(() => assertFresh(null, stamp)).toThrow(/请先打开/);
});

import { clampSettings, describeSettings, loadSelectionSettings, saveSelectionSettings } from "../src/core/settings";

describe("selection settings", () => {
  const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
  test("defaults, then remembers the last confirmed values", () => {
    const store = memory();
    expect(loadSelectionSettings(store)).toEqual({ expand: 0, feather: 0 });
    saveSelectionSettings({ expand: 3, feather: 1.5 }, store);
    expect(loadSelectionSettings(store)).toEqual({ expand: 3, feather: 1.5 });
  });
  test("clamps and rounds out-of-range or corrupt input", () => {
    expect(clampSettings({ expand: 9999, feather: -4 })).toEqual({ expand: 500, feather: 0 });
    expect(clampSettings({ expand: 2.6, feather: 1.26 })).toEqual({ expand: 3, feather: 1.3 });
    const store = memory(); store.setItem("samps.selectionSettings.v1", "{not json");
    expect(loadSelectionSettings(store)).toEqual({ expand: 0, feather: 0 });
  });
  test("describes contraction and feathering", () => {
    expect(describeSettings({ expand: -2, feather: 0 })).toBe("收缩 2 像素");
    expect(describeSettings({ expand: 0, feather: 0 })).toBe("");
  });
});

describe("soft masks", () => {
  test("overlapping soft edges merge by maximum, not bitwise or", () => {
    const a = { left: 0, top: 0, width: 2, height: 1, mask: Uint8Array.of(128, 64) };
    const b = { left: 1, top: 0, width: 2, height: 1, mask: Uint8Array.of(129, 255) };
    expect([...mergeMasks([a, b], 3, 1)]).toEqual([128, 129, 255]);
  });
});

describe("results history", () => {
  const stamp = (historyId: number, documentId = 1) => ({ documentId, historyId, width: 2, height: 1 });
  const capture = (rgba: Uint8Array) => ({ rgba, alpha: new Uint8Array(2), exclude: null, width: 2, height: 1, promptId: 1,
    promptRead: {}, captureMethod: "", stamp: stamp(0) });
  const item = { id: 5, left: 0, top: 0, width: 1, height: 1, confidence: .9, overlap: 1, offset: 0, length: 1, mask: Uint8Array.of(255), box: [0, 0, 1, 1] } as any;
  test("undo and redo find the results recorded for a history state", () => {
    const history = new ResultsHistory();
    const image = new Uint8Array(8);
    history.record(stamp(10), { instances: [], selected: [], snapshot: null });
    history.record(stamp(11), { instances: [item], selected: [5], snapshot: capture(image) });
    history.record(stamp(12), { instances: [item], selected: [], snapshot: capture(image) });
    expect(history.get(stamp(10))).toEqual({ instances: [], selected: [], snapshot: null });
    expect(history.get(stamp(11))!.selected).toEqual([5]);
    expect(history.get(stamp(11))!.snapshot!.stamp).toEqual(stamp(11));
    expect(history.get(stamp(12))!.selected).toEqual([]);
    expect(history.get(stamp(11, 2))).toBeUndefined();
    expect(history.get({ ...stamp(11), width: 3 })).toBeUndefined();
  });
  test("only the newest images are kept alive", () => {
    const history = new ResultsHistory(64, 2);
    const images = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
    images.forEach((image, i) => history.record(stamp(i), { instances: [item], selected: [5], snapshot: capture(image) }));
    expect(history.get(stamp(0))).toBeUndefined();
    expect(history.get(stamp(1))).toBeDefined();
    expect(history.get(stamp(2))).toBeDefined();
  });
});

describe("large documents", () => {
  test("documents up to 64 MP are processed at full size; larger ones at a working size", () => {
    expect(workSize(8000, 6000)).toEqual({ width: 8000, height: 6000 });
    const gfx = workSize(11648, 8736);  // 102 MP medium format
    expect(gfx.width * gfx.height).toBeLessThanOrEqual(64_000_000);
    expect(Math.abs(gfx.width / gfx.height - 11648 / 8736)).toBeLessThan(.001);
    const pano = workSize(60000, 8000);  // wider than the native 30000 px side limit
    expect(pano.width).toBeLessThanOrEqual(30000);
  });
  test("150 MP documents pass the size check, 1 GP does not", () => {
    const doc = (width: number, height: number) => ({ id: 1, width, height, activeHistoryState: { id: 1 } });
    expect(() => assertDocument(doc(14204, 10652))).not.toThrow();
    expect(() => assertDocument(doc(40000, 30000))).toThrow();
  });
  test("strokes survive a max downsample; colour is box-averaged over white", () => {
    const plane = new Uint8Array(16); plane[5] = 200;  // one painted pixel in a 4×4 plane
    expect([...downsampleMax(plane, 4, 4, 2, 2)]).toEqual([200, 0, 0, 0]);
    const rgba = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < 8; i++) rgba.set(i % 2 ? [0, 0, 0, 255] : [255, 255, 255, 0], i * 4);
    const sampler = new RgbaDownsampler(4, 2, 2, 1);
    sampler.push(rgba.subarray(0, 16), 0, 1); sampler.push(rgba.subarray(16), 1, 1);
    expect([...sampler.finish()]).toEqual([128, 128, 128, 255, 128, 128, 128, 255]);
  });
  test("working-size masks are scaled to the document only around the instances", () => {
    const item = { left: 1, top: 1, width: 1, height: 1, mask: Uint8Array.of(255) };
    const out = documentMask([item], { width: 4, height: 4 }, { width: 8, height: 8 });
    expect(out[3 * 8 + 3]).toBeGreaterThan(128);
    expect(out[0]).toBe(0); expect(out[7 * 8 + 7]).toBe(0);
    expect(out.some(value => value > 0 && value < 255)).toBe(true);  // interpolated edge
    expect(documentMask([item], { width: 4, height: 4 }, { width: 4, height: 4 })[5]).toBe(255);
  });
});

describe("GPU memory failures", () => {
  test("suggest releasing the encoder first, then smaller SAM 3 inputs, then YOLOE", () => {
    expect(lighterOption("sam3", false)).toEqual({ kind: "release" });
    expect(lighterOption("sam3", true)).toMatchObject({ kind: "model", model: { id: "sam3-840" } });
    expect(lighterOption("sam3-840", true)).toMatchObject({ kind: "model", model: { id: "sam3-672" } });
    expect(lighterOption("sam3-672", true)).toMatchObject({ kind: "model", model: { id: "yoloe26x" } });
    expect(lighterOption("yoloe26x", true)).toBeNull();
    expect(lighterOption("yoloe26x", false)).toBeNull();
  });
  test("only out-of-memory and device-lost errors count", () => {
    expect(isGpuFailure({ code: "GPU_MEMORY" })).toBe(true);
    expect(isGpuFailure({ code: "GPU_LOST" })).toBe(true);
    expect(isGpuFailure({ code: "INFERENCE_FAILED" })).toBe(false);
    expect(isGpuFailure(null)).toBe(false);
  });
  test("messages name the stage and the suggested model", () => {
    const next = lighterOption("sam3-840", true);
    expect(gpuFailureText({ code: "GPU_MEMORY" }, "识别", next)).toContain("SAM 3.1 · 672 px");
    expect(gpuFailureText({ code: "GPU_LOST" }, "识别", next)).toContain("模型已卸载");
    expect(gpuFailureText({ code: "GPU_MEMORY" }, "加载模型", null)).toContain("最轻量");
  });
});
