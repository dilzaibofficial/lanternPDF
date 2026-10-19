import { type ReactNode, useId } from "react";
import { arrowHead } from "../../lib/pdf/annotateModel";
import { strokePath } from "../../lib/pdf/annotateModel";
import { centreOf, frameOf } from "../model/geometry";
import { type Measure, layoutTextBox } from "../model/textLayout";
import type { Border, EditorObject, FontFamilyChoice, ImageObject, TextBoxObject } from "../model/types";

const FAMILIES: Record<FontFamilyChoice, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Segoe UI", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", Georgia, serif',
  mono: '"Courier New", Courier, "Liberation Mono", Consolas, monospace',
};

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Text width in points as the browser sets it, with the fonts that have the same metrics as the PDF's standard fonts. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export const measureWithCanvas: Measure = (text, size, font, letterSpacing) => {
  if (measureContext === undefined) measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const count = Array.from(text).length;
  if (!measureContext) return size * 0.55 * count + letterSpacing * count;
  measureContext.font = `${font.italic ? "italic " : ""}${font.bold ? "700 " : "400 "}${size}px ${FAMILIES[font.family]}`;
  return measureContext.measureText(text).width + letterSpacing * count;
};

const dash = (style: "solid" | "dashed", width: number) => (style === "dashed" ? `${Math.max(3, width * 3)} ${Math.max(2, width * 2)}` : undefined);

function Stroke({ border, x, y, width, height, radius = 0 }: { border: Border; x: number; y: number; width: number; height: number; radius?: number }): ReactNode {
  if (!border.color || border.width <= 0) return null;
  return <rect x={x} y={y} width={width} height={height} rx={radius} fill="none" stroke={border.color} strokeWidth={border.width} strokeDasharray={dash(border.style, border.width)} />;
}

