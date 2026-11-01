import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlay = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 4.5 19 12 7 19.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (props: IconProps) => (
  <Svg {...props}>
    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconStop = (props: IconProps) => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);

export const IconMinus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 12h12" />
  </Svg>
);

export const IconRefresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 11a8 8 0 1 0-2.3 6.2" />
    <path d="M20 4v7h-7" />
  </Svg>
);

export const IconEye = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3.1" />
  </Svg>
);

export const IconEyeOff = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 4l16 16" />
    <path d="M10.3 6.1A8.6 8.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17.4 17.4 0 0 1-2.6 3.4M6.2 7.9A17.2 17.2 0 0 0 2.5 12S6 18 12 18a8.9 8.9 0 0 0 3.2-.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);

export const IconSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const IconLog = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="m7 9 3 2.5-3 2.5M12.5 15h4" />
  </Svg>
);

export const IconShield = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5 19 6v6c0 4.2-3 7-7 8.5-4-1.5-7-4.3-7-8.5V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const IconLogout = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H14" />
    <path d="M17 8.5 20.5 12 17 15.5M10 12h10" />
  </Svg>
);

export const IconUser = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20c.9-3.6 3.9-5.6 7.5-5.6s6.6 2 7.5 5.6" />
  </Svg>
);

export const IconLock = (props: IconProps) => (
  <Svg {...props}>
    <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </Svg>
);

export const IconSparkle = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9z" />
  </Svg>
);

export const IconMaximize = (props: IconProps) => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.4" />
  </Svg>
);

export const IconRestore = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5.5" y="8.5" width="10" height="10" rx="1.2" />
    <path d="M8.5 8.5v-2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" />
  </Svg>
);

export const IconClose = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const IconChevron = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

