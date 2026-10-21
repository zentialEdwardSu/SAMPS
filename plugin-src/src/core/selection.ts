export type SelectionMode = "new" | "add" | "subtract" | "intersect";

export const SELECTION_MODES: { mode: SelectionMode; label: string; shortcut: string }[] = [
  { mode: "new", label: "新选区", shortcut: "" },
  { mode: "add", label: "添加到选区", shortcut: "Shift" },
  { mode: "subtract", label: "从选区减去", shortcut: "Alt" },
  { mode: "intersect", label: "与选区交叉", shortcut: "Shift+Alt" }
];

/** Maps Photoshop's marquee modifier keys onto a selection mode. */
export function modeFromModifiers(shift: boolean, alt: boolean, fallback: SelectionMode): SelectionMode {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return fallback;
}

/**
 * Combines the current document selection S with a new mask M, per pixel, the way
 * Photoshop's selection tools do. Soft (partially selected) values are preserved.
 * `current` may be null when the document has no selection.
 */
export function combineSelection(mode: SelectionMode, current: Uint8Array | null, mask: Uint8Array): Uint8Array {
  if (current && current.length !== mask.length) throw new RangeError("Selection and mask sizes differ");
  if (mode === "new") return mask;
  const output = new Uint8Array(mask.length);
  if (!current) {
    // add → M, subtract/intersect against an empty selection → empty.
    if (mode === "add") output.set(mask);
    return output;
  }
  for (let i = 0; i < mask.length; i++) {
    const s = current[i], m = mask[i];
    output[i] = mode === "add" ? (s > m ? s : m)
      : mode === "subtract" ? Math.min(s, 255 - m)
      : (s < m ? s : m);
  }
  return output;
}

export const isEmpty = (mask: Uint8Array) => !mask.some(value => value > 0);
