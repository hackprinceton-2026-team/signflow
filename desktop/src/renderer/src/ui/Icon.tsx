import type { SVGProps } from 'react';

/**
 * SignFlow's icon set: 24×24, 1.75px rounded strokes, drawn inline so there is
 * no icon font or CDN to load (and nothing for the CSP to allow).
 */
const PATHS = {
  live: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.75" />
      <path d="M16 10.4 21 7.5v9L16 13.6" />
    </>
  ),
  workspace: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.75" />
      <path d="M9.5 4v16M9.5 11.5H21" />
    </>
  ),
  notes: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2.75" />
      <path d="M9 8h6M9 12h6M9 16h3.5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M19 7h1M4 17h3M13 17h7" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="10" cy="17" r="2.5" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8.75A2.75 2.75 0 0 1 5.75 6h1.5l1.5-2h6.5l1.5 2h1.5A2.75 2.75 0 0 1 21 8.75v8.5A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  cameraOff: (
    <>
      <path d="M8.75 4h6.5l1.5 2h1.5A2.75 2.75 0 0 1 21 8.75v8.5c0 .6-.2 1.2-.5 1.6M18 20H5.75A2.75 2.75 0 0 1 3 17.25v-8.5A2.75 2.75 0 0 1 5.75 6" />
      <path d="M3 3l18 18M10 10.2a3.5 3.5 0 0 0 4.8 4.8" />
    </>
  ),
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  edit: (
    <>
      <path d="M4 20l1-4.2L16.3 4.5a2.1 2.1 0 0 1 3 0l.2.2a2.1 2.1 0 0 1 0 3L8.2 19z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9.75v4.5h3.25L12 18.5v-13L7.25 9.75z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
    </>
  ),
  captions: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10.6 10.3a2.2 2.2 0 1 0 0 3.4M16.8 10.3a2.2 2.2 0 1 0 0 3.4" />
    </>
  ),
  focus: <path d="M4 9V5.75A1.75 1.75 0 0 1 5.75 4H9M15 4h3.25A1.75 1.75 0 0 1 20 5.75V9M20 15v3.25A1.75 1.75 0 0 1 18.25 20H15M9 20H5.75A1.75 1.75 0 0 1 4 18.25V15" />,
  focusExit: <path d="M9 4v3.25A1.75 1.75 0 0 1 7.25 9H4M20 9h-3.25A1.75 1.75 0 0 1 15 7.25V4M15 20v-3.25A1.75 1.75 0 0 1 16.75 15H20M4 15h3.25A1.75 1.75 0 0 1 9 16.75V20" />,
  mirror: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2.5" />
      <path d="M9 7.5 4 16.5h5zM15 7.5l5 9h-5z" />
    </>
  ),
  play: <path d="M8 5.75v12.5a.75.75 0 0 0 1.14.64l10.2-6.25a.75.75 0 0 0 0-1.28L9.14 5.1A.75.75 0 0 0 8 5.75z" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12.1A1.75 1.75 0 0 0 9.15 20.7h5.7a1.75 1.75 0 0 0 1.75-1.6L17.5 7M9 7V4.75A1.75 1.75 0 0 1 10.75 3h2.5A1.75 1.75 0 0 1 15 4.75V7" />
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" />,
  retry: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.25h-4.25" />,
  alert: (
    <>
      <path d="M10.3 4.6 3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z" />
      <path d="M12 10v3.5M12 16.8v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8v.2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6v5.5c0 4.3 3 7.8 7 9 4-1.2 7-4.7 7-9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14.5h8" />
    </>
  ),
  sparkle: <path d="M12 4.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z" />,
  chevronDown: <path d="m7 10 5 5 5-5" />,
  chevronRight: <path d="m10 7 5 5-5 5" />,
  hand: (
    <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5V5a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.7a5.5 5.5 0 0 1-4.3-2.1L4.3 15.6a1.6 1.6 0 0 1 2.3-2.2L8 14.8" />
  ),
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  size?: number;
  /** Accessible name. Omit for decorative icons (the default). */
  title?: string;
}

export function Icon({ name, size = 18, title, strokeWidth = 1.75, ...rest }: IconProps) {
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
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      className="ui-icon"
      {...rest}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
