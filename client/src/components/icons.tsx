import type { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>, d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em" {...props}>
    <path d={d} />
  </svg>
);

export const X = (p: SVGProps<SVGSVGElement>) => base(p, "M18 6 6 18M6 6l12 12");
export const Plus = (p: SVGProps<SVGSVGElement>) => base(p, "M12 5v14M5 12h14");
export const Pencil = (p: SVGProps<SVGSVGElement>) => base(p, "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z");
export const Trash = (p: SVGProps<SVGSVGElement>) => base(p, "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6");
export const CloudOff = (p: SVGProps<SVGSVGElement>) => base(p, "M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3M1 1l22 22");
export const CloudCheck = (p: SVGProps<SVGSVGElement>) => base(p, "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9ZM3 22v-4M3 14v-4");
export const Chart = (p: SVGProps<SVGSVGElement>) => base(p, "M3 3v18h18M8 17v-5m5 5V8m5 9v-3");
export const Grid = (p: SVGProps<SVGSVGElement>) => base(p, "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z");
export const Leaf = (p: SVGProps<SVGSVGElement>) => base(p, "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12");
export const Basket = (p: SVGProps<SVGSVGElement>) => base(p, "M15.5 21H8.5a2 2 0 0 1-1.97-1.63L4.5 9h15l-2.03 10.36A2 2 0 0 1 15.5 21ZM16 9a4 4 0 0 0-8 0");
export const Box = (p: SVGProps<SVGSVGElement>) => base(p, "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.3 7l8.7 5 8.7-5M12 22V12");
export const Logout = (p: SVGProps<SVGSVGElement>) => base(p, "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9");
export const Warning = (p: SVGProps<SVGSVGElement>) => base(p, "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01");
export const WifiOff = (p: SVGProps<SVGSVGElement>) => base(p, "M2 8.82a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M1 1l22 22M12 20h.01");