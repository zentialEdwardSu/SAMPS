import { expect, test } from "vitest";
import { PhotoshopHost } from "../src/host/PhotoshopHost";

// A small Photoshop model: one document, a selection plane, layers with alpha,
// and the batchPlay descriptors the host uses. It records every call so tests can
// assert that no temporary documents are created and the source is never altered.
function photoshop({ title = "raw.psd", mode = "labColorMode", depth = "bitDepth16", failRgb = false, selection = null as number[] | null, ps24 = false } = {}) {
  const W = 3, H = 2, calls: string[] = [], commits: boolean[] = [];
  const promptAlpha = Uint8Array.of(0, 200, 0, 0, 0, 0);
  const prompt: any = { id: 2, name: "[SAMPS 提示] 用画笔标记目标", visible: true, kind: "pixel", alpha: promptAlpha };
  const result: any = { id: 3, name: "[SAMPS 结果] previous", visible: false, kind: "pixel" };
  const smart: any = { id: 4, name: "Camera Raw smart object", visible: true, kind: "smartObject" };
  let sel: Uint8Array | null = selection ? Uint8Array.from(selection) : null;
  let nextId = 10;
  // Layer.move(group, "placeInside") reparents a layer into a group.
  const detach = (layer: any) => {
    for (const list of [doc.layers, ...doc.layers.filter((l: any) => l.layers).map((l: any) => l.layers)]) {
      const index = list.indexOf(layer);
      if (index >= 0) list.splice(index, 1);
    }
  };
  function movable(layer: any) {
    layer.move = (target: any, placement: string) => {
      expect(placement).toBe("placeInside");
      detach(layer); target.layers.unshift(layer); layer.parent = target; calls.push(`move:${layer.id}->${target.id}`);
    };
    return layer;
  }
  const doc: any = { id: 1, title, width: W, height: H, mode, bitsPerChannel: depth, colorProfileName: "ProPhoto RGB",
    activeHistoryState: { id: 8 }, layers: [prompt, result, smart], activeLayers: [smart],
    selection: { get bounds() { return sel && sel.some(v => v) ? { left: 0, top: 0, right: W, bottom: H } : null; },
      async deselect() { calls.push("deselect"); sel = null; } },
    async createLayer({ name }: any) { const layer = movable({ id: nextId++, name, visible: true, kind: "pixel", alpha: new Uint8Array(W * H) }); doc.layers.unshift(layer); return layer; },
    async createLayerGroup({ name }: any) {
      const group: any = movable({ id: nextId++, name, visible: true, kind: "group", layers: [] });
      doc.layers.unshift(group); calls.push(`group:${name}`); return group;
    }
  };
  // Layer.duplicate places the copy directly above its source.
  const duplicable = (layer: any) => {
    layer.duplicate = async () => {
      calls.push(`duplicate:${layer.id}`);
      const copy = duplicable({ id: nextId++, name: `${layer.name} copy`, visible: layer.visible, kind: layer.kind });
      doc.layers.splice(doc.layers.indexOf(layer), 0, copy);
      return copy;
    };
    return layer;
  };
  for (const layer of doc.layers) duplicable(layer);
  // Photoshop 24.x: Document.selection exists, but Selection.bounds / deselect() arrive in 25.0.
  if (ps24) doc.selection = {};
  const ps: any = { app: { documents: [doc], activeDocument: doc } };
  ps.app.createDocument = () => { throw new Error("temporary documents are not allowed"); };
  doc.duplicate = () => { throw new Error("document duplicates are not allowed"); };
  ps.core = { async executeAsModal(fn: any) {
    return fn({ isCancelled: false, hostControl: {
      async suspendHistory() { calls.push("suspend"); return 7; },
      async resumeHistory(_id: number, commit: boolean) { commits.push(commit); if (commit) doc.activeHistoryState = { id: doc.activeHistoryState.id + 1 }; }
    } });
  } };
  ps.action = { async batchPlay(commands: any[]) {
    const out: any[] = [];
    for (const c of commands) {
      if (c._obj === "get" && c._target?.[0]?._property === "selection") {
        calls.push("getSelectionDescriptor");
        out.push(sel && sel.some(v => v) ? { selection: { _obj: "rectangle" } } : {});
      } else if (c._obj === "set" && c.to?._value === "none") { calls.push("deselect"); sel = null; }
      else if (c._obj === "set" && c.to?._ref) {
        const id = c.to._ref[1]._id; calls.push(`selection=transparency:${id}`);
        const all = (ls: any[]): any[] => ls.flatMap((l: any) => [l, ...(l.layers ? all(l.layers) : [])]);
        sel = Uint8Array.from(all(doc.layers).find((l: any) => l.id === id).alpha);
      } else if (c._obj === "set" && c.to?._value === "allEnum") { calls.push("selectAll"); sel = new Uint8Array(W * H).fill(255); }
      else if (c._obj === "delete") { const layer = doc.activeLayers[0]; calls.push(`clear:${layer.id}`); layer.alpha = new Uint8Array(W * H); }
      else if (c._obj === "select") calls.push(`tool:${c._target[0]._ref}`);
      else if (c._obj === "mergeVisible") {
        expect(c.duplicate).toBe(true);
        expect(doc.layers.filter((l: any) => l.name.startsWith("[SAMPS")).every((l: any) => !l.visible)).toBe(true);
        const layer = { id: nextId++, name: "Merged", visible: true, kind: "pixel" }; doc.layers.unshift(layer); doc.activeLayers = [layer];
        calls.push("stampVisible");
      } else if (c._obj === "make") { const layer = doc.activeLayers[0]; layer.mask = sel ? Uint8Array.from(sel) : null; calls.push(`mask:${layer.id}`); }
    }
    return out;
  } };
  ps.imaging = {
    async getSelection() {
      calls.push("getSelection");
      return { sourceBounds: { left: 0, top: 0 }, imageData: { width: W, height: H, components: 1, componentSize: 8,
        async getData() { return Uint8Array.from(sel || new Uint8Array(W * H)); }, dispose() {} } };
    },
    async putSelection({ imageData }: any) { calls.push("putSelection"); sel = Uint8Array.from(imageData.buffer); },
    async createImageDataFromBuffer(buffer: Uint8Array) { return { buffer, dispose() {} }; },
    async getPixels(options: any) {
      expect(options.documentID).toBe(doc.id);
      expect(options.layerID).toBeUndefined();
      const rgb = options.colorSpace === "RGB";
      calls.push(`getPixels:${rgb ? "RGB" : "native"}:${options.componentSize}`);
      if (rgb && failRgb) throw new Error("-32005");
      const size = options.componentSize, rows = options.sourceBounds.bottom - options.sourceBounds.top;
      const data = size === 16 ? new Uint16Array(W * rows * 4).fill(rgb ? 16384 : 32768) : new Uint8Array(W * rows * 4).fill(128);
      if (!rgb) for (let i = 0; i < data.length; i += 4) { data[i + 1] = 16384; data[i + 2] = 16384; }
      return { level: 0, sourceBounds: options.sourceBounds, imageData: { width: W, height: rows, components: 4, componentSize: size,
        async getData() { return data; }, dispose() {} } };
    },
    async encodeImageData() { return ""; }
  };
  return { host: new PhotoshopHost(ps), ps, doc, prompt, result, smart, calls, commits, get selection() { return sel; } };
}

