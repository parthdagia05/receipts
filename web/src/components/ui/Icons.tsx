import type { SVGProps } from 'react';

/**
 * The app's complete icon set.
 *
 * One stroke weight (1.5), one default size (16) and one geometry style
 * throughout, so icons never look borrowed from different libraries. Drawn
 * inline rather than pulled from an icon package: the app uses about twenty,
 * and a dependency would ship thousands.
 */

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const DashboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

export const ExploreIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5.5-5.5 2 2-5.5z" />
  </Icon>
);

export const ReviewsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12a8.5 8.5 0 0 1-11.9 7.8L3 21l1.2-6.1A8.5 8.5 0 1 1 21 12Z" />
    <path d="M8.5 11.5h7M8.5 14.5h4" />
  </Icon>
);

export const AgentsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.8 20 7v10l-8 4.2L4 17V7Z" />
    <path d="M4 7l8 4.2L20 7M12 11.2V21" />
  </Icon>
);

export const DocsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5Z" />
    <path d="M5 17.5h14M9 7.5h6M9 11h6" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const WalletIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H18a1 1 0 0 1 1 1v1.5" />
    <rect x="3" y="7.5" width="18" height="12" rx="2" />
    <circle cx="16.5" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);

export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.8 5 5.5v6c0 4.3 2.9 8.2 7 9.7 4.1-1.5 7-5.4 7-9.7v-6Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
  </Icon>
);

export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5 11 13" />
    <path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16.5V11" />
    <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const TourIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.7.3-.9.8-.9 1.5v.4" />
    <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 5.5 7 6.5-7 6.5" />
  </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 5.5-7 6.5 7 6.5" />
  </Icon>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4" />
    <path d="M5.3 5.2 3.5 13.5v4A1.5 1.5 0 0 0 5 19h14a1.5 1.5 0 0 0 1.5-1.5v-4L18.7 5.2A1.5 1.5 0 0 0 17.3 4H6.7a1.5 1.5 0 0 0-1.4 1.2Z" />
  </Icon>
);

export const PanelIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Icon>
);

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-13.7-5.3L3.5 8.5" />
    <path d="M4 13a8 8 0 0 0 13.7 5.3l2.8-2.8" />
    <path d="M3.5 4.5v4h4M20.5 19.5v-4h-4" />
  </Icon>
);

export const SpinnerIcon = ({ size = 16, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    style={{ animation: 'spin 0.8s linear infinite' }}
    {...props}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
