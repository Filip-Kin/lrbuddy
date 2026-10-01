const Svg = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const CameraIcon = ({ size }: { size?: number }) => (
  <Svg size={size} d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5L9 4.5h6L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
);
export const PrevIcon = ({ size }: { size?: number }) => <Svg size={size} d="M15 5l-7 7 7 7" />;
export const NextIcon = ({ size }: { size?: number }) => <Svg size={size} d="M9 5l7 7-7 7" />;
export const CloseIcon = ({ size }: { size?: number }) => <Svg size={size} d="M6 6l12 12M18 6L6 18" />;
export const TrashIcon = ({ size }: { size?: number }) => <Svg size={size} d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />;
export const RetryIcon = ({ size }: { size?: number }) => <Svg size={size} d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />;