test("RAW PSD capture reads through Photoshop without temporary documents or filename checks", async () => {
  for (const title of ["raw.psd", "IMG_0001.CR3", "Untitled-1"]) {
    const mock = photoshop({ title });
    const snapshot = await mock.host.capture();
    expect([...snapshot.alpha]).toEqual([0, 200, 0, 0, 0, 0]);
    expect(snapshot.rgba.length).toBe(3 * 2 * 4);
    expect(Math.abs(snapshot.rgba[0] - 128)).toBeLessThanOrEqual(1);
    expect(snapshot.promptRead.compositeRead).toBe("photoshop-rgb16-dither");
    expect(mock.calls).toContain("getPixels:RGB:16");
    expect(mock.smart.kind).toBe("smartObject");
    expect(mock.ps.app.documents).toEqual([mock.doc]);
  }
});

test("capture preserves the user's selection and plugin layer visibility", async () => {
  const mock = photoshop({ selection: [255, 0, 0, 0, 0, 128] });
  await mock.host.capture();
  expect([...mock.selection!]).toEqual([255, 0, 0, 0, 0, 128]);
  expect(mock.prompt.visible).toBe(true); expect(mock.result.visible).toBe(false);
  expect(mock.commits).toEqual([true]);
});

test("Lab documents fall back to native samples when Photoshop rejects the RGB conversion", async () => {
  const mock = photoshop({ failRgb: true });
  const snapshot = await mock.host.capture();
  expect(snapshot.promptRead.compositeRead).toBe("lab-native-js-convert");
  expect([...snapshot.rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  expect(mock.prompt.visible).toBe(true);
});

test("RGB read failures on non-Lab documents are reported, and state is restored", async () => {
  const mock = photoshop({ mode: "RGBColorMode", failRgb: true, selection: [1, 2, 3, 4, 5, 6] });
  await expect(mock.host.capture()).rejects.toThrow(/-32005/);
  expect(mock.prompt.visible).toBe(true);
  expect([...mock.selection!]).toEqual([1, 2, 3, 4, 5, 6]);
});

test("an empty prompt is rejected before reading the composite", async () => {
  const mock = photoshop(); mock.prompt.alpha = new Uint8Array(6);
  await expect(mock.host.capture()).rejects.toMatchObject({ code: "EMPTY_PROMPT" });
  expect(mock.calls.some(c => c.startsWith("getPixels"))).toBe(false);
});

test("clearPrompt empties the prompt layer in one history step and keeps the selection", async () => {
  const mock = photoshop({ selection: [0, 0, 255, 0, 0, 0] });
  expect(await mock.host.clearPrompt()).toBe(true);
  expect([...mock.prompt.alpha]).toEqual([0, 0, 0, 0, 0, 0]);
  expect(mock.doc.layers).toContain(mock.prompt);
  expect([...mock.selection!]).toEqual([0, 0, 255, 0, 0, 0]);
  expect(mock.commits).toEqual([true]);
  expect(mock.doc.activeLayers).toEqual([mock.smart]);
});

const instance = { id: 1, left: 0, top: 0, width: 2, height: 1, mask: Uint8Array.of(255, 255), confidence: 1, offset: 0, length: 2 };

for (const [mode, expected] of [
  ["new", [255, 255, 0, 0, 0, 0]], ["add", [255, 255, 255, 0, 0, 0]],
  ["subtract", [0, 0, 255, 0, 0, 0]], ["intersect", [0, 255, 0, 0, 0, 0]]
] as const) {
  test(`selection output in ${mode} mode`, async () => {
    const mock = photoshop({ selection: [0, 255, 255, 0, 0, 0] });
    const snapshot = await mock.host.capture();
    await mock.host.output(snapshot, [instance], "selection", { mode });
    expect([...(mock.selection || new Uint8Array(6))]).toEqual(expected);
  });
}

test("mask layers stamp the visible composite in the document's own mode, then restore the selection", async () => {
  const mock = photoshop({ selection: [0, 0, 0, 0, 0, 9] });
  const snapshot = await mock.host.capture();
  await mock.host.output(snapshot, [instance, { ...instance, id: 2, top: 1 }], "layers", { separate: true });
  const results = mock.doc.layers.filter((l: any) => l.name.startsWith("[SAMPS 结果] 实例"));
  expect(results).toHaveLength(2);
  const byName = (name: string) => results.find((l: any) => l.name === `[SAMPS 结果] ${name}`);
  expect([...byName("实例 1").mask]).toEqual([255, 255, 0, 0, 0, 0]);
  expect([...byName("实例 2").mask]).toEqual([0, 0, 0, 255, 255, 0]);
  expect(results.every((l: any) => l.visible)).toBe(true);
  expect(mock.doc.mode).toBe("labColorMode"); expect(mock.doc.bitsPerChannel).toBe("bitDepth16");
  expect([...mock.selection!]).toEqual([0, 0, 0, 0, 0, 9]);
  expect(mock.prompt.visible).toBe(false); expect(mock.result.visible).toBe(false);
});

test("a single visible layer (RAW import) is duplicated instead of stamp visible", async () => {
  const mock = photoshop();
  const snapshot = await mock.host.capture();
  await mock.host.output(snapshot, [instance], "layers");
  expect(mock.calls).toContain(`duplicate:${mock.smart.id}`);
  expect(mock.calls).not.toContain("stampVisible");
  const result = mock.doc.layers.find((l: any) => l.name === "[SAMPS 结果] 合并蒙版");
  expect(result.kind).toBe("smartObject");
  expect([...result.mask]).toEqual([255, 255, 0, 0, 0, 0]);
  expect(mock.smart.visible).toBe(true);
});

test("several visible layers use stamp visible", async () => {
  const mock = photoshop();
  const base = { id: 50, name: "Background", visible: true, kind: "pixel" };
  mock.doc.layers.push(base);
  const snapshot = await mock.host.capture();
  await mock.host.output(snapshot, [instance], "layers");
  expect(mock.calls).toContain("stampVisible");
});

test("an exclude layer is read as a second plane and hidden while reading the image", async () => {
  const mock = photoshop();
  const exclude: any = { id: 9, name: "[SAMPS 排除] 涂抹要去掉的部分", visible: true, kind: "pixel",
    alpha: Uint8Array.of(0, 0, 0, 0, 90, 0) };
  mock.doc.layers.unshift(exclude);
  const snapshot = await mock.host.capture();
  expect([...snapshot.alpha]).toEqual([0, 200, 0, 0, 0, 0]);
  expect([...snapshot.exclude!]).toEqual([0, 0, 0, 0, 90, 0]);
  expect(exclude.visible).toBe(true);
});

test("preview replaces itself, restamps, and is removed by output", async () => {
  const mock = photoshop();
  const made: any[] = [];
  const batchPlay = mock.ps.action.batchPlay;
  mock.ps.action.batchPlay = async (commands: any[]) => {
    for (const c of commands) if (c._obj === "make" && c._target?.[0]?._ref === "contentLayer") {
      const layer = { id: 70 + made.length, name: c.using.name, visible: true, kind: "solidColor",
        delete() { mock.doc.layers.splice(mock.doc.layers.indexOf(layer), 1); } };
      mock.doc.layers.unshift(layer); made.push(layer);
      return [];
    }
    return batchPlay(commands);
  };
  const snapshot = await mock.host.capture();
  snapshot.stamp = await mock.host.showPreview(snapshot, [instance]);
  snapshot.stamp = await mock.host.showPreview(snapshot, [instance]);
  expect(mock.doc.layers.filter((l: any) => l.name.startsWith("[SAMPS 预览]"))).toHaveLength(1);
  await mock.host.output(snapshot, [instance], "selection");
  expect(mock.doc.layers.some((l: any) => l.name.startsWith("[SAMPS 预览]"))).toBe(false);
  expect([...mock.selection!]).toEqual([255, 255, 0, 0, 0, 0]);
});

test("marking layers live in one group, created on first use; loose layers are moved in", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any, placement: string) => {
    mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); mock.prompt.parent = target;
    expect(placement).toBe("placeInside");
  };
  await mock.host.beginMarking("add");
  const group = mock.doc.layers.find((l: any) => l.name.startsWith("[SAMPS 标记]"));
  expect(group.layers).toContain(mock.prompt);
  await mock.host.beginMarking("exclude");
  expect(group.layers.map((l: any) => l.name)).toEqual(["[SAMPS 排除] 涂抹要去掉的部分", mock.prompt.name]);
  expect(mock.calls.filter(c => c.startsWith("group:"))).toHaveLength(1);
  expect(mock.doc.activeLayers[0].name).toBe("[SAMPS 排除] 涂抹要去掉的部分");
});

