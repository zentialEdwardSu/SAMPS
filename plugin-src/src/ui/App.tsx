import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { initialState, reducer } from "./state";
import { MODELS, modelById } from "./models";
import { ActionButton, Button, Checkbox, IconLabel, Picker, Section, SegmentedSwitch, Slider } from "./spectrum";
import { SelectionDialog, type SelectionDialogHandle } from "./SelectionDialog";
import { describeSettings, loadSelectionSettings, saveSelectionSettings, type SelectionSettings } from "../core/settings";
import { BrushIcon, ClearIcon, EraserIcon, EyeIcon, FolderIcon, InfoIcon, SelectionIcon, Swatch } from "./icons";
import { SELECTION_MODES, modeFromModifiers } from "../core/selection";
import { SampsError, describe } from "../core/errors";
import type { PhotoshopHost, Capture, MarkTool } from "../host/PhotoshopHost";
import type { MarkKind, Stamp } from "../core/document";
import type { NativeEngine, PromptDiagnostics } from "../host/NativeEngine";

export interface Services {
  host: PhotoshopHost;
  loadEngine: () => Promise<NativeEngine>;
  modelFolder: (folder: string) => Promise<{ nativePath: string } | null>;
  pickFolder: () => Promise<{ nativePath: string } | null>;
  /** Subscribes to Photoshop document/history events; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

function sameImage(a: Capture | undefined, b: Capture) {
  if (!a || a.stamp.documentId !== b.stamp.documentId || a.width !== b.width || a.height !== b.height || a.rgba.length !== b.rgba.length) return false;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  return true;
}

export function App({ services }: { services: Services }) {
  const { host } = services;
  const [state, dispatch] = useReducer(reducer, initialState);
  const engine = useRef<NativeEngine | null>(null);
  const cache = useRef<{ sessionId: number; snapshot: Capture } | null>(null);
  const cancelled = useRef(false);
  const busy = useRef(false);
  const live = useRef(state); live.current = state;
  // Latest stamp the plugin itself produced (preview / output), so its own history states do not read as edits.
  const stampRef = useRef<Stamp | null>(null);
  const selectionDialog = useRef<SelectionDialogHandle>(null);
  const dialogOpen = useRef(false);
  const choice = modelById(state.modelId);

  const status = (text: string, error = false) => dispatch({ type: "status", text, error });
  const checkCancelled = () => { if (cancelled.current) throw new SampsError("CANCELLED", "任务已取消。"); };

  const action = useCallback(async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; cancelled.current = false; dispatch({ type: "busy", busy: true });
    try { await work(); }
    catch (error: any) {
      status(describe(error), error?.code !== "CANCELLED");
      console.error("SAMPS action:", error);
    } finally { busy.current = false; dispatch({ type: "busy", busy: false }); }
  }, []);

  // ── Document tracking (event driven) ──
  const refresh = useCallback(() => {
    let doc: any = null;
    try { doc = host.document; } catch { /* document may be closing */ }
    dispatch({ type: "document", present: Boolean(doc),
      label: doc ? `${doc.title || doc.name} · ${doc.width}×${doc.height}` : "打开图像后开始标记" });
    try { dispatch({ type: "layers", layers: host.visibility() }); } catch { /* document may be closing */ }
    const snapshot = live.current.snapshot;
    if (snapshot && !busy.current) {
      try { host.assertFresh(snapshot.stamp); }
      catch { dispatch({ type: "clearResults" }); status("文档已改变，请重新识别。"); }
    }
  }, [host]);
  useEffect(() => { refresh(); return services.subscribe(refresh); }, [services, refresh]);

  // ── Model loading ──
  const loadModel = useCallback(async (folder: { nativePath: string } | null, device: number) => {
    if (!engine.current) return;
    cache.current = null; dispatch({ type: "clearResults" });
    if (!folder) { dispatch({ type: "modelStatus", text: "未找到该模型，请选择模型目录。", model: null }); return; }
    dispatch({ type: "modelStatus", text: "正在加载离线模型…", model: null });
    const info = await engine.current.initialize(folder.nativePath, device, true);
    const trial = info.validationPassed === false ? " · 试用未验证" : "";
    dispatch({ type: "modelStatus", model: info,
      text: `${info.modelName} · ${info.deviceName} · ${info.precision === "fp32" ? "FP32" : "FP16"}${trial}` });
    status("模型已就绪。点击画笔开始标记。");
  }, []);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try { engine.current = await services.loadEngine(); }
      catch (error: any) {
        const text = String(error?.message).includes("Module not found")
          ? "请在 UDT 先 Unload 再 Load 本插件以读取新的原生模块配置。" : `原生模块加载失败：${describe(error)}`;
        if (!disposed) { dispatch({ type: "modelStatus", text }); status(text, true); }
        return;
      }
      if (!disposed) await action(async () => loadModel(await services.modelFolder(choice.folder), live.current.device));
    })();
    return () => { disposed = true; cancelled.current = true; engine.current?.cancel(); cache.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeModel = (id: string) => {
    // GPU-only bundles refuse the CPU provider; switch the device back to GPU for them.
    const device = modelById(id).gpuOnly ? -2 : state.device;
    dispatch({ type: "set", patch: { modelId: id, device } });
    action(async () => loadModel(await services.modelFolder(modelById(id).folder), device));
  };
  const changeDevice = (value: string) => {
    const device = Number(value);
    dispatch({ type: "set", patch: { device } });
    action(async () => loadModel(await services.modelFolder(choice.folder), device));
  };
  const browseModel = () => action(async () => { const folder = await services.pickFolder(); if (folder) await loadModel(folder, state.device); });

  // ── Prompt tools ──
  // Picking add/exclude or brush/eraser always targets the matching layer, so no manual layer switching.
  const mark = (kind: MarkKind, tool: MarkTool) => action(async () => {
    dispatch({ type: "set", patch: { markKind: kind, markTool: tool } });
    await host.beginMarking(kind, tool);
    dispatch({ type: "layers", layers: host.visibility() });
    const what = kind === "add" ? "添加层（橙色）" : "排除层（蓝色）";
    status(tool === "eraser" ? `橡皮擦：正在擦除${what}的涂抹。`
      : kind === "add" ? "添加画笔：涂抹要选的对象，配饰（包、帽子、首饰）也涂上，然后点击“识别”。"
      : "排除画笔：涂抹不要的部分（旁边的人、背景），然后重新识别。");
  });
  const toggleLayer = (target: "marks" | "preview") => action(async () => {
    const current = host.visibility()[target];
    if (current === null) return;
    const next = await host.setVisibility(target, !current);
    if (next) { stampRef.current = next; dispatch({ type: "restamp", stamp: next }); }
    dispatch({ type: "layers", layers: host.visibility() });
  });
  const clearPrompt = () => action(async () => {
    const cleared = await host.clearPrompt();
    dispatch({ type: "layers", layers: host.visibility() });
    dispatch({ type: "clearResults" }); dispatch({ type: "diagnostics", diagnostics: null, preview: null });
    status(cleared ? "涂抹已清空，可重新标记（可撤销）。" : "当前文档还没有提示图层。");
  });

  // ── Recognition ──
  const recognize = () => action(async () => {
    const e = engine.current;
    if (!e || !state.model) throw new SampsError("NO_MODEL", "模型尚未就绪。");
    dispatch({ type: "clearResults" }); dispatch({ type: "diagnostics", diagnostics: null, preview: null });
    status("正在读取可见画面和涂抹…");
    const captured = await host.capture(); checkCancelled();
    if (!cache.current || !sameImage(cache.current.snapshot, captured)) {
      cache.current = null; status("正在计算图像特征…");
      const prepared = await e.prepareImage(captured.rgba, { width: captured.width, height: captured.height });
      checkCancelled(); host.assertFresh(captured.stamp);
      cache.current = { sessionId: prepared.sessionId, snapshot: captured };
    } else captured.rgba = cache.current.snapshot.rgba;
    status("正在根据涂抹分割…");
    let found;
    try {
      found = await e.segment(cache.current.sessionId, captured.alpha, { confidence: state.confidence, mode: state.mode, detail: state.detail },
        captured.exclude);
    }
    finally {
      const diagnostics: PromptDiagnostics | null = e.lastPromptDiagnostics ? { ...e.lastPromptDiagnostics, capture: captured.promptRead } : null;
      let preview: string | null = null;
      try { if (diagnostics) preview = await host.promptPreview(diagnostics); } catch (error) { console.warn("SAMPS preview:", error); }
      dispatch({ type: "diagnostics", diagnostics, preview });
      console.info("SAMPS prompt input", { ...diagnostics, grid: undefined });
    }
    checkCancelled(); host.assertFresh(captured.stamp);
    // Show every result on the canvas right away; the preview adds a history state, so restamp.
    captured.stamp = await host.showPreview(captured, found, { hideMarks: found.length > 0 });
    dispatch({ type: "layers", layers: host.visibility() });
    stampRef.current = captured.stamp;
    dispatch({ type: "results", instances: found, snapshot: captured });
    const merged = found.length === 1 && (found[0].parts ?? 1) > 1 ? `（已合并 ${found[0].parts} 个部分）` : "";
    status(found.length ? `找到 ${found.length} 个实例${merged}。红色为预览，标记层已隐藏（可随时用“标记”按钮打开）。`
      : "没有找到匹配实例。可扩大涂抹范围或降低置信度。");
  });
  const cancel = () => { cancelled.current = true; engine.current?.cancel(); status("正在取消…"); };

  // ── Preview ──
  const updatePreview = (selected: Set<number>) => action(async () => {
    const snapshot = live.current.snapshot;
    if (!snapshot) return;
    const next = await host.showPreview(snapshot, live.current.instances.filter(item => selected.has(item.id)));
    stampRef.current = next;
    dispatch({ type: "restamp", stamp: next });
    dispatch({ type: "layers", layers: host.visibility() });
  });
  const toggle = (id: number) => {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    dispatch({ type: "toggle", id });
    updatePreview(selected);
  };
  const selectAll = (on: boolean) => {
    dispatch({ type: "selectAll", on });
    updatePreview(on ? new Set(state.instances.map(item => item.id)) : new Set());
  };

  // ── Output ──
  const chosen = useMemo(() => state.instances.filter(item => state.selected.has(item.id)), [state.instances, state.selected]);
  const output = async (kind: "selection" | "layers", event?: MouseEvent) => {
    if (!state.snapshot || busy.current) return;
    const mode = kind === "selection" && event ? modeFromModifiers(event.shiftKey, event.altKey, state.selectionMode) : state.selectionMode;
    const picked = chosen;
    // Selections first ask for expand / feather, prefilled with the last confirmed values.
    let settings: SelectionSettings = { expand: 0, feather: 0 };
    if (kind === "selection") {
      dialogOpen.current = true;
      let confirmed: SelectionSettings | null = null;
      try { confirmed = await selectionDialog.current!.open(loadSelectionSettings()); }
      finally { dialogOpen.current = false; }
      if (!confirmed) return;
      saveSelectionSettings(confirmed);
      settings = confirmed;
    }
    await action(async () => {
      const snapshot = live.current.snapshot;
      if (!snapshot) return;
      await host.output(snapshot, picked, kind, { separate: state.separate, mode, ...settings });
      stampRef.current = host.stamp();
      dispatch({ type: "restamp", stamp: stampRef.current });
      const label = SELECTION_MODES.find(item => item.mode === mode)!.label;
      const extra = describeSettings(settings);
      status(kind === "selection" ? `已${label === "新选区" ? "生成新选区" : label}${extra ? `（${extra}）` : ""}。`
        : "已创建带蒙版的结果图层，可一次撤销。");
    });
  };

  const invalidate = (patch: Parameters<typeof dispatch>[0]) => {
    dispatch(patch);
    if (state.snapshot) { dispatch({ type: "clearResults" }); status("识别条件已改变，请重新识别。"); }
  };

  // Enter = recognize, Esc = cancel, while focus is in the panel.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = event => {
    if (dialogOpen.current) return;  // Enter belongs to the selection dialog while it is open
    if (event.key === "Escape" && state.busy) cancel();
    else if (event.key === "Enter" && !state.busy && state.model && state.hasDocument) recognize();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const { busy: working, hasDocument, model } = state;
  const canOutput = !working && Boolean(state.snapshot) && chosen.length > 0;
  const d = state.diagnostics;

  return (
    <main className="panel">
      <header className="doc"><sp-body size="XS" class="doc-name" title={state.documentLabel}>{state.documentLabel}</sp-body></header>

      <Section title="模型" aside={<ActionButton quiet title="选择模型目录" onClick={browseModel} disabled={working}><FolderIcon /></ActionButton>}>
        <div className="row">
          <Picker label="分割模型" value={state.modelId} disabled={working}
            options={MODELS.map(item => ({ value: item.id, label: item.label }))} onChange={changeModel} />
          <Picker label="推理设备" value={String(state.device)} disabled={working}
            options={choice.gpuOnly ? [{ value: "-2", label: "GPU" }] : [{ value: "-2", label: "GPU" }, { value: "-1", label: "CPU" }]}
            onChange={changeDevice} />
        </div>
        <sp-detail class="muted">{state.modelStatus}</sp-detail>
      </Section>

      <Section title="标记">
        <div className="toolbar">
          <div className="segmented" role="radiogroup" aria-label="标记类型">
            <ActionButton selected={state.markKind === "add"} title="添加：涂抹要选的对象和它的配饰（橙色）"
              onClick={() => mark("add", state.markTool)} disabled={working || !hasDocument}><IconLabel icon={<Swatch color="#ff7800" />}>添加</IconLabel></ActionButton>
            <ActionButton selected={state.markKind === "exclude"} title="排除：涂抹不要的部分（蓝色）"
              onClick={() => mark("exclude", state.markTool)} disabled={working || !hasDocument}><IconLabel icon={<Swatch color="#008cff" />}>排除</IconLabel></ActionButton>
          </div>
          <div className="segmented" role="radiogroup" aria-label="标记工具">
            <ActionButton selected={state.markTool === "brush"} title="画笔" onClick={() => mark(state.markKind, "brush")}
              disabled={working || !hasDocument}><BrushIcon /></ActionButton>
            <ActionButton selected={state.markTool === "eraser"} title="橡皮擦（自动切到当前标记层）"
              onClick={() => mark(state.markKind, "eraser")} disabled={working || !hasDocument}><EraserIcon /></ActionButton>
          </div>
          <ActionButton title="一键清空添加和排除的涂抹" onClick={clearPrompt} disabled={working || !hasDocument}><ClearIcon /></ActionButton>
        </div>
        <div className="toolbar">
          <ActionButton quiet selected={state.layers.marks === true} title="显示 / 隐藏标记层"
            onClick={() => toggleLayer("marks")} disabled={working || state.layers.marks === null}>
            <IconLabel icon={<EyeIcon open={state.layers.marks !== false} />}>标记</IconLabel></ActionButton>
          <ActionButton quiet selected={state.layers.preview === true} title="显示 / 隐藏识别结果预览"
            onClick={() => toggleLayer("preview")} disabled={working || state.layers.preview === null}>
            <IconLabel icon={<EyeIcon open={state.layers.preview !== false} />}>预览</IconLabel></ActionButton>
        </div>
        <div className="mode-row">
          <sp-label>识别范围</sp-label>
          <SegmentedSwitch label="识别范围" value={state.mode} disabled={working}
            onChange={mode => invalidate({ type: "set", patch: { mode } })}
            options={[{ value: "current", label: "当前对象", title: "涂抹处的对象，连同配饰合并为一个结果" },
                      { value: "similar", label: "所有相似", title: "选出画面中所有同类对象" }]} />
        </div>
        <sp-detail class="muted hint">{choice.hint}</sp-detail>
        <Slider label="置信度" min={0.05} max={0.95} step={0.05} value={state.confidence} disabled={working}
          format={value => value.toFixed(2)} onChange={value => invalidate({ type: "set", patch: { confidence: value } })} />
        <Checkbox checked={state.detail} disabled={working}
          onChange={checked => invalidate({ type: "set", patch: { detail: checked } })}>精细边缘（当前模式，多约 1–2 秒）</Checkbox>
        <div className="actions">
          {working
            ? <Button variant="secondary" onClick={cancel} title="Esc">取消</Button>
            : <Button variant="cta" onClick={recognize} disabled={!model || !hasDocument} title="Enter">识别</Button>}
        </div>
        {working && <sp-progressbar class="progress" indeterminate size="s" />}
        <sp-detail class={state.status.error ? "status error" : "status"} role="status" aria-live="polite">{state.status.text}</sp-detail>
      </Section>

      <Section title={`实例${state.instances.length ? ` · ${chosen.length}/${state.instances.length}` : ""}`}
        aside={state.instances.length > 1 ? (
          <div className="inline">
            <ActionButton quiet title="全选" onClick={() => selectAll(true)} disabled={working}>全选</ActionButton>
            <ActionButton quiet title="全不选" onClick={() => selectAll(false)} disabled={working}>清除</ActionButton>
          </div>) : undefined}>
        {state.instances.length === 0
          ? <sp-detail class="muted">识别后在此勾选要输出的实例。</sp-detail>
          : <div className="instances">
            {state.instances.map((item, index) => (
              <div className="instance" key={item.id}>
                <Checkbox checked={state.selected.has(item.id)} disabled={working}
                  onChange={() => toggle(item.id)}>{item.label || `实例 ${index + 1}`}{(item.parts ?? 1) > 1 ? ` · ${item.parts} 部分` : ""}{item.refined ? " · 已细化" : ""}{item.detailed ? " · 精细边缘" : ""}</Checkbox>
                <span className="score">{(item.confidence * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>}
      </Section>

      <Section title="输出">
        <div className="toolbar">
          <div className="segmented" role="radiogroup" aria-label="选区运算">
            {SELECTION_MODES.map(item => (
              <ActionButton key={item.mode} selected={state.selectionMode === item.mode}
                title={item.shortcut ? `${item.label}（${item.shortcut}+点击“生成选区”）` : item.label}
                onClick={() => dispatch({ type: "set", patch: { selectionMode: item.mode } })}>
                <SelectionIcon mode={item.mode} />
              </ActionButton>
            ))}
          </div>
        </div>
        <div className="actions">
          <Button variant="primary" onClick={event => output("selection", event)} disabled={!canOutput}
            title="Shift 添加 · Alt 减去 · Shift+Alt 交叉">生成选区</Button>
          <Button variant="secondary" onClick={() => output("layers")} disabled={!canOutput}>蒙版图层</Button>
        </div>
        <Checkbox checked={state.separate} disabled={working}
          onChange={checked => dispatch({ type: "set", patch: { separate: checked } })}>每个实例单独生成图层</Checkbox>
      </Section>

      <Section title="诊断" aside={<ActionButton quiet title="显示模型实际收到的输入" selected={state.diagnosticsOpen}
        onClick={() => dispatch({ type: "set", patch: { diagnosticsOpen: !state.diagnosticsOpen } })}><InfoIcon /></ActionButton>}>
        {state.diagnosticsOpen && (d
          ? <div className="diagnostics">
            <sp-detail class="muted">
              {[
                `读取：${(d.capture as any)?.compositeRead ?? "—"}`,
                `涂色像素 ${d.sentPaintedPixels}`,
                d.transferMatches ? "JS→C++ 校验一致" : "传输未确认",
                d.gridActiveCells !== undefined ? `提示格 ${d.gridActiveCells}` : "",
                d.maximumConfidence !== undefined ? `最高分 ${(d.maximumConfidence * 100).toFixed(1)}%` : ""
              ].filter(Boolean).join(" · ")}
            </sp-detail>
            {state.preview && <img className="preview" src={state.preview} alt="模型实际收到的提示，白色为涂抹" />}
          </div>
          : <sp-detail class="muted">识别后显示模型实际收到的提示。</sp-detail>)}
      </Section>
      <SelectionDialog ref={selectionDialog} />
    </main>
  );
}
