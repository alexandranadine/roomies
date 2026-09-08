import { ClipboardIcon, HouseIcon, PlusIcon, ProfileIcon } from './icons'

type BottomNavProps = {
  active?: 'home' | 'tasks' | 'house' | 'profile'
  onCreate?: () => void
}

const tabClass = (active: boolean) =>
  `inline-flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-colors ${
    active ? 'text-white' : 'text-white/55 hover:text-white/85'
  }`

export function BottomNav({ active = 'home', onCreate }: BottomNavProps) {
  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-3"
    >
      <div className="pointer-events-auto relative mx-auto flex max-w-[430px] items-end justify-between rounded-[22px] bg-[var(--color-nav)] px-3 pt-2 pb-2 shadow-[0_8px_24px_rgb(44_36_27_/_0.18)]">
        <button
          type="button"
          className={tabClass(active === 'home')}
          aria-current={active === 'home' ? 'page' : undefined}
          aria-label="Home"
        >
          <HouseIcon size={22} strokeWidth={active === 'home' ? 2.1 : 1.75} />
          <span className="mt-0.5 text-[10px] font-semibold">Home</span>
        </button>

        <button
          type="button"
          className={tabClass(active === 'tasks')}
          aria-label="Tasks"
        >
          <ClipboardIcon size={21} />
          <span className="mt-0.5 text-[10px] font-semibold">Tasks</span>
        </button>

        <div className="relative -mt-7 flex w-16 justify-center">
          <button
            type="button"
            onClick={onCreate}
            aria-label="Create"
            className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-sage-deep)] text-white shadow-[0_6px_16px_rgb(61_90_64_/_0.35)] ring-4 ring-[var(--color-cream)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            <PlusIcon size={26} strokeWidth={2.25} />
          </button>
        </div>

        <button
          type="button"
          className={tabClass(active === 'house')}
          aria-label="House"
        >
          <HouseIcon size={21} />
          <span className="mt-0.5 text-[10px] font-semibold">House</span>
        </button>

        <button
          type="button"
          className={tabClass(active === 'profile')}
          aria-label="Profile"
        >
          <ProfileIcon size={21} />
          <span className="mt-0.5 text-[10px] font-semibold">Profile</span>
        </button>
      </div>
    </nav>
  )
}