test("the eraser targets the chosen marking layer without a manual layer switch", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); };
  await mock.host.beginMarking("exclude", "brush");
  await mock.host.beginMarking("add", "eraser");
  expect(mock.doc.activeLayers).toEqual([mock.prompt]);
  expect(mock.calls.at(-1)).toBe("tool:eraserTool");
  await mock.host.beginMarking("exclude", "eraser");
  expect(mock.doc.activeLayers[0].name).toContain("[SAMPS 排除]");
});

test("the marks group and preview can be shown and hidden, and recognition hides the marks", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); };
  expect(mock.host.visibility()).toEqual({ marks: null, preview: null });
  await mock.host.beginMarking("add");
  expect(mock.host.visibility().marks).toBe(true);
  await mock.host.setVisibility("marks", false);
  expect(mock.host.visibility().marks).toBe(false);
  await mock.host.setVisibility("marks", true);
  const snapshot = await mock.host.capture();
  await mock.host.showPreview(snapshot, [], { hideMarks: true });
  expect(mock.host.visibility().marks).toBe(false);
});

test("the preview is kept out of the marks group and stays visible when the marks are hidden", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); mock.prompt.parent = target; };
  await mock.host.beginMarking("add");
  mock.doc.activeLayers = [mock.doc.layers.find((l: any) => l.name.startsWith("[SAMPS 标记]"))];
  const group = mock.doc.layers.find((l: any) => l.name.startsWith("[SAMPS 标记]"));
  const batchPlay = mock.ps.action.batchPlay;
  mock.ps.action.batchPlay = async (commands: any[]) => {
    for (const c of commands) if (c._obj === "make" && c._target?.[0]?._ref === "contentLayer") {
      // Like Photoshop with an expanded group selected: the new layer lands inside the group.
      const parent = mock.doc.activeLayers[0]?.layers ? mock.doc.activeLayers[0] : null;
      const list = parent ? parent.layers : mock.doc.layers;
      const layer: any = { id: 90, name: c.using.name, visible: true, kind: "solidColor", parent };
      layer.delete = () => { const l = layer.parent ? layer.parent.layers : mock.doc.layers; l.splice(l.indexOf(layer), 1); };
      layer.move = (target: any, placement: string) => {
        expect(placement).toBe("placeBefore");
        layer.delete(); mock.doc.layers.splice(mock.doc.layers.indexOf(target), 0, layer); layer.parent = null;
      };
      list.unshift(layer);
      return [];
    }
    return batchPlay(commands);
  };
  const snapshot = await mock.host.capture();
  await mock.host.showPreview(snapshot, [instance], { hideMarks: true });
  expect(mock.doc.layers[0].name).toBe("[SAMPS 预览] 识别结果");
  expect(group.layers.some((l: any) => l.name.startsWith("[SAMPS 预览]"))).toBe(false);
  expect(mock.host.visibility()).toEqual({ marks: false, preview: true });
});

