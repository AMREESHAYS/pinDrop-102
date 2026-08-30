import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (props: P): P => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconLock = (p: P) => (
  <svg {...base(p)}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconUnlock = (p: P) => (
  <svg {...base(p)}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" />
    <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconNote = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.5h9l3.5 3.5v13.5H6z" />
    <path d="M15 3.5V7h3.5" />
    <path d="M9 12h6M9 15.5h6M9 8.5h2.5" />
  </svg>
);

export const IconLink = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 6.5 12.8 4.7a3.9 3.9 0 0 1 5.5 5.5L16.5 12" />
    <path d="M13 17.5l-1.8 1.8a3.9 3.9 0 0 1-5.5-5.5L7.5 12" />
  </svg>
);

export const IconFile = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.5h9l3.5 3.5v13.5H6z" />
    <path d="M15 3.5V7h3.5" />
    <path d="M12 16.5v-5M9.8 13.7 12 11.5l2.2 2.2" />
  </svg>
);

export const IconCopy = (p: P) => (
  <svg {...base(p)}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M5.5 15.5h-1a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5H14A1.5 1.5 0 0 1 15.5 5v.5" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 12.5 10 18 19.5 6.5" />
  </svg>
);

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6.5h16M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
    <path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6A1.5 1.5 0 0 0 16.5 20l1-13.5" />
    <path d="M10 10.5v7M14 10.5v7" />
  </svg>
);

export const IconEye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEyeOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3.2 3.9M6.1 8A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.9-.8" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
);

export const IconShare = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="17.5" cy="5.5" r="2.6" />
    <circle cx="17.5" cy="18.5" r="2.6" />
    <path d="M8.4 10.8 15.2 6.8M8.4 13.2l6.8 4" />
  </svg>
);

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconBackspace = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 5h11A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11L3 12z" />
    <path d="M11.5 9.5 16.5 14.5M16.5 9.5l-5 5" />
  </svg>
);

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
);

export const IconClock = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconFlame = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5c.6 3-1.8 4.6-3.2 6.3A6.7 6.7 0 0 0 12 21a6.8 6.8 0 0 0 6.5-7c0-3.8-3-5.4-3.6-8.5-1.4 1-2 2.4-1.9 4C11.6 8 10.8 5.4 12 3.5Z" />
    <path d="M12 21c-1.8-1-2.6-2.6-2.2-4.4.3-1.3 1.3-2 2.2-3.1.9 1.1 1.9 1.8 2.2 3.1.4 1.8-.4 3.4-2.2 4.4Z" />
  </svg>
);

export const IconKey = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M11.2 11.2 20 20M17 17l2-2M14.5 14.5l1.8-1.8" />
  </svg>
);

export const IconZap = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 3 5 13.5h5.5L11 21l8-10.5h-5.5z" />
  </svg>
);

export const IconArrowRight = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 12h16M13.5 5.5 20 12l-6.5 6.5" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconVaultDoor = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.4" />
    <path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.8 5.8l2.2 2.2M16 16l2.2 2.2M18.2 5.8 16 8M8 16l-2.2 2.2" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5 5 6v5.5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z" />
    <path d="M9 11.5l2.2 2.2L15.5 9" />
  </svg>
);

export const IconTerminal = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7 9.5l3 2.7-3 2.7M12.5 15.5H17" />
  </svg>
);

export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 15.5V4.5m0 0 4 4m-4-4-4 4" />
    <path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </svg>
);

export const IconCloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 17.5h10a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 6.9 9.6 4 4 0 0 0 7 17.5Z" />
  </svg>
);

export const IconGlobe = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c-2.6 2.3-3.9 5.1-3.9 8.5s1.3 6.2 3.9 8.5c2.6-2.3 3.9-5.1 3.9-8.5S14.6 5.8 12 3.5Z" />
  </svg>
);
