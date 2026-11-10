import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "arrow"
  | "arrow-up"
  | "check"
  | "shield"
  | "pause"
  | "external"
  | "copy"
  | "chevron"
  | "close"
  | "menu"
  | "back"
  | "file"
  | "chip"
  | "pod"
  | "wallet"
  | "bolt"
  | "coins"
  | "user-check"
  | "laptop"
  | "chat"
  | "list"
  | "key";
const paths: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  "arrow-up": <path d="M6 18 18 6M6 6h12v12" />,
  check: <path d="m5 12 4 4L19 6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  external: <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  file: (
    <>
      <path d="M14 3H5v18h14V8l-5-5Z" />
      <path d="M14 3v5h5M8 13h8M8 17h6" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </>
  ),
  pod: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="19" cy="16" r="1.8" />
      <circle cx="5" cy="16" r="1.8" />
      <path d="M12 5.8v3.6M17.4 15.1l-3.2-1.8M6.6 15.1l3.2-1.8" />
    </>
  ),
  wallet: (
    <>
      <path d="M19 7V5H5a2 2 0 0 0 0 4h15v10H5a2 2 0 0 1-2-2V7" />
      <circle cx="16.5" cy="14" r="1" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  coins: (
    <>
      <ellipse cx="9" cy="7" rx="6" ry="3" />
      <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
      <path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3" />
    </>
  ),
  "user-check": (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5M16 11l2 2 4-4" />
    </>
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4V5Z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9m-3 3 3 3m-6 0 2 2" />
    </>
  ),
};
export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.45}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
