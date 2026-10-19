import type { SVGProps } from "react";

/**
 * The LanternPDF logo mark: a lantern whose light is a page. Original artwork, drawn with the theme colours
 * (indigo body, teal foot and text lines) so it follows light and dark mode. The standalone favicon is
 * public/favicon.svg and uses the same shapes with fixed colours.
 */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" {...props}>
      <path d="M13.1 6.6a2.9 2.9 0 1 1 5.8 0" fill="none" stroke="var(--primary)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.6 12 12.2 7.4h7.6L23.4 12z" fill="var(--primary)" />
      <rect x="8" y="11.6" width="16" height="2.2" rx="1.1" fill="var(--primary)" />
      <rect x="9.6" y="13.2" width="12.8" height="11" rx="2" fill="var(--primary)" />
      <path d="M12.9 14.9h3.8l2.5 2.5v5.2a.8.8 0 0 1-.8.8h-5.5a.8.8 0 0 1-.8-.8v-6.9a.8.8 0 0 1 .8-.8z" fill="#fff" />
      <path d="M16.7 14.9v2.5h2.5z" fill="var(--accent)" opacity="0.55" />
      <path d="M14 20h4M14 21.7h2.6" stroke="var(--accent)" strokeWidth="1.1" strokeLinecap="round" fill="none" />
      <rect x="8" y="24" width="16" height="2.2" rx="1.1" fill="var(--primary)" />
      <rect x="10.4" y="26.2" width="11.2" height="2.2" rx="1.1" fill="var(--accent)" />
    </svg>
  );
}

/** Decorative fan of pages for the home page hero. */
export function HeroArt(props: SVGProps<SVGSVGElement>) {
  const lines = (x: number, y: number) => (
    <g stroke="var(--border-strong)" strokeWidth="3" strokeLinecap="round">
      <path d={`M${x} ${y}h70`} />
      <path d={`M${x} ${y + 14}h92`} />
      <path d={`M${x} ${y + 28}h84`} />
      <path d={`M${x} ${y + 42}h58`} />
    </g>
  );
  return (
    <svg viewBox="0 0 420 380" aria-hidden="true" focusable="false" {...props}>
      <g transform="rotate(-14 210 200)">
        <rect x="70" y="40" width="190" height="260" rx="16" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
        {lines(94, 80)}
        <rect x="94" y="150" width="130" height="70" rx="8" fill="var(--accent-soft)" />
      </g>
      <g transform="rotate(10 210 200)">
        <rect x="170" y="50" width="190" height="260" rx="16" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
        {lines(194, 90)}
        <circle cx="290" cy="220" r="34" fill="var(--primary-soft)" />
        <path d="M274 220l12 12 22-24" stroke="var(--primary)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
      <g>
        <rect x="120" y="70" width="190" height="260" rx="16" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="2" />
        <path d="M262 70h32a16 16 0 0 1 16 16v32h-34a14 14 0 0 1-14-14z" fill="var(--primary-soft)" />
        <rect x="144" y="100" width="70" height="14" rx="7" fill="var(--primary)" />
        {lines(144, 140)}
        <rect x="144" y="212" width="142" height="86" rx="10" fill="color-mix(in srgb, var(--primary) 9%, var(--surface))" />
        <path d="M160 270l24-26 18 18 16-12 32 28" stroke="var(--primary)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.8" />
      </g>
    </svg>
  );
}
