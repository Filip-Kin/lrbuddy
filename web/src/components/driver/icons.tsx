import type { ReactNode } from "react";

const Svg = ({ size = 22, children }: { size?: number; children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const NavigateIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 11l18-8-8 18-2-8z" />
  </Svg>
);

export const PhoneIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />
  </Svg>
);

export const CheckIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
);

export const TruckIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2 6h12v10H2zM14 9h4.5l3.5 3.5V16h-8" />
    <circle cx="6.5" cy="17.5" r="1.8" />
    <circle cx="17.5" cy="17.5" r="1.8" />
  </Svg>
);

export const FlagIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 21V4M5 4h12l-2 4 2 4H5" />
  </Svg>
);

export const BoxIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z" />
    <path d="M3 7.5l9 4.5 9-4.5M12 12v9" />
  </Svg>
);

export const ChevronIcon = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

export const MinusIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 12h14" />
  </Svg>
);

export const PlusIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const MapIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 4L3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5z" />
    <path d="M9 4v13.5M15 6.5V20" />
  </Svg>
);

/** Arrow pointing up, turned by `angle` degrees clockwise. */
export const ArrowIcon = ({ size, angle }: { size?: number; angle: number }) => (
  <span className="inline-grid place-items-center transition-transform duration-300" style={{ transform: `rotate(${angle}deg)` }}>
    <Svg size={size}>
      <path d="M12 20V5M5.5 11.5L12 5l6.5 6.5" />
    </Svg>
  </span>
);

/** Map pin, for an arrival. */
export const PinIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0113 0C18.5 14.8 12 21 12 21z" />
    <circle cx="12" cy="9.8" r="2.3" />
  </Svg>
);

export const RecenterIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5" />
  </Svg>
);

export const ListIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </Svg>
);
