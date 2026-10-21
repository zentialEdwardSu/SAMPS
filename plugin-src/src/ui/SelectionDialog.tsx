import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Button, useEvent } from "./spectrum";
import { clampSettings, EXPAND_LIMIT, FEATHER_LIMIT, type SelectionSettings } from "../core/settings";

export interface SelectionDialogHandle {
  /** Shows the dialog prefilled with `initial`; resolves with the confirmed values or null when cancelled. */
  open(initial: SelectionSettings): Promise<SelectionSettings | null>;
}

function NumberField({ value, onChange, label, min, max, step }: {
  value: number; onChange: (value: number) => void; label: string; min: number; max: number; step: number;
}) {
  const ref = useEvent<HTMLElement>("input", event => {
    const next = Number((event.target as any).value);
    if (Number.isFinite(next)) onChange(next);
  });
  return <sp-textfield ref={ref} type="number" class="number" value={String(value)} min={min} max={max} step={step}
    aria-label={label} />;
}

/**
 * Modal sub-window (UXP <dialog> + uxpShowModal) for selection expand / feather. The panel
 * remembers the last confirmed values and passes them in as `initial`.
 */
export const SelectionDialog = forwardRef<SelectionDialogHandle>(function SelectionDialog(_, handle) {
  const dialog = useRef<any>(null);
  const [values, setValues] = useState<SelectionSettings>({ expand: 0, feather: 0 });
  const latest = useRef(values);
  latest.current = values;
  const update = (patch: Partial<SelectionSettings>) => setValues(current => ({ ...current, ...patch }));

  useImperativeHandle(handle, () => ({
    async open(initial) {
      setValues(initial);
      latest.current = initial;
      const element = dialog.current;
      if (!element) return initial;
      let result: unknown;
      if (typeof element.uxpShowModal === "function") {
        result = await element.uxpShowModal({ title: "生成选区", resize: "none", size: { width: 300, height: 220 } });
      } else {
        result = await new Promise(resolve => {
          element.addEventListener("close", () => resolve(element.returnValue), { once: true });
          element.showModal();
        });
      }
      return result === "ok" ? clampSettings(latest.current) : null;
    }
  }), []);

  const keys = useEvent<HTMLElement>("keydown", event => {
    if (event.key === "Enter") { event.preventDefault?.(); dialog.current?.close("ok"); }
  });
  const attach = (element: HTMLElement | null) => {
    dialog.current = element;
    (keys as React.MutableRefObject<HTMLElement | null>).current = element;
  };

  return (
    <dialog ref={attach} className="selection-dialog">
      <sp-heading size="XS">选区设置</sp-heading>
      <div className="field">
        <sp-label>扩张</sp-label>
        <NumberField label="扩张像素" value={values.expand} min={-EXPAND_LIMIT} max={EXPAND_LIMIT} step={1}
          onChange={expand => update({ expand })} />
        <span className="unit">像素</span>
      </div>
      <sp-detail class="muted note">负值为收缩，0 为不变。</sp-detail>
      <div className="field">
        <sp-label>羽化</sp-label>
        <NumberField label="羽化像素" value={values.feather} min={0} max={FEATHER_LIMIT} step={0.5}
          onChange={feather => update({ feather })} />
        <span className="unit">像素</span>
      </div>
      <sp-detail class="muted note">设置会被记住，下次直接沿用。</sp-detail>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => dialog.current?.close("cancel")}>取消</Button>
        <Button variant="cta" onClick={() => dialog.current?.close("ok")}>生成选区</Button>
      </div>
    </dialog>
  );
});
