// Selection output settings, remembered between sessions in the panel's localStorage.

export interface SelectionSettings {
  /** Pixels; negative contracts. Photoshop accepts whole pixels up to 500. */
  expand: number;
  /** Feather radius in pixels; 0 disables. */
  feather: number;
}

export const DEFAULT_SELECTION: SelectionSettings = { expand: 0, feather: 0 };
export const EXPAND_LIMIT = 500;
export const FEATHER_LIMIT = 250;
const KEY = "samps.selectionSettings.v1";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;
const defaultStore = (): Store => (typeof localStorage === "undefined" ? undefined : localStorage);

export function clampSettings(input: Partial<SelectionSettings>): SelectionSettings {
  const number = (value: unknown, min: number, max: number, digits: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const scale = 10 ** digits;
    return Math.min(max, Math.max(min, Math.round(n * scale) / scale));
  };
  return {
    expand: number(input.expand, -EXPAND_LIMIT, EXPAND_LIMIT, 0),
    feather: number(input.feather, 0, FEATHER_LIMIT, 1)
  };
}

export function loadSelectionSettings(store: Store = defaultStore()): SelectionSettings {
  try {
    const raw = store?.getItem(KEY);
    return raw ? clampSettings(JSON.parse(raw)) : { ...DEFAULT_SELECTION };
  } catch {
    return { ...DEFAULT_SELECTION };
  }
}

export function saveSelectionSettings(settings: SelectionSettings, store: Store = defaultStore()) {
  try { store?.setItem(KEY, JSON.stringify(clampSettings(settings))); } catch { /* storage unavailable */ }
}

export function describeSettings(settings: SelectionSettings): string {
  return [
    settings.expand ? `${settings.expand > 0 ? "扩张" : "收缩"} ${Math.abs(settings.expand)} 像素` : "",
    settings.feather ? `羽化 ${settings.feather} 像素` : ""
  ].filter(Boolean).join("，");
}
