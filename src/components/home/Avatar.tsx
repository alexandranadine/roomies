type AvatarProps = {
  initials: string
  tone: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  isPet?: boolean
  className?: string
}

const sizeMap = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
  xl: 'h-12 w-12 text-sm',
} as const

export function Avatar({
  initials,
  tone,
  size = 'md',
  isPet = false,
  className = '',
}: AvatarProps) {
  return (
    <div
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-[var(--color-cream)] ${sizeMap[size]} ${className}`}
      style={{ backgroundColor: tone }}
      aria-hidden
    >
      {isPet ? (
        <svg
          width="60%"
          height="60%"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
        >
          <path d="M6.5 9.5 4 5.5l4 1.2L10.5 4l1.2 3.2L14 4l1.5 2.7 4-1.2-2.5 4c.8 1.1 1.2 2.4 1.2 3.8 0 3.6-2.9 6.2-6.2 6.2S6 16.1 6 12.5c0-1.2.3-2.4 1-3.4l-.5.4Z" />
          <circle cx="9.2" cy="12.2" r="1" fill="#2c241b" />
          <circle cx="14.8" cy="12.2" r="1" fill="#2c241b" />
          <path
            d="M11.2 14.4c.3.5.8.8 1.3.8s1-.3 1.3-.8"
            fill="none"
            stroke="#2c241b"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        initials.slice(0, 2)
      )}
    </div>
  )
}
