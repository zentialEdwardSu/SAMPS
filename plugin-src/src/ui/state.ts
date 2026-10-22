import type { Instance, ModelInfo, PromptDiagnostics } from "../host/NativeEngine";
import type { Capture } from "../host/PhotoshopHost";
import type { SelectionMode } from "../core/selection";
import type { MarkKind } from "../core/document";
import type { MarkTool } from "../host/PhotoshopHost";

export interface State {
  documentLabel: string;
  hasDocument: boolean;
  modelId: string;
  device: number;
  model: ModelInfo | null;
  modelStatus: string;
  busy: boolean;
  status: { text: string; error: boolean };
  mode: "current" | "similar";
  confidence: number;
  selectionMode: SelectionMode;
  separate: boolean;
  instances: Instance[];
  selected: Set<number>;
  snapshot: Capture | null;
  diagnostics: PromptDiagnostics | null;
  preview: string | null;
  diagnosticsOpen: boolean;
  markKind: MarkKind;
  /** Edge post-processing, 0..1: contour smoothing / edge softness, and how far gaps are filled. */
  smooth: number;
  expand: number;
  /** Release the image encoder's GPU memory after each encode (slower per new image). */
  lowVram: boolean;
  /** After a GPU memory failure: what the panel offers to switch to (null when nothing is pending). */
  suggestion: { kind: "release" } | { kind: "model"; modelId: string; label: string } | null;
  /** Re-run the edge refine on a crop around the object (one extra encoder pass). */
  detail: boolean;
  markTool: MarkTool;
  /** Visibility of the marks group and the preview overlay; null when the layer does not exist. */
  layers: { marks: boolean | null; preview: boolean | null };
}

export const initialState: State = {
  documentLabel: "打开图像后开始标记", hasDocument: false,
  modelId: "sam3", device: -2, model: null, modelStatus: "正在加载原生模块…",
  busy: false, status: { text: "", error: false },
  mode: "current", confidence: 0.25, selectionMode: "new", separate: false,
  instances: [], selected: new Set(), snapshot: null, diagnostics: null, preview: null, diagnosticsOpen: false,
  markKind: "add", markTool: "brush", detail: true, smooth: 0.5, expand: 0.5, lowVram: false, suggestion: null, layers: { marks: null, preview: null }
};

export type Action =
  | { type: "document"; label: string; present: boolean }
  | { type: "busy"; busy: boolean }
  | { type: "status"; text: string; error?: boolean }
  | { type: "modelStatus"; text: string; model?: ModelInfo | null }
  | { type: "set"; patch: Partial<Pick<State, "modelId" | "device" | "mode" | "confidence" | "selectionMode" | "separate" | "diagnosticsOpen" | "markKind" | "markTool" | "detail" | "smooth" | "expand" | "lowVram">> }
  | { type: "results"; instances: Instance[]; snapshot: Capture }
  | { type: "clearResults" }
  | { type: "toggle"; id: number }
  | { type: "selectAll"; on: boolean }
  | { type: "diagnostics"; diagnostics: PromptDiagnostics | null; preview?: string | null }
  | { type: "restamp"; stamp: Capture["stamp"] }
  /** Undo / redo moved to a history state with known results. */
  | { type: "restore"; instances: Instance[]; selected: number[]; snapshot: Capture | null }
  /** New masks for the same instances after re-running the edge post-processing. */
  | { type: "remask"; instances: Instance[] }
  | { type: "suggest"; suggestion: State["suggestion"] }
  | { type: "layers"; layers: State["layers"] };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "document":
      return state.documentLabel === action.label && state.hasDocument === action.present ? state
        : { ...state, documentLabel: action.label, hasDocument: action.present };
    case "busy": return { ...state, busy: action.busy };
    case "status": return { ...state, status: { text: action.text, error: Boolean(action.error) } };
    case "modelStatus": return { ...state, modelStatus: action.text, ...(action.model !== undefined ? { model: action.model } : {}) };
    case "set": return { ...state, ...action.patch };
    case "results":
      return { ...state, instances: action.instances, snapshot: action.snapshot, selected: new Set(action.instances.map(item => item.id)) };
    case "clearResults": return state.snapshot || state.instances.length
      ? { ...state, instances: [], selected: new Set(), snapshot: null } : state;
    case "toggle": {
      const selected = new Set(state.selected);
      if (selected.has(action.id)) selected.delete(action.id); else selected.add(action.id);
      return { ...state, selected };
    }
    case "selectAll": return { ...state, selected: action.on ? new Set(state.instances.map(item => item.id)) : new Set() };
    case "diagnostics": return { ...state, diagnostics: action.diagnostics,
      ...(action.preview !== undefined ? { preview: action.preview } : {}) };
    case "suggest": return state.suggestion === action.suggestion ? state : { ...state, suggestion: action.suggestion };
    case "remask": {
      const ids = new Set(action.instances.map(item => item.id));
      return { ...state, instances: action.instances, selected: new Set([...state.selected].filter(id => ids.has(id))) };
    }
    case "restore": return { ...state, instances: action.instances, selected: new Set(action.selected), snapshot: action.snapshot };
    case "restamp": return state.snapshot ? { ...state, snapshot: { ...state.snapshot, stamp: action.stamp } } : state;
    case "layers":
      return state.layers.marks === action.layers.marks && state.layers.preview === action.layers.preview ? state
        : { ...state, layers: action.layers };
  }
}
