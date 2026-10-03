import type { ReactNode } from "react";

/** 24 px line icons. Decorative: the control beside them carries the name. */
const Svg = ({ size = 24, children, className }: { size?: number; children: ReactNode; className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    {children}
  </svg>
);

type P = { size?: number; className?: string };

// #region request types
const Water = (p: P) => (
  <Svg {...p}>
    <path d="M12 3c3.6 4.4 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.4-6.6 6-11z" />
    <path d="M9.5 14.5a2.6 2.6 0 0 0 2.5 2.5" />
  </Svg>
);
const Snacks = (p: P) => (
  <Svg {...p}>
    <path d="M12 7.5c-1.2-1.6-3.4-2.2-5.2-1.4C4.1 7.3 3.6 10.9 4.8 14c1 2.8 3.2 6 5.2 6 .9 0 1.3-.5 2-.5s1.1.5 2 .5c2 0 4.2-3.2 5.2-6 1.2-3.1.7-6.7-2-7.9-1.8-.8-4-.2-5.2 1.4z" />
    <path d="M12 7.5c0-2 .8-3.6 2.8-4.5" />
  </Svg>
);
const Gas = (p: P) => (
  <Svg {...p}>
    <path d="M5 8.5 8.5 5H17a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
    <path d="M9 3h4v2H9z" />
    <path d="m9 11 6 6M15 11l-6 6" />
  </Svg>
);
const Swap = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h14l-3.5-3.5" />
    <path d="M20 16H6l3.5 3.5" />
  </Svg>
);
const Mower = (p: P) => (
  <Svg {...p}>
    <path d="M3 15.5h13l1.5-5H6z" />
    <path d="M17.5 10.5 20.5 3" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="14.5" cy="18.5" r="2" />
  </Svg>
);
const Trimmer = (p: P) => (
  <Svg {...p}>
    <path d="M5 3l11 13" />
    <path d="M8.5 7h4" />
    <circle cx="17" cy="17.5" r="2.5" />
    <path d="M14 21.5h6" />
  </Svg>
);
const Loppers = (p: P) => (
  <Svg {...p}>
    <path d="M12 12 4 20M12 12l8 8" />
    <path d="M12 12c-1.5-3-1.5-6 0-9 1.5 3 1.5 6 0 9z" />
    <path d="M9 9l6 0" />
  </Svg>
);
const Shovel = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v10" />
    <path d="M9.5 3h5" />
    <path d="M8 13h8v3a4 4 0 0 1-8 0z" />
  </Svg>
);
const Broom = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v9" />
    <path d="M7 12h10l2 9H5z" />
    <path d="M9.5 15.5V21M12 15.5V21M14.5 15.5V21" />
  </Svg>
);
const TrashBag = (p: P) => (
  <Svg {...p}>
    <path d="M9 8h6l3.5 12a1 1 0 0 1-1 1.3h-11a1 1 0 0 1-1-1.3z" />
    <path d="M9 8c0-2 1.3-3.5 3-3.5S15 6 15 8" />
    <path d="M10.5 4.5 9 3M13.5 4.5 15 3" />
  </Svg>
);
const Other = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" strokeWidth="3" />
  </Svg>
);

const BY_KEY: Record<string, (p: P) => ReactNode> = {
  water: Water,
  snacks: Snacks,
  gas_mower: Gas,
  gas_trimmer: Gas,
  swap_mower: Swap,
  swap_trimmer: Swap,
  mower: Mower,
  trimmer: Trimmer,
  loppers: Loppers,
  shovels: Shovel,
  brooms: Broom,
  trash_bags: TrashBag,
  other: Other,
};

/** Icon for a request type key; unknown keys (admin-added types) get the generic box. */
export const TypeIcon = ({ typeKey, size = 24, className }: { typeKey: string; size?: number; className?: string }) => {
  const I = BY_KEY[typeKey] ?? Other;
  return <I size={size} className={className} />;
};
// #endregion

// #region actions
export const PhoneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 4h3.5l1.5 4.5-2.2 1.3a11 11 0 0 0 6.4 6.4l1.3-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4z" />
  </Svg>
);
export const TextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
  </Svg>
);
export const DirectionsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2.8 21.2 12 12 21.2 2.8 12z" />
    <path d="M9 13.5V11h5.5M12.5 8.5 15 11l-2.5 2.5" />
  </Svg>
);
export const MegaphoneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 10v4h3l7 4V6L6 10z" />
    <path d="M16.5 9a4 4 0 0 1 0 6" />
    <path d="M7 14.5 8.5 20" />
  </Svg>
);
export const TruckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7z" />
    <circle cx="6.5" cy="17.5" r="1.8" />
    <circle cx="16.5" cy="17.5" r="1.8" />
  </Svg>
);
export const BellIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" strokeWidth="2.6" />
  </Svg>
);
export const ChevronIcon = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const PinIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
);
// #endregion
