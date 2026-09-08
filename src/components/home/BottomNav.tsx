import type { ReactNode } from 'react'

import {
  ClipboardIcon,
  HouseIcon,
  PeopleIcon,
  PlusIcon,
  ProfileIcon,
} from './icons'

type BottomNavProps = {
  active?: 'home' | 'tasks' | 'house' | 'profile'
  onCreate?: () => void
}

export function BottomNav({ active = 'home', onCreate }: BottomNavProps) {
  return (
    <nav
      aria-label="Primary"
      className="absolute inset-x-0 bottom-0 z-20 border-t border-[rgb(255_255_255_/_0.08)] bg-[var(--color-nav)] px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="relative grid grid-cols-5 items-end">
        <NavTab
          label="Home"
          active={active === 'home'}
          icon={
            <HouseIcon size={22} strokeWidth={active === 'home' ? 2.2 : 1.75} />
          }
        />
        <NavTab
          label="Tasks"
          active={active === 'tasks'}
          icon={<ClipboardIcon size={21} />}
        />

        <div className="relative flex justify-center">
          <button
            type="button"
            onClick={onCreate}
            aria-label="Create"
            className="absolute bottom-1 inline-flex h-14 w-14 -translate-y-3 items-center justify-center rounded-full bg-[var(--color-sage-deep)] text-white shadow-[0_6px_16px_rgb(61_90_64_/_0.35)] ring-[3px] ring-[var(--color-cream)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            <PlusIcon size={26} strokeWidth={2.25} />
          </button>
          <span className="h-12" aria-hidden />
        </div>

        <NavTab
          label="House"
          active={active === 'house'}
          icon={<PeopleIcon size={21} />}
        />
        <NavTab
          label="Profile"
          active={active === 'profile'}
          icon={<ProfileIcon size={21} />}
        />
      </div>
    </nav>
  )
}

function NavTab({
  label,
  active,
  icon,
}: {
  label: string
  active?: boolean
  icon: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors ${
        active ? 'text-white' : 'text-white/55 hover:text-white/85'
      }`}
    >
      {icon}
      <span className="text-[10px] font-semibold tracking-wide">{label}</span>
    </button>
  )
}