test("picking a brush or eraser on a hidden marks layer reveals the group and the layer", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); mock.prompt.parent = target; };
  await mock.host.beginMarking("add");
  await mock.host.setVisibility("marks", false);
  mock.prompt.visible = false;
  mock.doc.activeLayers = [mock.prompt];
  mock.ps.app.currentTool = { id: "moveTool" };
  expect(await mock.host.revealMarksForPainting()).toBe(false);  // not a painting tool
  mock.ps.app.currentTool = { id: "eraserTool" };
  expect(await mock.host.revealMarksForPainting()).toBe(true);
  expect(mock.host.visibility().marks).toBe(true);
  expect(mock.prompt.visible).toBe(true);
  expect(await mock.host.revealMarksForPainting()).toBe(false);  // already visible: no extra history step
  mock.doc.activeLayers = [mock.smart];
  await mock.host.setVisibility("marks", false);
  expect(await mock.host.revealMarksForPainting()).toBe(false);  // painting an image layer leaves marks hidden
});

test("hiding the marks after recognition moves the target off the marks layer", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); mock.prompt.parent = target; };
  await mock.host.beginMarking("add");
  const snapshot = await mock.host.capture();
  await mock.host.showPreview(snapshot, [], { hideMarks: true });
  expect(mock.doc.activeLayers).toEqual([mock.smart]);
});

