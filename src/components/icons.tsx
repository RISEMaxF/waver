// Inline SVG icon set — stroke-based, inherit `currentColor`, consistent 24 viewBox.
// One place so every control uses the same visual language (no emoji).

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({
  size = 16,
  className,
  strokeWidth = 2,
  children,
}: IconProps & { children: React.ReactNode }) {
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
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11" />
    <path d="M8 10l4 4 4-4" />
    <path d="M4 20h16" />
  </Svg>
);

export const IconExport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21V10" />
    <path d="M8 14l4-4 4 4" />
    <path d="M4 4h16" />
  </Svg>
);

// Fit to width: inward-pointing arrows between two vertical bounds.
export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5v14" />
    <path d="M20 5v14" />
    <path d="M8 12h8" />
    <path d="M8 12l3-3M8 12l3 3" />
    <path d="M16 12l-3-3M16 12l-3 3" />
  </Svg>
);

// Fold all tracks: stacked horizontal lines collapsing toward center.
export const IconFoldAll = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h16" />
    <path d="M9 8l3-3 3 3" />
    <path d="M9 16l3 3 3-3" />
  </Svg>
);

// Input microphone (labels the input meter; W-12).
export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0014 0" />
    <path d="M12 18v3" />
  </Svg>
);

// Zoom to selection: magnifier framed by selection corners (W-29).
export const IconZoomSel = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="5" />
    <path d="M15 15l4 4" />
    <path d="M3 7V4a1 1 0 011-1h3" />
    <path d="M21 7V4a1 1 0 00-1-1h-3" />
    <path d="M3 17v3a1 1 0 001 1h3" />
  </Svg>
);

// Snap magnet.
export const IconMagnet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4v7a6 6 0 0012 0V4" />
    <path d="M6 8h4" />
    <path d="M14 8h4" />
  </Svg>
);

// Follow playhead: a pointer chevron chasing a line.
export const IconFollow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6v12" />
    <path d="M9 8l5 4-5 4z" fill="currentColor" />
    <path d="M18 6v12" />
  </Svg>
);

// Help / shortcuts.
export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 013.5-2.3c1 .4 1.5 1.3 1.5 2.3 0 1.6-2 2-2.5 3" />
    <path d="M12 17h.01" />
  </Svg>
);

export const IconNew = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M12 12v5M9.5 14.5h5" />
  </Svg>
);

export const IconOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 012-2h3.5l2 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </Svg>
);

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3h11l3 3v14a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" />
    <path d="M8 3v5h7" />
    <path d="M8 21v-6h8v6" />
  </Svg>
);

export const IconSaveAs = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4a1 1 0 011-1h9l3 3v6" />
    <path d="M4 4v16a1 1 0 001 1h6" />
    <path d="M8 3v5h6" />
    <path d="M20.5 14.5l-6 6-2.5.7.7-2.5 6-6a1.2 1.2 0 011.8 1.8z" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
  </Svg>
);

export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 010-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 014 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p} strokeWidth={p.strokeWidth ?? 2}>
    <path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" />
  </Svg>
);

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4v16M16 4v16" strokeWidth={p.strokeWidth ?? 2.6} />
  </Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect
      x="6"
      y="6"
      width="12"
      height="12"
      rx="1.5"
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);

export const IconRecord = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.5-4.5M10.5 7.5v6M7.5 10.5h6" />
  </Svg>
);

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.5-4.5M7.5 10.5h6" />
  </Svg>
);

export const IconSplit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <path d="M7 8l-2 4 2 4M17 8l2 4-2 4" />
  </Svg>
);

export const IconCut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M8.2 7.5L20 18M8.2 16.5L20 6" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 012-2h8" />
  </Svg>
);

export const IconDuplicate = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 012-2h8" />
    <path d="M14.5 12v5M12 14.5h5" />
  </Svg>
);

export const IconPaste = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4h6v3H9z" />
    <path d="M9 5H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-3" />
  </Svg>
);

export const IconChannels = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h16M4 16h16" />
    <path d="M7 5l-2 3 2 3M7 13l-2 3 2 3" strokeWidth={p.strokeWidth ?? 1.6} />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
    <path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 7L4 12l5 5" />
    <path d="M4 12h11a5 5 0 015 5v0" />
  </Svg>
);

export const IconRedo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 7l5 5-5 5" />
    <path d="M20 12H9a5 5 0 00-5 5v0" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4h16v16H4z" />
    <path
      d="M10 4v16M16 4v16M4 10h16M4 16h16"
      strokeWidth={p.strokeWidth ?? 1.4}
    />
  </Svg>
);

export const IconMute = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M16 9l5 5M21 9l-5 5" />
  </Svg>
);

export const IconSolo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13v-1a8 8 0 0116 0v1" />
    <rect x="3" y="13" width="4" height="7" rx="1.5" />
    <rect x="17" y="13" width="4" height="7" rx="1.5" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 11-2.6-6.4" />
    <path d="M21 3v5h-5" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
