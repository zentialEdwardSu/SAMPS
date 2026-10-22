import { SampsError } from "../core/errors";
import { assertDocument, assertFresh, isExclude, isMarks, isPreview, isPrompt, managed, stamp, walkLayers, workSize, EXCLUDE_PREFIX,
  MARKS_PREFIX, PREVIEW_PREFIX, PROMPT_PREFIX, RESULT_PREFIX, type MarkKind, type Stamp, type WorkSize } from "../core/document";

export type MarkTool = "brush" | "eraser";
// Tools that paint into the target layer's pixels; Photoshop refuses them on hidden layers.
const PAINT_TOOLS = new Set(["paintbrushTool", "pencilTool", "mixerBrushTool", "eraserTool", "backgroundEraserTool"]);
const MARKS_NAME = `${MARKS_PREFIX} 添加 / 排除`;
import { documentMask, expandGray, expandPixels, GrayMaxDownsampler, RgbaDownsampler, type MaskInstance } from "../core/pixels";
import { combineSelection, isEmpty, type SelectionMode } from "../core/selection";
import { labPixelsToRgba } from "../core/color";

type PS = any;
type Doc = any;
type Layer = any;

/**
 * `width` / `height` are the working size the model sees (the document size up to WORK_PIXELS,
 * smaller beyond); masks come back at this size and are scaled to the document for output.
 */
export interface Capture {
  rgba: Uint8Array; alpha: Uint8Array; exclude: Uint8Array | null; width: number; height: number; promptId: number;
  promptRead: Record<string, unknown>; captureMethod: string; stamp: Stamp;
}

// Brush colours for the two marking layers; any colour works, only layer alpha is read.
const MARK_COLORS: Record<MarkKind, [number, number, number]> = { add: [255, 120, 0], exclude: [0, 140, 255] };
const MARK_NAMES: Record<MarkKind, string> = { add: `${PROMPT_PREFIX} 涂抹要选的对象`, exclude: `${EXCLUDE_PREFIX} 涂抹要去掉的部分` };

const SRGB = "sRGB IEC61966-2.1";
// Bound each Imaging read so a 16-bit 100 MP composite is never held at once.
const STRIP_BYTES = 64 * 1024 * 1024;
const silent = { dialogOptions: "dontDisplay" };

export class PhotoshopHost {
  constructor(public ps: PS) {}

  get document(): Doc | null { return this.ps.app.documents.length ? this.ps.app.activeDocument : null; }
  stamp() { return stamp(this.document); }
  assertFresh(expected: Stamp) { assertFresh(this.document, expected); }

  async batchPlay(commands: object[]) {
    const results = await this.ps.action.batchPlay(commands, {});
    const failure = results.find((item: any) => item._obj === "error");
    if (failure) throw new SampsError(failure.result === -128 ? "CANCELLED" : "PHOTOSHOP_ACTION",
      failure.message || `Photoshop 操作失败（${failure.result}）。`);
    return results;
  }

