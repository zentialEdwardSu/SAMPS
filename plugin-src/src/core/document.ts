import { SampsError } from "./errors";

export const PROMPT_PREFIX = "[SAMPS 提示]";
export const RESULT_PREFIX = "[SAMPS 结果]";

export interface LayerLike { id: number; name: string; visible: boolean; kind?: unknown; layers?: LayerLike[] | null }
export interface DocumentLike {
  id: number; width: number; height: number; title?: string; name?: string;
  mode?: string; bitsPerChannel?: string; quickMaskMode?: boolean;
  activeHistoryState: { id: number };
}
export interface Stamp { documentId: number; historyId: number; width: number; height: number }

// Photoshop's own (PSB) limit per side.
export const MAX_SIDE = 300000;
// Output selections and masks are full-resolution 8-bit planes held in memory; this keeps one plane under 1 GB.
export const MAX_DOCUMENT_PIXELS = 1_000_000_000;
// Recognition runs on at most this many pixels. Larger documents are read at a reduced working
// size (the models see 1008 px anyway) and their masks are scaled back up for output.
export const WORK_PIXELS = 64_000_000;

export interface WorkSize { width: number; height: number }
/** Working size for a document: the document itself, or the largest size within `budget` pixels. */
// The native engine accepts at most this many pixels per side.
export const WORK_SIDE = 30000;
export function workSize(width: number, height: number, budget = WORK_PIXELS): WorkSize {
  if (width * height <= budget && width <= WORK_SIDE && height <= WORK_SIDE) return { width, height };
  const scale = Math.min(Math.sqrt(budget / (width * height)), WORK_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function assertDocument<T extends DocumentLike>(doc: T | null | undefined): asserts doc is T {
  if (!doc) throw new SampsError("NO_DOCUMENT", "请先打开需要处理的图像。");
  if (!Number.isInteger(doc.width) || !Number.isInteger(doc.height) || doc.width < 1 || doc.height < 1 ||
      doc.width > MAX_SIDE || doc.height > MAX_SIDE || doc.width * doc.height > MAX_DOCUMENT_PIXELS) {
    throw new SampsError("IMAGE_SIZE", "文档超过 10 亿像素，全分辨率选区无法放入内存。");
  }
  if (doc.quickMaskMode) throw new SampsError("QUICK_MASK", "请先退出快速蒙版，再使用提示图层标记。");
}

export function walkLayers<T extends LayerLike>(layers: Iterable<T>): T[] {
  const result: T[] = [];
  for (const layer of layers) {
    result.push(layer);
    if (layer.layers) result.push(...walkLayers(layer.layers as T[]));
  }
  return result;
}

export const PREVIEW_PREFIX = "[SAMPS 预览]";
export const EXCLUDE_PREFIX = "[SAMPS 排除]";
// Group holding the add and exclude marking layers.
export const MARKS_PREFIX = "[SAMPS 标记]";
// Plugin-owned layers: hidden while reading the image and never treated as source pixels.
export const managed = (layer: LayerLike) => [PROMPT_PREFIX, RESULT_PREFIX, PREVIEW_PREFIX, EXCLUDE_PREFIX, MARKS_PREFIX]
  .some(prefix => layer.name.startsWith(prefix));
export const isPreview = (layer: LayerLike) => layer.name.startsWith(PREVIEW_PREFIX);
export const isExclude = (layer: LayerLike) => layer.name.startsWith(EXCLUDE_PREFIX);
export const isMarks = (layer: LayerLike) => layer.name.startsWith(MARKS_PREFIX);
export type MarkKind = "add" | "exclude";
export const isPrompt = (layer: LayerLike) => layer.name.startsWith(PROMPT_PREFIX);

export function stamp(doc: DocumentLike | null | undefined): Stamp {
  assertDocument(doc);
  return { documentId: doc.id, historyId: doc.activeHistoryState.id, width: doc.width, height: doc.height };
}

export function assertFresh(doc: DocumentLike | null | undefined, expected: Stamp) {
  const actual = stamp(doc);
  if ((Object.keys(expected) as (keyof Stamp)[]).some(key => actual[key] !== expected[key])) {
    throw new SampsError("DOCUMENT_CHANGED", "文档已切换或内容已修改，请重新识别后再输出。");
  }
}
