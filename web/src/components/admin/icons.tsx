/** Small stroke icons for admin controls. Decorative; the control carries the name. */
const Svg = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const PlusIcon = () => <Svg d="M12 5v14M5 12h14" />;
export const UpIcon = () => <Svg d="M6 15l6-6 6 6" />;
export const DownIcon = () => <Svg d="M6 9l6 6 6-6" />;
export const EditIcon = () => <Svg d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />;
export const TrashIcon = () => <Svg d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />;
export const CopyIcon = () => <Svg d="M9 9h11v11H9zM5 15H4V4h11v1" />;
export const PhoneIcon = () => <Svg d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />;
export const PinIcon = () => <Svg d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />;
export const RectIcon = () => <Svg d="M4 4h16v16H4z" />;
export const DownloadIcon = () => <Svg d="M12 4v11M7 10l5 5 5-5M5 20h14" />;
export const PrintIcon = () => <Svg d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z" />;
export const ChevronIcon = () => <Svg d="M9 6l6 6-6 6" />;
export const UploadIcon = () => <Svg d="M12 20V9M7 14l5-5 5 5M5 4h14" />;
