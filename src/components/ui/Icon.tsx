import type { ReactNode, SVGProps } from "react";

/**
 * A small, original icon set: simple strokes on a 24px grid, drawn with `currentColor` so icons follow
 * the surrounding text colour in both themes. Icons are decorative by default (`aria-hidden`); pass
 * `label` when an icon is the only content of a control.
 */
const glyphs = {
  // tools
  merge: <path d="M4 5h4a4 4 0 0 1 4 4v9M20 5h-4a4 4 0 0 0-4 4M9 15l3 3 3-3" />,
  split: <path d="M12 4v5a4 4 0 0 1-4 4H5M12 9a4 4 0 0 0 4 4h3M8 10l-3 3 3 3M16 10l3 3-3 3" />,
  extract: <path d="M13 21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8l4 4v3M10 15h11M17 11l4 4-4 4" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  layout: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  rotate: <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />,
  "rotate-left": <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5" />,
  compress: <path d="M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6" />,
  wrench: <path d="M15 4.5a4.5 4.5 0 0 0-4.3 5.8L4.5 16.5a2 2 0 0 0 3 3l6.2-6.2A4.5 4.5 0 0 0 19.5 9l-3 3-3-1-1-3z" />,
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 17l5-4 4 3 3-2 6 4" />
    </>
  ),
  word: <path d="M4 7l3 10 5-8 5 8 3-10" />,
  excel: <path d="M5 6l14 12M19 6L5 18" />,
  powerpoint: <path d="M8 19V5h5a4 4 0 0 1 0 8H8" />,
  pencil: <path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4" />,
  hash: <path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />,
  droplet: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  crop: <path d="M7 3v14h14M3 7h14v14" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.6v.01" />
    </>
  ),
  file: <path d="M7 3h7l4 4v14H7zM14 3v4h4" />,
  "file-plus": <path d="M7 3h7l4 4v14H7zM14 3v4h4M12.5 12v6M9.5 15h6" />,
  archive: <path d="M4 7h16v13H4zM4 7l2-3h12l2 3M10 11h4" />,

  // interface
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M5 13l4 4L19 7" />,
  alert: <path d="M12 3l10 18H2zM12 10v5M12 17.6v.01" />,
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  "chevron-up": <path d="M6 15l6-6 6 6" />,
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  "chevron-left": <path d="M15 6l-6 6 6 6" />,
  "arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
  "arrow-down": <path d="M12 5v14M6 13l6 6 6-6" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4" />,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7v.01M7 17v.01" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17v.01" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  undo: <path d="M9 14L4 9l5-5M4 9h9a6 6 0 0 1 0 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9h-9a6 6 0 0 0 0 12h3" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-3.5M4 4v4h4M4 13a8 8 0 0 0 14.5 3.5M20 20v-4h-4" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.2-4.2M11 8.5v5M8.5 11h5" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.2-4.2M8.5 11h5" />
    </>
  ),

  // editor tools
  cursor: <path d="M5 3l14 7-6 2-2 6z" />,
  type: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  square: <rect x="4" y="5" width="16" height="14" rx="1.5" />,
  circle: <circle cx="12" cy="12" r="8" />,
  line: <path d="M5 19L19 5" />,
  draw: <path d="M3 17c3-8 5 4 8-3s5 3 10-6" />,
  highlighter: <path d="M4 20h7M14 4l6 6-8 8-4-1-1-4zM12.5 5.5l6 6" />,
  eraser: <path d="M5 15l9-9 6 6-6 6H9zM9 18h11" />,

  // editor: more tools and panels
  hand: <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V11m0-4a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-.5A6 6 0 0 1 6.200 17L3.500 13a1.500 1.500 0 0 1 2.300-1.900L8 14" />,
  underline: <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />,
  strikeout: <path d="M17 7c0-2-2-3-5-3S7 5.500 7 7.500 9 11 12 12s5 2 5 4.500-2 3.500-5 3.500-5-1-5-3M4 12h16" />,
  squiggly: <path d="M7 4v6a5 5 0 0 0 10 0V4M3 19c1.500-2 3-2 4.500 0s3 2 4.500 0 3-2 4.500 0 3 2 4.500 0" />,
  note: <path d="M4 5h16v11h-9l-4 4v-4H4zM8 9h8M8 12h5" />,
  redact: <path d="M3 9h18v6H3zM6 12h5" />,
  "edit-text": <path d="M4 5h16M4 9h9M4 13h6M13 20l6-6 2 2-6 6h-2z" />,
  checkbox: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.500" fill="currentColor" />
    </>
  ),
  dropdown: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M9 11l3 3 3-3" />
    </>
  ),
  signature: <path d="M3 16c2-6 4-8 5-8s0 6 2 6 2-4 4-4 1 4 3 4M3 21h18" />,
  textfield: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M8 10v4" />
    </>
  ),
  "bring-front": (
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.500" />
      <path d="M4 15V5a1 1 0 0 1 1-1h10" />
    </>
  ),
  "send-back": (
    <>
      <rect x="4" y="4" width="11" height="11" rx="1.500" />
      <path d="M20 9v10a1 1 0 0 1-1 1H9" />
    </>
  ),
  forward: (
    <>
      <rect x="3" y="3" width="11" height="11" rx="1.5" />
      <rect x="10" y="10" width="11" height="11" rx="1.5" fill="currentColor" fillOpacity="0.28" />
    </>
  ),
  backward: (
    <>
      <rect x="10" y="10" width="11" height="11" rx="1.5" />
      <rect x="3" y="3" width="11" height="11" rx="1.5" fill="currentColor" fillOpacity="0.28" />
    </>
  ),
  "distribute-h": (
    <>
      <path d="M4 4v16M20 4v16" />
      <rect x="9" y="8" width="6" height="8" rx="1" />
    </>
  ),
  "distribute-v": (
    <>
      <path d="M4 4h16M4 20h16" />
      <rect x="8" y="9" width="8" height="6" rx="1" />
    </>
  ),
  group: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 2.5" />
      <rect x="7" y="7" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </>
  ),
  ungroup: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
      <path d="M15 6h5M18 3.5 20.5 6 18 8.5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" />
      <path d="m3 12.500 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  background: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 16l5-4 4 3 3-2 6 4" />
      <path d="M8 8.500h.01" />
    </>
  ),
  center: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
    </>
  ),
  "align-left": <path d="M4 4v16M8 8h12M8 14h8" />,
  "align-center": <path d="M12 4v16M6 8h12M8 14h8" />,
  "align-right": <path d="M20 4v16M4 8h12M8 14h8" />,
  "align-top": <path d="M4 4h16M8 8v12M14 8v8" />,
  "align-middle": <path d="M4 12h16M8 6v12M14 8v8" />,
  "align-bottom": <path d="M4 20h16M8 4v12M14 8v8" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.700M3 4v5h5M12 8v5l3 2" />,
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  grid: <path d="M4 4h16v16H4zM4 12h16M12 4v16" />,
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  "page-single": <rect x="6" y="3" width="12" height="18" rx="1.500" />,
  "page-scroll": (
    <>
      <rect x="6" y="2" width="12" height="9" rx="1" />
      <rect x="6" y="13" width="12" height="9" rx="1" />
    </>
  ),
  "fit-width": <path d="M4 6v12M20 6v12M8 12h8M8 12l2-2M8 12l2 2M16 12l-2-2M16 12l-2 2" />,
  "fit-page": (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.500" />
      <path d="M9 9L7 7M15 9l2-2M9 15l-2 2M15 15l2 2" />
    </>
  ),
  flip: <path d="M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />,
  lines: <path d="M4 7h16M4 12h16M4 17h10" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  /** Accessible name. Omit for decorative icons. */
  label?: string;
}

export function Icon({ name, size = 20, label, strokeWidth = 1.75, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {glyphs[name]}
    </svg>
  );
}
