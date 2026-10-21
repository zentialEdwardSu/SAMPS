import { describe, expect, test } from "vitest";
import { combineSelection, modeFromModifiers } from "../src/core/selection";
import { expandGray, expandPixels, mergeMasks } from "../src/core/pixels";
import { labToSrgb, labPixelsToRgba } from "../src/core/color";
import { assertFresh } from "../src/core/document";

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