  /** Runs `action` as one undoable history step, rolled back on failure. */
  async history<T>(doc: Doc, name: string, action: (context: any) => Promise<T>): Promise<T> {
    return this.ps.core.executeAsModal(async (context: any) => {
      const suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name });
      try {
        const value = await action(context);
        if (context.isCancelled) throw new SampsError("CANCELLED", "操作已取消。");
        await context.hostControl.resumeHistory(suspension, true);
        return value;
      } catch (error) {
        await context.hostControl.resumeHistory(suspension, false);
        throw error;
      }
    }, { commandName: name });
  }

  /**
   * Runs `action`, then puts back the visibility of every user (non-plugin) layer. Showing a
   * plugin layer must never reveal the user's own layers, which Photoshop can do when it applies
   * a visibility change to the selected layers rather than only the target.
   */
  private async keepUserVisibility<T>(doc: Doc, action: () => Promise<T>): Promise<T> {
    const user = walkLayers<Layer>(doc.layers).filter(layer => !managed(layer)).map(layer => ({ layer, visible: layer.visible }));
    try { return await action(); }
    finally {
      for (const { layer, visible } of user) {
        try { if (layer.visible !== visible) layer.visible = visible; } catch { /* layer deleted by the action */ }
      }
    }
  }

  /**
   * Sets the active tool's opacity, keeping its other options. Marks are read as "painted where
   * alpha > 0", so a 50% brush keeps the image visible without changing the prompt.
   */
  private async setToolOpacity(tool: string, percent: number) {
    const [result] = await this.batchPlay([{ _obj: "get", _target: [{ _property: "currentToolOptions" },
      { _ref: "application", _enum: "ordinal", _value: "targetEnum" }], _options: silent }]);
    const options = result?.currentToolOptions;
    if (!options || options.opacity === undefined) return;
    const current = options.opacity;
    const opacity = typeof current === "object" ? { ...current, _value: percent } : percent;
    if ((typeof current === "object" ? current._value : current) === percent) return;
    // Write the full options back: a partial descriptor can reset the brush preset.
    await this.batchPlay([{ _obj: "set", _target: [{ _ref: tool }],
      to: { ...options, _obj: "currentToolOptions", opacity }, _options: silent }]);
  }

  promptLayers(doc: Doc, kind: MarkKind = "add"): Layer[] {
    return walkLayers<Layer>(doc.layers).filter(kind === "add" ? isPrompt : isExclude);
  }
  activePrompt(doc: Doc, kind: MarkKind = "add"): Layer | undefined {
    const prompts = this.promptLayers(doc, kind);
    return prompts.find(item => doc.activeLayers.some((active: Layer) => active.id === item.id)) || prompts[0];
  }
  marksGroup(doc: Doc): Layer | undefined { return walkLayers<Layer>(doc.layers).find(isMarks); }

  /** Returns the marks group, creating it and moving any loose add/exclude layers into it. */
  private async ensureMarksGroup(doc: Doc): Promise<Layer> {
    let group = this.marksGroup(doc);
    if (!group) {
      group = await doc.createLayerGroup({ name: MARKS_NAME });
      if (!group) throw new SampsError("PHOTOSHOP_ACTION", "Photoshop 未能创建标记图层组。");
    }
    for (const layer of [...this.promptLayers(doc, "add"), ...this.promptLayers(doc, "exclude")])
      if (!layer.parent || layer.parent.id !== group.id) layer.move(group, this.placeInside());
    return group;
  }
  private placeInside() { return this.ps.constants?.ElementPlacement?.PLACEINSIDE ?? "placeInside"; }
  private placeBefore() { return this.ps.constants?.ElementPlacement?.PLACEBEFORE ?? "placeBefore"; }

  /**
   * Activates (creating if needed) the add or exclude layer inside the marks group, shows the
   * group, and picks the brush in that layer's colour or the eraser. Switching kind or tool
   * always re-targets the matching layer, so the eraser never needs a manual layer switch.
   */
  async beginMarking(kind: MarkKind = "add", tool: MarkTool = "brush") {
    const doc = this.document; assertDocument(doc);
    return this.history(doc, kind === "add" ? "SAMPS 标记添加" : "SAMPS 标记排除", () => this.keepUserVisibility(doc, async () => {
      const group = await this.ensureMarksGroup(doc);
      group.visible = true;
      let layer = this.activePrompt(doc, kind);
      if (!layer) {
        layer = await doc.createLayer({ name: MARK_NAMES[kind] });
        layer.move(group, this.placeInside());
      }
      layer.visible = true;
      doc.activeLayers = [layer];
      doc.activeChannels = doc.componentChannels;
      await this.deselect(doc);
      const toolRef = tool === "brush" ? "paintbrushTool" : "eraserTool";
      await this.batchPlay([{ _obj: "select", _target: [{ _ref: toolRef }], _options: silent }]);
      // A 50% brush keeps the image readable under the marks; the eraser must erase fully, or
      // faint leftovers would still count as painted.
      try { await this.setToolOpacity(toolRef, tool === "brush" ? 50 : 100); } catch { /* opacity is only a convenience */ }
      if (tool === "brush") {
        const [red, grain, blue] = MARK_COLORS[kind];
        try {
          await this.batchPlay([{ _obj: "set", _target: [{ _ref: "color", _property: "foregroundColor" }],
            to: { _obj: "RGBColor", red, grain, blue }, _options: silent }]);
        } catch { /* the colour is only a visual cue */ }
      }
      return layer.id;
    }));
  }

  /**
   * Called on Photoshop "select" events. When a painting tool (brush, pencil, eraser) is active
   * and the target layer is an add/exclude layer that is hidden, or sits in the hidden marks
   * group, shows it so the stroke is not refused with "target layer is hidden". Returns true
   * when it changed visibility.
   */
  async revealMarksForPainting(): Promise<boolean> {
    const doc = this.document;
    if (!doc) return false;
    let tool = "";
    try { tool = String(this.ps.app.currentTool?.id || ""); } catch { return false; }
    if (!PAINT_TOOLS.has(tool)) return false;
    const active = Array.from(doc.activeLayers as Layer[]);
    const target = active.find(layer => isPrompt(layer) || isExclude(layer));
    if (!target) return false;
    const group = this.marksGroup(doc);
    if (target.visible && (!group || group.visible)) return false;
    await this.history(doc, "SAMPS 显示标记", () => this.keepUserVisibility(doc, async () => {
      if (group) group.visible = true;
      target.visible = true;
    }));
    return true;
  }

  /** Current visibility of the marks group and the preview overlay; null when absent. */
  visibility(): { marks: boolean | null; preview: boolean | null } {
    const doc = this.document;
    if (!doc) return { marks: null, preview: null };
    const layers = walkLayers<Layer>(doc.layers);
    const group = layers.find(isMarks), preview = layers.find(isPreview);
    return { marks: group ? group.visible : null, preview: preview ? preview.visible : null };
  }

  /** Shows or hides the marks group or the preview overlay in one history step; returns the new stamp. */
  async setVisibility(target: "marks" | "preview", visible: boolean): Promise<Stamp | null> {
    const doc = this.document; assertDocument(doc);
    const layers = walkLayers<Layer>(doc.layers).filter(target === "marks" ? isMarks : isPreview);
    if (!layers.length) return null;
    const label = target === "marks" ? "标记" : "预览";
    await this.history(doc, `SAMPS ${visible ? "显示" : "隐藏"}${label}`, () => this.keepUserVisibility(doc, async () => {
      for (const layer of layers) layer.visible = visible;
      // Showing the group must also show its marking layers, or the eye button looks broken.
      if (visible && target === "marks")
        for (const layer of [...this.promptLayers(doc, "add"), ...this.promptLayers(doc, "exclude")]) layer.visible = true;
    }));
    return this.stamp();
  }

  /** Clears every add/exclude layer's pixels and the preview in one history step, keeping the layers and the selection. */
  async clearPrompt() {
    const doc = this.document; assertDocument(doc);
    const prompts = [...this.promptLayers(doc, "add"), ...this.promptLayers(doc, "exclude")];
    const previews = walkLayers<Layer>(doc.layers).filter(isPreview);
    if (!prompts.length && !previews.length) return false;
    await this.history(doc, "SAMPS 清空涂抹", async () => {
      const saved = await this.readSelection(doc);
      const active = Array.from(doc.activeLayers).filter((layer: any) => !isPreview(layer));
      for (const layer of previews) layer.delete();
      for (const layer of prompts) {
        doc.activeLayers = [layer];
        await this.batchPlay([
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" }, _options: silent },
          { _obj: "delete", _options: silent }
        ]);
      }
      await this.restoreSelection(doc, saved);
      if (active.length) doc.activeLayers = active;
    });
    return true;
  }

  // ── Selection helpers ────────────────────────────────────────────────

  /**
   * True when the document has an active selection. Selection.bounds needs Photoshop 25.0;
   * on 24.x the document's selection descriptor is read instead (absent when nothing is selected).
   */
  async hasSelection(doc: Doc): Promise<boolean> {
    const bounds = doc.selection?.bounds;
    if (bounds !== undefined) return !!bounds;
    try {
      const [result] = await this.batchPlay([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }],
        _options: silent }]);
      return !!(result && result.selection);
    } catch { return false; }
  }

  /** Selection.deselect() needs Photoshop 25.0; older hosts set the selection to none. */
  async deselect(doc: Doc) {
    if (typeof doc.selection?.deselect === "function") { await doc.selection.deselect(); return; }
    await this.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
      to: { _enum: "ordinal", _value: "none" }, _options: silent }]);
  }

  /** Full-canvas 8-bit selection, or null when nothing is selected. Mode and bit depth independent. */
  async readSelection(doc: Doc): Promise<Uint8Array | null> {
    if (!(await this.hasSelection(doc))) return null;
    const result = await this.ps.imaging.getSelection({ documentID: doc.id,
      sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height } });
    try {
      const data = await result.imageData.getData({ chunky: true });
      return expandGray(data, result.imageData, result.sourceBounds, doc.width, doc.height);
    } finally { result.imageData.dispose(); }
  }

  async writeSelection(doc: Doc, mask: Uint8Array | null) {
    if (!mask || isEmpty(mask)) { await this.deselect(doc); return; }
    const gray = await this.grayImage(mask, doc.width, doc.height);
    try { await this.ps.imaging.putSelection({ documentID: doc.id, imageData: gray, replace: true }); }
    finally { gray.dispose(); }
  }

  restoreSelection(doc: Doc, saved: Uint8Array | null) { return this.writeSelection(doc, saved); }

  grayImage(mask: Uint8Array, width: number, height: number) {
    return this.ps.imaging.createImageDataFromBuffer(mask, { width, height, components: 1,
      chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
  }

  // ── Capture ──────────────────────────────────────────────────────────

  /**
   * Reads the prompt as layer transparency through the selection channel (Ctrl-click on
   * the layer thumbnail). The selection is a document-level gray plane, so this works for
   * any color mode, bit depth or smart-object content without rendering the layer.
   */
  async readPromptAlpha(doc: Doc, prompt: Layer, work: WorkSize = { width: doc.width, height: doc.height }): Promise<Uint8Array> {
    await this.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
      to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: prompt.id }] },
      _options: silent }]);
    return this.readSelectionAt(doc, work);
  }

  /**
   * The selection at working size. Large documents are read in strips and reduced by maximum,
   * so a full-resolution plane is never held and thin strokes are kept.
   */
  async readSelectionAt(doc: Doc, work: WorkSize): Promise<Uint8Array> {
    if (work.width === doc.width && work.height === doc.height)
      return (await this.readSelection(doc)) || new Uint8Array(doc.width * doc.height);
    if (!(await this.hasSelection(doc))) return new Uint8Array(work.width * work.height);
    const sampler = new GrayMaxDownsampler(doc.width, doc.height, work.width, work.height);
    // Photoshop rejects a selection read whose region holds no selected pixels ("Invalid Source
    // Bounds"), so only strips inside the selection's bounds are read.
    const area = (await this.selectionBounds(doc)) || { left: 0, top: 0, right: doc.width, bottom: doc.height };
    const rows = Math.max(1, Math.min(doc.height, Math.floor(STRIP_BYTES / doc.width)));
    for (let top = area.top; top < area.bottom; top += rows) {
      const bottom = Math.min(area.bottom, top + rows);
      let result;
      try {
        result = await this.ps.imaging.getSelection({ documentID: doc.id,
          sourceBounds: { left: area.left, top, right: area.right, bottom } });
      } catch (error) {
        if (/source bounds/i.test(String((error as Error)?.message || error))) continue;  // empty strip
        throw error;
      }
      try {
        const data = await result.imageData.getData({ chunky: true });
        const bounds = { left: result.sourceBounds.left, top: result.sourceBounds.top - top };
        sampler.push(expandGray(data, result.imageData, bounds, doc.width, bottom - top), top, bottom - top);
      } finally { result.imageData.dispose(); }
    }
    return sampler.output;
  }

  /** Integer bounds of the current selection clamped to the canvas, or null when unknown or empty. */
  async selectionBounds(doc: Doc): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
    const value = (v: any) => Number(typeof v === "object" && v !== null ? v._value : v);
    let raw: any = doc.selection?.bounds;
    if (raw === undefined) {
      try {
        const [result] = await this.batchPlay([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }],
          _options: silent }]);
        raw = result?.selection;
      } catch { return null; }
    }
    if (!raw) return null;
    const left = Math.max(0, Math.floor(value(raw.left))), top = Math.max(0, Math.floor(value(raw.top)));
    const right = Math.min(doc.width, Math.ceil(value(raw.right))), bottom = Math.min(doc.height, Math.ceil(value(raw.bottom)));
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  /**
   * Reads the visible composite as 8-bit sRGB RGBA. Photoshop's own color engine performs
   * the mode/profile conversion; 16-bit documents are read at 16 bits and dithered here.
   * Falls back to native Lab samples converted in JS if the host rejects an RGB conversion.
   */
  async readComposite(doc: Doc, record: Record<string, unknown>,
    work: WorkSize = { width: doc.width, height: doc.height }): Promise<Uint8Array> {
    const size = doc.bitsPerChannel === "bitDepth16" ? 16 : 8;
    try {
      const rgba = await this.readStrips(doc, { colorSpace: "RGB", colorProfile: SRGB, componentSize: size }, null, work);
      record.compositeRead = size === 16 ? "photoshop-rgb16-dither" : "photoshop-rgb8";
      return rgba;
    } catch (error) {
      if (doc.mode !== "labColorMode") throw error;
      record.rgbReadError = String((error as Error).message || error);
      const rgba = await this.readStrips(doc, { componentSize: size },
        (data, info) => labPixelsToRgba(data, info.components, size as 8 | 16), work);
      record.compositeRead = "lab-native-js-convert";
      return rgba;
    }
  }

  /**
   * Reads the composite in horizontal strips into an 8-bit RGBA buffer at working size
   * (box-averaged when smaller than the document). `convert` turns non-RGB samples into
   * 8-bit RGBA; when null, samples are RGB(A).
   */
  private async readStrips(doc: Doc, format: object,
    convert: ((data: any, info: any) => Uint8Array) | null, work: WorkSize): Promise<Uint8Array> {
    const scaled = work.width !== doc.width || work.height !== doc.height;
    const sampler = scaled ? new RgbaDownsampler(doc.width, doc.height, work.width, work.height) : null;
    const out = sampler ? sampler.output : new Uint8Array(doc.width * doc.height * 4);
    const rows = Math.max(1, Math.min(doc.height, Math.floor(STRIP_BYTES / (doc.width * 8))));
    for (let top = 0; top < doc.height; top += rows) {
      const bottom = Math.min(doc.height, top + rows);
      const pixels = await this.ps.imaging.getPixels({ documentID: doc.id,
        sourceBounds: { left: 0, top, right: doc.width, bottom }, applyAlpha: false, ...format });
      try {
        if (pixels.level !== undefined && pixels.level !== 0) throw new SampsError("PIXEL_LEVEL", "读取到了缩略缓存，请重新读取完整画布。");
        let data = await pixels.imageData.getData({ chunky: true });
        let info = pixels.imageData;
        if (convert) { data = convert(data, info); info = { width: info.width, height: info.height, components: 4, componentSize: 8 }; }
        // Imaging trims fully transparent margins; position the returned block inside this strip.
        const bounds = { left: pixels.sourceBounds.left, top: pixels.sourceBounds.top - top };
        const strip = expandPixels(data, info, bounds, doc.width, bottom - top);
        if (sampler) sampler.push(strip, top, bottom - top);
        else out.set(strip, top * doc.width * 4);
      } finally { pixels.imageData.dispose(); }
    }
    return sampler ? sampler.finish() : out;
  }

  async capture(): Promise<Capture> {
    const doc = this.document; assertDocument(doc);
    const before = stamp(doc);
    const captured = await this.ps.core.executeAsModal(async (context: any) => {
      this.assertFresh(before);
      if (context.isCancelled) throw new SampsError("CANCELLED", "操作已取消。");
      const layers = walkLayers<Layer>(doc.layers);
      const prompt = this.activePrompt(doc);
      if (!prompt) throw new SampsError("NO_PROMPT_LAYER", "请先点击“开始标记”，再在提示图层上涂抹。");
      const visibility = layers.filter(managed).map(layer => ({ layer, visible: layer.visible }));
      const work = workSize(doc.width, doc.height);
      const record: Record<string, unknown> = { layerId: prompt.id, layerName: prompt.name, mode: doc.mode,
        depth: doc.bitsPerChannel, profile: doc.colorProfileName, readMethod: "transparency-selection",
        documentSize: [doc.width, doc.height], workSize: [work.width, work.height] };
      const suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name: "SAMPS 读取画面" });
      let failure: unknown = null, result: Omit<Capture, "stamp"> | undefined, stage = "备份当前选区";
      let saved: Uint8Array | null = null, selectionTouched = false;
      try {
        saved = await this.readSelection(doc);
        stage = "读取提示图层透明度";
        selectionTouched = true;
        const alpha = await this.readPromptAlpha(doc, prompt, work);
        let exclude: Uint8Array | null = null;
        const excludeLayer = this.activePrompt(doc, "exclude");
        if (excludeLayer && excludeLayer.visible) {
          stage = "读取排除图层透明度";
          exclude = await this.readPromptAlpha(doc, excludeLayer, work);
          if (!exclude.some(value => value > 0)) exclude = null;
          record.excludeLayerId = excludeLayer.id;
        }
        stage = "恢复当前选区";
        await this.restoreSelection(doc, saved); selectionTouched = false;
        if (!alpha.some(value => value > 0)) throw new SampsError("EMPTY_PROMPT", "提示图层为空，请用画笔标记目标。");
        stage = "临时隐藏插件图层";
        for (const { layer, visible } of visibility) if (visible) layer.visible = false;
        stage = "读取原图合成像素";
        const rgba = await this.readComposite(doc, record, work);
        if (context.isCancelled) throw new SampsError("CANCELLED", "操作已取消。");
        result = { rgba, alpha, exclude, width: work.width, height: work.height, promptId: prompt.id, promptRead: record,
          captureMethod: String(record.compositeRead) };
      } catch (error) {
        failure = error instanceof SampsError ? error : new SampsError("CAPTURE_FAILED", `${stage}失败：${(error as Error).message || error}`);
      }
      // Restore explicitly rather than rolling history back; a rollback can force Photoshop
      // to refresh smart-object files even though we only read pixels.
      if (selectionTouched) {
        try { await this.restoreSelection(doc, saved); }
        catch (error) { failure = failure || new SampsError("CAPTURE_RESTORE", `恢复选区失败：${(error as Error).message || error}`); }
      }
      for (const { layer, visible } of visibility) {
        try { if (layer.visible !== visible) layer.visible = visible; }
        catch (error) { failure = failure || new SampsError("CAPTURE_RESTORE", `恢复插件图层可见性失败：${(error as Error).message || error}`); }
      }
      try { await context.hostControl.resumeHistory(suspension, true); }
      catch (error) { failure = failure || new SampsError("CAPTURE_HISTORY", `结束读取事务失败：${(error as Error).message || error}`); }
      if (!failure && context.isCancelled) failure = new SampsError("CANCELLED", "操作已取消。");
      if (failure) throw failure;
      return result!;
    }, { commandName: "SAMPS 读取画面" });
    const after = stamp(this.document);
    if (after.documentId !== before.documentId || after.width !== before.width || after.height !== before.height) {
      throw new SampsError("DOCUMENT_CHANGED", "文档已切换或尺寸已修改，请重新识别。");
    }
    // The read transaction may add a history state; stamp after it so we don't invalidate ourselves.
    return { ...captured, stamp: after };
  }

  async promptPreview(diagnostics: Record<string, any>) {
    const { grid, gridWidth: width = 0, gridHeight: height = 0 } = diagnostics;
    if (!grid || grid.length !== width * height) return null;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < grid.length; i++) rgb.fill(grid[i] === "1" ? 255 : 0, i * 3, i * 3 + 3);
    const image = await this.ps.imaging.createImageDataFromBuffer(rgb, {
      width, height, components: 3, chunky: true, colorSpace: "RGB", colorProfile: SRGB });
    try { return "data:image/jpeg;base64," + await this.ps.imaging.encodeImageData({ imageData: image, base64: true }); }
    finally { image.dispose(); }
  }

  // ── Preview ──────────────────────────────────────────────────────────

  /**
   * Shows the chosen instances as a 50% red overlay, like Quick Mask: a solid-colour fill layer
   * masked by the result. Fill layers work in every colour mode and bit depth. Replaces any
   * earlier preview; an empty list only removes it. `hideMarks` also hides the add/exclude
   * group in the same history step so the result is not covered by strokes.
   * Returns the stamp after the change.
   */
  async showPreview(snapshot: Capture, instances: MaskInstance[], options: { hideMarks?: boolean } = {}): Promise<Stamp> {
    this.assertFresh(snapshot.stamp);
    const doc = this.document;
    const previews = walkLayers<Layer>(doc.layers).filter(isPreview);
    const group = options.hideMarks ? this.marksGroup(doc) : undefined;
    if (!instances.length && !previews.length && !(group && group.visible)) return snapshot.stamp;
    await this.history(doc, instances.length ? "SAMPS 创建预览" : "SAMPS 删除预览", () => this.keepUserVisibility(doc, async () => {
      this.assertFresh(snapshot.stamp);
      if (group) group.visible = false;
      const saved = await this.readSelection(doc);
      const active = Array.from(doc.activeLayers).filter((layer: any) => !isPreview(layer));
      for (const layer of previews) layer.delete();
      if (instances.length) {
        await this.writeSelection(doc, documentMask(instances, snapshot, doc));
        doc.activeLayers = [doc.layers[0]];
        // A fill layer made with an active selection is masked to it.
        await this.batchPlay([{ _obj: "make", _target: [{ _ref: "contentLayer" }], using: { _obj: "contentLayer",
          name: `${PREVIEW_PREFIX} 识别结果`, opacity: { _unit: "percentUnit", _value: 50 },
          type: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: 255, grain: 30, blue: 30 } } },
          _options: silent }]);
        // Photoshop creates the layer inside the active group when it is expanded (the marks group
        // is usually on top). Keep the preview at the top level, above everything, so hiding the
        // marks group never hides the preview.
        const preview = walkLayers<Layer>(doc.layers).find(isPreview);
        const top = doc.layers[0];
        if (preview && top && top.id !== preview.id) preview.move(top, this.placeBefore());
      }
      await this.restoreSelection(doc, saved);
      // With the marks hidden, leave a marks layer as the target and the next brush stroke would
      // reveal them again; target the topmost image layer instead.
      const image = group ? walkLayers<Layer>(doc.layers).find(layer => !managed(layer) && !layer.layers) : undefined;
      if (image) doc.activeLayers = [image];
      else if (active.length) doc.activeLayers = active;
    }));
    return this.stamp();
  }

  // ── Output ───────────────────────────────────────────────────────────

  /** Expands (or contracts) and feathers a mask with Photoshop's own Select ▸ Modify commands. */
  private async modifyMask(doc: Doc, mask: Uint8Array, expand: number, feather: number): Promise<Uint8Array> {
    await this.writeSelection(doc, mask);
    const pixels = (value: number) => ({ _unit: "pixelsUnit", _value: value });
    const steps: object[] = [];
    if (expand) steps.push({ _obj: expand > 0 ? "expand" : "contract", by: pixels(Math.min(500, Math.abs(expand))),
      selectionModifyEffectAtCanvasBounds: false, _options: silent });
    if (feather) steps.push({ _obj: "feather", radius: pixels(feather), selectionModifyEffectAtCanvasBounds: false,
      _options: silent });
    if (await this.hasSelection(doc)) await this.batchPlay(steps);
    return (await this.readSelection(doc)) || new Uint8Array(doc.width * doc.height);
  }

  /**
   * Returns a new layer holding the visible image, placed above the topmost visible layer.
   * Photoshop's "stamp visible" (mergeVisible + duplicate) is unavailable when only one
   * layer is visible, which is the usual case for a RAW import, so a single visible layer
   * (pixel, smart object or group) is duplicated instead. Plugin layers must already be hidden.
   */
  async stampVisible(doc: Doc): Promise<Layer> {
    const visible = Array.from(doc.layers as Layer[]).filter(layer => layer.visible && !managed(layer));
    if (!visible.length) throw new SampsError("NO_VISIBLE_LAYER", "没有可见的图像图层可用于生成蒙版图层。");
    if (visible.length === 1) {
      const copy = await visible[0].duplicate();
      if (!copy) throw new SampsError("PHOTOSHOP_ACTION", "Photoshop 未能复制可见图层。");
      copy.visible = true;
      return copy;
    }
    doc.activeLayers = [visible[0]];
    await this.batchPlay([{ _obj: "mergeVisible", duplicate: true, _options: silent }]);
    return doc.activeLayers[0];
  }

  /**
   * Writes a selection, or stamps the visible composite into new layers masked by each
   * result. Everything stays in the document's own mode, depth and profile: pixels come
   * from Photoshop's "stamp visible", masks from the selection channel.
   */
  async output(snapshot: Capture, instances: MaskInstance[], kind: "selection" | "layers",
    options: { separate?: boolean; mode?: SelectionMode; expand?: number; feather?: number } = {}) {
    if (!instances.length) throw new SampsError("NO_SELECTION", "请至少勾选一个实例。");
    this.assertFresh(snapshot.stamp);
    const doc = this.document;
    const mode = options.mode || "new";
    return this.history(doc, kind === "selection" ? "SAMPS 生成选区" : "SAMPS 生成蒙版图层", async context => {
      this.assertFresh(snapshot.stamp); // Recheck after acquiring the modal lock.
      for (const layer of walkLayers<Layer>(doc.layers).filter(isPreview)) layer.delete();
      const current = await this.readSelection(doc);
      if (kind === "selection") {
        let mask = documentMask(instances, snapshot, doc);
        const expand = Math.round(options.expand || 0), feather = Math.max(0, options.feather || 0);
        // Modify the new mask on its own, then combine: expand/feather must not touch the existing selection.
        if (expand || feather) mask = await this.modifyMask(doc, mask, expand, feather);
        await this.writeSelection(doc, combineSelection(mode, current, mask));
      } else {
        const groups = options.separate ? instances.map(item => [item]) : [instances];
        const layers = walkLayers<Layer>(doc.layers);
        const visibility = layers.filter(managed).map(layer => ({ layer, visible: layer.visible }));
        for (const { layer } of visibility) layer.visible = false;
        const created: Layer[] = [];
        try {
          for (let i = 0; i < groups.length; i++) {
            if (context.isCancelled) throw new SampsError("CANCELLED", "操作已取消。");
            const layer = await this.stampVisible(doc);
            doc.activeLayers = [layer];
            layer.name = `${RESULT_PREFIX} ${options.separate ? `实例 ${i + 1}` : "合并蒙版"}`;
            await this.writeSelection(doc, documentMask(groups[i], snapshot, doc));
            await this.batchPlay([{ _obj: "make", new: { _class: "channel" },
              at: { _ref: "channel", _enum: "channel", _value: "mask" },
              using: { _enum: "userMaskEnabled", _value: "revealSelection" }, _options: silent }]);
            // Keep earlier results out of the next stamp-visible.
            layer.visible = false;
            created.push(layer);
          }
        } finally {
          for (const { layer, visible } of visibility) layer.visible = visible;
          for (const layer of created) layer.visible = true;
        }
        await this.restoreSelection(doc, current);
        if (created.length) doc.activeLayers = created;
      }
      const prompt = walkLayers<Layer>(doc.layers).find(layer => layer.id === snapshot.promptId);
      if (prompt) prompt.visible = false;
    });
  }
}
