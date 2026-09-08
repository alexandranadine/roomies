import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number
}

function baseProps({ size = 20, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    ...props,
  }
}

export function HouseIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
    </svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function ChatIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H10l-4 3v-3H7.5A2.5 2.5 0 0 1 5 13.5v-7Z" />
    </svg>
  )
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.5 16h11l-1.2-1.4a2 2 0 0 1-.4-1.2V10a4.9 4.9 0 0 0-9.8 0v3.4a2 2 0 0 1-.4 1.2L6.5 16Z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
    </svg>
  )
}

export function PeopleIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="9" cy="8" r="2.5" />
      <circle cx="16" cy="9" r="2" />
      <path d="M4.5 17.5c.8-2.4 2.6-3.5 4.5-3.5s3.7 1.1 4.5 3.5" />
      <path d="M14 14c1.4 0 2.8.7 3.6 2.5" />
    </svg>
  )
}

export function PlaneIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M10.5 13.5 4 11l1-2 6 1.5L16.5 4l2 1-2.5 7.5L21 14l-1 2-6.5-1.5L11 21l-2-1 1.5-6.5Z" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M5 12.5 9.5 17 19 7.5" />
    </svg>
  )
}

export function CartIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M4 5h2l1.4 9.2a1.5 1.5 0 0 0 1.5 1.3h7.4a1.5 1.5 0 0 0 1.5-1.2L19.5 8H8" />
      <circle cx="10" cy="19.5" r="1.2" />
      <circle cx="16.5" cy="19.5" r="1.2" />
    </svg>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="4" y="6" width="16" height="14" rx="2" />
      <path d="M8 4v4M16 4v4M4 10h16" />
    </svg>
  )
}

export function ImageIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m7.5 16 3-3.5 2.5 2.5 3-4L18.5 16" />
    </svg>
  )
}

export function ClipboardIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="6" y="5" width="12" height="15" rx="2" />
      <path d="M9 5.5h6V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v1.5Z" />
      <path d="M9 11h6M9 15h4" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function ProfileIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="12" cy="9" r="3.2" />
      <path d="M5.5 19c1.2-3 3.3-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
    </svg>
  )
}

export function HeartIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 19s-6.5-4.1-8.2-7.3C2.3 9.2 3.4 6.5 6 5.7c1.6-.5 3.2.1 4 1.3.8-1.2 2.4-1.8 4-1.3 2.6.8 3.7 3.5 2.2 6C18.5 14.9 12 19 12 19Z" />
    </svg>
  )
}

export function CommentIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6 6.5A2.5 2.5 0 0 1 8.5 4h7A2.5 2.5 0 0 1 18 6.5v5A2.5 2.5 0 0 1 15.5 14H10l-3.5 2.5V14H8.5A2.5 2.5 0 0 1 6 11.5v-5Z" />
    </svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...baseProps({ ...props, strokeWidth: props.strokeWidth ?? 2 })}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...baseProps({ ...props, fill: 'currentColor', stroke: 'none' })}>
      <path d="m12 3.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.8 7.2 18.4l.9-5.4-3.9-3.8 5.4-.8L12 3.5Z" />
    </svg>
  )
}

export function WrenchIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M14.5 5.5a3.5 3.5 0 0 0-4.7 4.7L4 16v4h4l5.8-5.8a3.5 3.5 0 0 0 4.7-4.7l-2.7 2.7-2.5-2.5 2.2-2.2Z" />
    </svg>
  )
}

export function GuestIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="10" cy="9" r="3" />
      <path d="M4.5 18.5c.9-2.8 2.8-4 5.5-4s4.6 1.2 5.5 4" />
      <path d="M17 8v5M14.5 10.5H19.5" />
    </svg>
  )
}

export function TaskBoxIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <path d="m8.5 12 2.3 2.3 4.7-4.8" />
    </svg>
  )
}

export function StatusDotIcon({
  tone = 'home',
  size = 10,
}: {
  tone?: 'home' | 'away' | 'busy' | 'neutral'
  size?: number
}) {
  const fill =
    tone === 'home'
      ? 'var(--color-sage)'
      : tone === 'away'
        ? 'var(--color-ochre)'
        : tone === 'busy'
          ? 'var(--color-rose)'
          : 'var(--color-ink-muted)'

  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <circle cx="5" cy="5" r="4" fill={fill} />
    </svg>
  )
}
