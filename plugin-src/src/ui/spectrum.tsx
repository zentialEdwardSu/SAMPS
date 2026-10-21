import React, { useEffect, useRef, useState } from "react";

// UXP Spectrum widgets are custom elements. Events are attached through refs because
// UXP's event objects for sp-* elements are not routed through React's synthetic system.

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "sp-action-button": any; "sp-button": any; "sp-picker": any; "sp-menu": any; "sp-menu-item": any;
      "sp-slider": any; "sp-checkbox": any; "sp-divider": any; "sp-detail": any; "sp-label": any;
      "sp-body": any; "sp-heading": any; "sp-radio-group": any; "sp-radio": any; "sp-progressbar": any;
      "sp-textfield": any;
    }
  }
}

export function useEvent<T extends HTMLElement>(event: string, handler: (event: any) => void) {
  const ref = useRef<T>(null);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (e: Event) => latest.current(e);
    element.addEventListener(event, listener);
    return () => element.removeEventListener(event, listener);
  }, [event]);
  return ref;
}

const bool = (value: boolean | undefined) => (value ? true : undefined);

export function ActionButton({ onClick, disabled, selected, quiet, title, children, className }: {
  onClick: (event: MouseEvent) => void; disabled?: boolean; selected?: boolean; quiet?: boolean;
  title?: string; children: React.ReactNode; className?: string;
}) {
  const ref = useEvent<HTMLElement>("click", event => { if (!disabled) onClick(event); });
  return <sp-action-button ref={ref} size="s" class={className} title={title} aria-label={title}
    disabled={bool(disabled)} selected={bool(selected)} quiet={bool(quiet)}>{children}</sp-action-button>;
}

export function Button({ onClick, disabled, variant = "secondary", children, title }: {
  onClick: (event: MouseEvent) => void; disabled?: boolean; variant?: "cta" | "primary" | "secondary" | "warning";
  children: React.ReactNode; title?: string;
}) {
  const ref = useEvent<HTMLElement>("click", event => { if (!disabled) onClick(event); });
  return <sp-button ref={ref} size="s" variant={variant} title={title} disabled={bool(disabled)}>{children}</sp-button>;
}

export function Picker({ value, options, onChange, disabled, label }: {
  value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
  disabled?: boolean; label: string;
}) {
  const ref = useEvent<HTMLElement>("change", event => {
    const target = event.target as any;
    const index = target.selectedIndex;
    const next = Number.isInteger(index) && index >= 0 ? options[index]?.value : target.value;
    if (next !== undefined && next !== value) onChange(String(next));
  });
  return (
    <sp-picker ref={ref} size="s" class="picker" aria-label={label} disabled={bool(disabled)}>
      <sp-menu slot="options">
        {options.map(option => (
          <sp-menu-item key={option.value} value={option.value} selected={bool(option.value === value)}>{option.label}</sp-menu-item>
        ))}
      </sp-menu>
    </sp-picker>
  );
}

// The readout follows "input" (fired while dragging); onChange is called on "change" (release),
// so dragging does not repeatedly invalidate results.
export function Slider({ value, min, max, step, onChange, disabled, label, format }: {
  value: number; min: number; max: number; step: number; onChange: (value: number) => void;
  disabled?: boolean; label: string; format: (value: number) => string;
}) {
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  const read = (event: any) => {
    const next = Number(event.target.value);
    return Number.isFinite(next) ? Math.round(next / step) * step : null;
  };
  const inputRef = useEvent<HTMLElement>("input", event => { const next = read(event); if (next !== null) setShown(next); });
  const changeRef = useEvent<HTMLElement>("change", event => {
    const next = read(event);
    if (next !== null) { setShown(next); if (Math.abs(next - value) > step / 2) onChange(next); }
  });
  const ref = (element: HTMLElement | null) => {
    (inputRef as React.MutableRefObject<HTMLElement | null>).current = element;
    (changeRef as React.MutableRefObject<HTMLElement | null>).current = element;
  };
  return (
    <div className="slider-row">
      <sp-label>{label}</sp-label>
      <sp-slider ref={ref} class="slider" min={min} max={max} step={step} value={value} disabled={bool(disabled)}
        aria-label={label} show-value="false" />
      <span className="value">{format(shown)}</span>
    </div>
  );
}

/**
 * Two-option switch. The selected option is a Spectrum CTA button, so it uses exactly the same
 * blue as the panel's primary action in every Photoshop theme; the other option is quiet.
 */
export function SegmentedSwitch<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: { value: T; label: string; title?: string }[]; onChange: (value: T) => void;
  disabled?: boolean; label: string;
}) {
  return (
    <div className="switch" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <SwitchOption key={option.value} selected={option.value === value} title={option.title} disabled={disabled}
          onSelect={() => { if (option.value !== value) onChange(option.value); }}>{option.label}</SwitchOption>
      ))}
    </div>
  );
}

function SwitchOption({ selected, title, disabled, onSelect, children }: {
  selected: boolean; title?: string; disabled?: boolean; onSelect: () => void; children: React.ReactNode;
}) {
  const ref = useEvent<HTMLElement>("click", () => { if (!disabled) onSelect(); });
  return (
    <sp-button ref={ref} size="s" class="option" role="radio" aria-checked={selected} title={title}
      variant={selected ? "cta" : "secondary"} quiet={bool(!selected)} disabled={bool(disabled)}>{children}</sp-button>
  );
}

/** Icon and text side by side inside an action button. */
export const IconLabel = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <span className="icon-label">{icon}<span>{children}</span></span>
);

export function Checkbox({ checked, onChange, disabled, children }: {
  checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: React.ReactNode;
}) {
  const ref = useEvent<HTMLElement>("change", event => onChange(Boolean((event.target as any).checked)));
  return <sp-checkbox ref={ref} size="s" checked={bool(checked)} disabled={bool(disabled)}>{children}</sp-checkbox>;
}

export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="section">
      <div className="section-title"><sp-detail>{title}</sp-detail>{aside}</div>
      {children}
    </section>
  );
}