test("expand and feather modify only the new mask before it is combined", async () => {
  const mock = photoshop({ selection: [0, 0, 0, 0, 0, 77] });
  const steps: string[] = [];
  const batchPlay = mock.ps.action.batchPlay;
  mock.ps.action.batchPlay = async (commands: any[]) => {
    const modify = commands.filter(c => ["expand", "contract", "feather"].includes(c._obj));
    if (!modify.length) return batchPlay(commands);
    expect([...mock.selection!]).toEqual([255, 255, 0, 0, 0, 0]);  // only the result, never the old selection
    for (const c of modify) steps.push(`${c._obj}:${(c.by || c.radius)._value}`);
    return [];
  };
  const snapshot = await mock.host.capture();
  await mock.host.output(snapshot, [instance], "selection", { mode: "add", expand: 2, feather: 1.5 });
  expect(steps).toEqual(["expand:2", "feather:1.5"]);
  expect([...mock.selection!]).toEqual([255, 255, 0, 0, 0, 77]);
  steps.length = 0;
  await mock.host.output({ ...snapshot, stamp: mock.host.stamp() }, [instance], "selection", { expand: -3 });
  expect(steps).toEqual(["contract:3"]);
});

test("writeback refuses stale history before creating anything", async () => {
  const mock = photoshop();
  const snapshot = await mock.host.capture();
  mock.doc.activeHistoryState = { id: 99 };
  await expect(mock.host.output(snapshot, [instance], "layers")).rejects.toMatchObject({ code: "DOCUMENT_CHANGED" });
  expect(mock.calls).not.toContain("stampVisible");
});

