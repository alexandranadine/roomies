import type { HouseholdSummary } from '../../data/home-types'
import { BellIcon, ChatIcon, ChevronDownIcon, HouseIcon } from './icons'

type HomeHeaderProps = {
  household: HouseholdSummary
}

export function HomeHeader({ household }: HomeHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] leading-none font-extrabold tracking-tight text-[var(--color-espresso)]">
          {household.brand}
        </h1>
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-espresso)]"
        >
          <HouseIcon size={15} className="text-[var(--color-sage)]" />
          <span>{household.name}</span>
          <ChevronDownIcon size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          aria-label="Open chat"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-espresso)] transition-colors hover:bg-[var(--color-cream-deep)]"
        >
          <ChatIcon size={22} />
        </button>
        <button
          type="button"
          aria-label={`${household.notificationCount} notifications`}
          className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-espresso)] transition-colors hover:bg-[var(--color-cream-deep)]"
        >
          <BellIcon size={22} />
          <span className="absolute top-1 right-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-bold text-white">
            {household.notificationCount}
          </span>
        </button>
      </div>
    </header>
  )
}