function TextBoxView({ object, hideText }: { object: TextBoxObject; hideText?: boolean }) {
  const layout = layoutTextBox(object, measureWithCanvas);
  const c = centreOf(object);
  return (
    <g transform={object.rotation ? `rotate(${object.rotation} ${c.x} ${c.y})` : undefined} opacity={object.opacity} data-object={object.id} data-kind="text">
      {object.fill && <rect x={object.x} y={object.y} width={object.width} height={object.height} rx={object.radius} fill={object.fill} />}
      <Stroke border={object.border} x={object.x} y={object.y} width={object.width} height={object.height} radius={object.radius} />
      {!hideText && (
        <text fill={object.color} style={{ font: `${object.italic ? "italic " : ""}${object.bold ? "700 " : "400 "}${object.size}px ${FAMILIES[object.family]}`, letterSpacing: object.letterSpacing || undefined, whiteSpace: "pre" }} textDecoration={object.underline ? "underline" : undefined}>
          {layout.lines.map((line, index) => (
            <tspan key={index} x={object.x + line.x} y={object.y + line.baseline}>
              {line.text === "" ? " " : line.text}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
}

function ImageView({ object, url }: { object: ImageObject; url: string }) {
  const id = useId();
  const c = centreOf(object);
  const crop = object.crop;
  const natural = object.image;
  const viewBox = crop && natural.width > 0 ? `${crop.left * natural.width} ${crop.top * natural.height} ${natural.width * (1 - crop.left - crop.right)} ${natural.height * (1 - crop.top - crop.bottom)}` : undefined;
  const flip = `${object.flipX ? `translate(${2 * c.x} 0) scale(-1 1)` : ""} ${object.flipY ? `translate(0 ${2 * c.y}) scale(1 -1)` : ""}`.trim();
  return (
    <g transform={`${object.rotation ? `rotate(${object.rotation} ${c.x} ${c.y})` : ""} ${flip}`.trim() || undefined} opacity={object.opacity} data-object={object.id} data-kind="image">
      {viewBox ? (
        <svg x={object.x} y={object.y} width={object.width} height={object.height} viewBox={viewBox} preserveAspectRatio="none" overflow="hidden">
          <image href={url} x={0} y={0} width={natural.width} height={natural.height} preserveAspectRatio="none" />
        </svg>
      ) : (
        <image href={url} x={object.x} y={object.y} width={object.width} height={object.height} preserveAspectRatio="none" />
      )}
      <Stroke border={object.border} x={object.x} y={object.y} width={object.width} height={object.height} />
      <clipPath id={id} />
    </g>
  );
}

function squiggle(box: { x: number; y: number; width: number; height: number }): string {
  const y = box.y + box.height - 1;
  const step = 3;
  let d = `M ${box.x} ${y}`;
  for (let x = box.x, up = true; x < box.x + box.width; x += step, up = !up) d += ` L ${Math.min(x + step, box.x + box.width)} ${up ? y - 2 : y}`;
  return d;
}

export interface ObjectViewProps {
  object: EditorObject;
  imageUrl: (image: ImageObject["image"]) => string;
  /** Do not draw the text of this text box (an editor is covering it). */
  hideText?: boolean;
}

/** One object drawn in the page's SVG. It has no behaviour: the layer above handles the pointer. */
export function ObjectView({ object, imageUrl, hideText }: ObjectViewProps) {
  switch (object.kind) {
    case "existing":
      return null; // the page itself draws it
    case "text":
      return <TextBoxView object={object} hideText={hideText} />;
    case "image":
      return <ImageView object={object} url={imageUrl(object.image)} />;
    case "rect":
    case "ellipse": {
      const c = centreOf(object);
      return (
        <g transform={object.rotation ? `rotate(${object.rotation} ${c.x} ${c.y})` : undefined} opacity={object.opacity} data-object={object.id} data-kind={object.kind}>
          {object.kind === "rect" ? (
            <rect x={object.x} y={object.y} width={object.width} height={object.height} rx={object.radius} fill={object.fill ?? "none"} stroke={object.stroke ?? "none"} strokeWidth={object.strokeWidth} strokeDasharray={dash(object.strokeStyle, object.strokeWidth)} />
          ) : (
            <ellipse cx={c.x} cy={c.y} rx={object.width / 2} ry={object.height / 2} fill={object.fill ?? "none"} stroke={object.stroke ?? "none"} strokeWidth={object.strokeWidth} strokeDasharray={dash(object.strokeStyle, object.strokeWidth)} />
          )}
        </g>
      );
    }
    case "line": {
      const heads: [number, number][] = [];
      if (object.arrow !== "none") heads.push(...arrowHead(object.x1, object.y1, object.x2, object.y2, object.strokeWidth));
      const startHeads: [number, number][] = object.arrow === "both" ? arrowHead(object.x2, object.y2, object.x1, object.y1, object.strokeWidth) : [];
      return (
        <g opacity={object.opacity} stroke={object.color} strokeWidth={object.strokeWidth} strokeLinecap="round" fill="none" data-object={object.id} data-kind="line">
          <line x1={object.x1} y1={object.y1} x2={object.x2} y2={object.y2} strokeDasharray={dash(object.strokeStyle, object.strokeWidth)} />
          {heads.map(([hx, hy], i) => (
            <line key={`e${i}`} x1={object.x2} y1={object.y2} x2={hx} y2={hy} />
          ))}
          {startHeads.map(([hx, hy], i) => (
            <line key={`s${i}`} x1={object.x1} y1={object.y1} x2={hx} y2={hy} />
          ))}
        </g>
      );
    }
    case "draw":
      return <path d={strokePath(object.points)} fill="none" stroke={object.color} strokeWidth={object.strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={object.opacity} data-object={object.id} data-kind="draw" />;
    case "highlight":
      return (
        <g data-object={object.id} data-kind="highlight" style={{ mixBlendMode: "multiply" }}>
          {object.quads.map((q, i) => (
            <rect key={i} x={q.x} y={q.y} width={q.width} height={q.height} fill={object.color} fillOpacity={object.opacity} />
          ))}
        </g>
      );
    case "underline":
    case "strikeout":
      return (
        <g data-object={object.id} data-kind={object.kind} stroke={object.color} strokeWidth={1.2} opacity={object.opacity}>
          {object.quads.map((q, i) => {
            const y = object.kind === "underline" ? q.y + q.height - 1 : q.y + q.height * 0.55;
            return <line key={i} x1={q.x} y1={y} x2={q.x + q.width} y2={y} />;
          })}
        </g>
      );
    case "squiggly":
      return (
        <g data-object={object.id} data-kind="squiggly" stroke={object.color} strokeWidth={1} fill="none" opacity={object.opacity}>
          {object.quads.map((q, i) => (
            <path key={i} d={squiggle(q)} />
          ))}
        </g>
      );
    case "comment":
      return (
        <g data-object={object.id} data-kind="comment" opacity={object.opacity}>
          <path d={`M ${object.x} ${object.y} h 22 v 15 h -9 l -5 6 v -6 h -8 z`} fill="#fde047" stroke="#a16207" strokeWidth={1} />
          <path d={`M ${object.x + 5} ${object.y + 5} h 12 M ${object.x + 5} ${object.y + 9} h 8`} stroke="#a16207" strokeWidth={1} />
          {object.text && <title>{object.text}</title>}
        </g>
      );
    case "cover": {
      const c = centreOf(object);
      return (
        <g transform={object.rotation ? `rotate(${object.rotation} ${c.x} ${c.y})` : undefined} data-object={object.id} data-kind="cover" opacity={object.opacity}>
          <rect x={object.x} y={object.y} width={object.width} height={object.height} fill={object.color} stroke="var(--border-strong)" strokeWidth={0.6} strokeDasharray="3 2" />
        </g>
      );
    }
    case "redact": {
      const c = centreOf(object);
      return (
        <g transform={object.rotation ? `rotate(${object.rotation} ${c.x} ${c.y})` : undefined} data-object={object.id} data-kind="redact">
          <rect x={object.x} y={object.y} width={object.width} height={object.height} fill="#000" fillOpacity={0.28} stroke="#dc2626" strokeWidth={1.2} strokeDasharray="5 3" />
          <text x={object.x + 4} y={object.y + Math.min(object.height - 3, 12)} fontSize={Math.min(9, object.height - 2)} fill="#dc2626" style={{ font: "700 9px sans-serif" }}>
            REDACT
          </text>
        </g>
      );
    }
    case "field": {
      const frame = frameOf(object);
      const label = object.label || object.name;
      return (
        <g data-object={object.id} data-kind="field">
          <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={object.fieldType === "radio" ? frame.width / 2 : 2} fill={object.fill ?? "none"} fillOpacity={0.85} stroke={object.border.color ?? "none"} strokeWidth={object.border.width} strokeDasharray={dash(object.border.style, object.border.width)} />
          {object.fieldType === "checkbox" && <path d={`M ${frame.x + frame.width * 0.2} ${frame.y + frame.height * 0.55} l ${frame.width * 0.25} ${frame.height * 0.25} l ${frame.width * 0.35} -${frame.height * 0.5}`} fill="none" stroke="#475569" strokeWidth={1.4} />}
          {object.fieldType === "radio" && <circle cx={frame.x + frame.width / 2} cy={frame.y + frame.height / 2} r={frame.width * 0.22} fill="#475569" />}
          {object.fieldType === "dropdown" && <path d={`M ${frame.x + frame.width - 14} ${frame.y + frame.height / 2 - 2} l 5 5 l 5 -5`} fill="none" stroke="#475569" strokeWidth={1.4} />}
          {(object.fieldType === "text" || object.fieldType === "dropdown" || object.fieldType === "signature") && (
            <text x={frame.x + 4} y={frame.y + Math.min(frame.height - 4, object.fontSize + 2)} fontSize={Math.min(object.fontSize, frame.height - 4)} fill="#475569" style={{ font: `italic ${Math.min(object.fontSize, Math.max(8, frame.height - 4))}px sans-serif` }}>
              {object.fieldType === "signature" ? `Signature: ${label}` : label}
            </text>
          )}
        </g>
      );
    }
  }
}