test("Photoshop 24.x without Selection.bounds / deselect() keeps the user's selection through batchPlay", async () => {
  const mock = photoshop({ ps24: true, selection: [0, 255, 255, 0, 0, 0] });
  const snapshot = await mock.host.capture();
  expect([...mock.selection!]).toEqual([0, 255, 255, 0, 0, 0]);
  expect(mock.calls).toContain("getSelectionDescriptor");
  await mock.host.output(snapshot, [instance], "selection", { mode: "add" });
  expect([...mock.selection!]).toEqual([255, 255, 255, 0, 0, 0]);
  await mock.host.output({ ...snapshot, stamp: mock.host.stamp() }, [instance], "selection", { mode: "subtract" });
  await mock.host.output({ ...snapshot, stamp: mock.host.stamp() }, [instance], "selection", { mode: "intersect" });
  mock.calls.length = 0;
  await mock.host.writeSelection(mock.doc, null);
  expect(mock.calls).toEqual(["deselect"]);
  expect(mock.selection).toBeNull();
});

test("showing the marks never reveals the user's own hidden layers", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); mock.prompt.parent = target; };
  const userLayer: any = { id: 40, name: "A", visible: false, kind: "pixel" };
  mock.doc.layers.splice(1, 0, userLayer);
  await mock.host.beginMarking("add");
  const group = mock.doc.layers.find((l: any) => l.name.startsWith("[SAMPS 标记]"));
  // Like Photoshop applying a visibility change to every selected layer.
  let groupVisible = group.visible;
  Object.defineProperty(group, "visible", { get: () => groupVisible, set(value: boolean) { groupVisible = value; userLayer.visible = value; } });
  await mock.host.setVisibility("marks", false);
  userLayer.visible = false;
  await mock.host.setVisibility("marks", true);
  expect(group.visible).toBe(true);
  expect(userLayer.visible).toBe(false);
  await mock.host.beginMarking("exclude");
  expect(userLayer.visible).toBe(false);
});

