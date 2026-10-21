import React from "react";
import type { SelectionMode } from "../core/selection";

// 18×18 workflow icons drawn to match Photoshop's options-bar glyphs.
// `currentColor` lets the host theme drive the stroke.
const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="icon">{children}</svg>
);
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.2 } as const;
const solid = { fill: "currentColor", stroke: "none" } as const;

export const SelectionIcon = ({ mode }: { mode: SelectionMode }) => {
  switch (mode) {
    case "new": return <Svg><rect x="3" y="3" width="12" height="12" {...solid} /></Svg>;
    case "add": return <Svg><rect x="2" y="2" width="9" height="9" {...solid} /><rect x="7" y="7" width="9" height="9" {...solid} /></Svg>;
    case "subtract": return <Svg><rect x="2" y="2" width="9" height="9" {...solid} /><rect x="7" y="7" width="9" height="9" {...stroke} /></Svg>;
    case "intersect": return <Svg><rect x="2" y="2" width="9" height="9" {...stroke} /><rect x="7" y="7" width="9" height="9" {...stroke} />
      <rect x="7" y="7" width="4" height="4" {...solid} /></Svg>;
  }
};

export const BrushIcon = () => (
  <Svg><path d="M14.5 2.5 8 9l1 1 6.5-6.5zM7.3 9.8c-1.6 0-2.8 1.2-2.8 2.8 0 .9-.6 1.6-1.5 1.9 2.8 1.3 6 .4 6-2.9z" {...solid} /></Svg>
);
export const ExcludeIcon = () => (
  <Svg><path d="M14.5 2.5 8 9l1 1 6.5-6.5zM7.3 9.8c-1.6 0-2.8 1.2-2.8 2.8 0 .9-.6 1.6-1.5 1.9 2.8 1.3 6 .4 6-2.9z" {...solid} />
    <path d="M10.5 13.5h6" {...stroke} strokeWidth={1.6} /></Svg>
);
export const EyeIcon = ({ open }: { open: boolean }) => (
  <Svg><path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" {...stroke} />
    {open ? <circle cx="9" cy="9" r="2.4" {...solid} /> : <path d="M3 15 15 3" {...stroke} strokeWidth={1.5} />}</Svg>
);
// Colour swatch used on the add / exclude toggle, matching the brush colour on the canvas.
export const Swatch = ({ color }: { color: string }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="swatch"><circle cx="5" cy="5" r="4.5" fill={color} /></svg>
);
export const EraserIcon = () => (
  <Svg><path d="m10.5 2.5 5 5-7 7H4.5l-2-2zm-6.2 6.2-.9.9 2.6 2.6h2.1l.4-.4z" {...solid} /><path d="M9 14.5h7" {...stroke} /></Svg>
);
export const ClearIcon = () => (
  <Svg><path d="M3 4.5h12M7 4.5V3h4v1.5M5 4.5l.8 10.5h6.4L13 4.5M8 7v6M10 7v6" {...stroke} /></Svg>
);
export const FolderIcon = () => (
  <Svg><path d="M2 4.5h5l1.5 1.5H16v8H2z" {...stroke} /></Svg>
);
export const InfoIcon = () => (
  <Svg><circle cx="9" cy="9" r="6.5" {...stroke} /><path d="M9 8v4.5M9 5.5v1" {...stroke} /></Svg>
);