test("the marking brush is set to 50% opacity and the eraser to 100%, keeping other options", async () => {
  const mock = photoshop();
  mock.prompt.move = (target: any) => { mock.doc.layers.splice(mock.doc.layers.indexOf(mock.prompt), 1); target.layers.unshift(mock.prompt); };
  const options: any = { _obj: "currentToolOptions", opacity: 100, flow: 37, brush: { _obj: "computedBrush", diameter: 12 } };
  const sets: any[] = [];
  const batchPlay = mock.ps.action.batchPlay;
  mock.ps.action.batchPlay = async (commands: any[]) => {
    for (const c of commands) {
      if (c._obj === "get" && c._target?.[0]?._property === "currentToolOptions") return [{ currentToolOptions: { ...options } }];
      if (c._obj === "set" && c.to?._obj === "currentToolOptions") { sets.push(c); Object.assign(options, c.to); return [{}]; }
    }
    return batchPlay(commands);
  };
  await mock.host.beginMarking("add", "brush");
  expect(sets.at(-1)._target[0]._ref).toBe("paintbrushTool");
  expect(sets.at(-1).to).toMatchObject({ opacity: 50, flow: 37, brush: { diameter: 12 } });
  await mock.host.beginMarking("add", "brush");
  expect(sets).toHaveLength(1);  // already 50%: no redundant set
  await mock.host.beginMarking("add", "eraser");
  expect(sets.at(-1)).toMatchObject({ _target: [{ _ref: "eraserTool" }], to: { opacity: 100 } });
});

test("preview history steps are named for creating and removing the preview", async () => {
  const mock = photoshop();
  const names: string[] = [];
  const executeAsModal = mock.ps.core.executeAsModal;
  mock.ps.core.executeAsModal = (fn: any, options: any) => { names.push(options.commandName); return executeAsModal(fn, options); };
  const batchPlay = mock.ps.action.batchPlay;
  mock.ps.action.batchPlay = async (commands: any[]) => {
    for (const c of commands) if (c._obj === "make" && c._target?.[0]?._ref === "contentLayer") {
      const layer: any = { id: 80, name: c.using.name, visible: true, kind: "solidColor" };
      layer.delete = () => mock.doc.layers.splice(mock.doc.layers.indexOf(layer), 1);
      mock.doc.layers.unshift(layer);
      return [];
    }
    return batchPlay(commands);
  };
  const snapshot = await mock.host.capture();
  snapshot.stamp = await mock.host.showPreview(snapshot, [instance]);
  await mock.host.showPreview(snapshot, []);
  expect(names.slice(-2)).toEqual(["SAMPS 创建预览", "SAMPS 删除预览"]);
});

test("large-document selection reads skip strips without selected pixels", async () => {
  // 4 rows × 2 columns, read in 1-row strips at half size; only row 3 is selected.
  const W = 2, H = 4, plane = Uint8Array.of(0, 0, 0, 0, 0, 0, 200, 0);
  const regions: number[][] = [];
  const doc: any = { id: 1, width: W, height: H, selection: { bounds: { left: 0, top: 3, right: 1, bottom: 4 } } };
  const ps: any = { app: { documents: [doc], activeDocument: doc }, action: { batchPlay: async () => [] }, imaging: {
    async getSelection({ sourceBounds: b }: any) {
      regions.push([b.left, b.top, b.right, b.bottom]);
      const rows: number[] = [];
      for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) rows.push(plane[y * W + x]);
      if (!rows.some(v => v)) throw new Error("Invalid Source Bounds");
      return { sourceBounds: b, imageData: { width: b.right - b.left, height: b.bottom - b.top, components: 1, componentSize: 8,
        async getData() { return Uint8Array.from(rows); }, dispose() {} } };
    } } };
  const host = new PhotoshopHost(ps);
  const out = await host.readSelectionAt(doc, { width: 1, height: 2 });
  expect([...out]).toEqual([0, 200]);
  expect(regions.every(([, top]) => top >= 3)).toBe(true);  // rows above the selection are never requested
  // Without bounds every strip is tried, and empty ones are skipped instead of failing.
  doc.selection = {}; regions.length = 0;
  ps.action.batchPlay = async () => [{ selection: { _obj: "rectangle" } }];
  expect([...await host.readSelectionAt(doc, { width: 1, height: 2 })]).toEqual([0, 200]);
});
