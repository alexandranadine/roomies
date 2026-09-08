import type { HouseholdSummary } from '../../data/home-types'
import { BellIcon, ChatIcon, ChevronDownIcon, HouseIcon } from './icons'

type HomeHeaderProps = {
  household: HouseholdSummary
}

export function HomeHeader({ household }: HomeHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-3 px-4 pt-5 pb-3">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] leading-none font-extrabold tracking-tight text-[var(--color-espresso)]">
          {household.brand}
        </h1>
        <button
          type="button"
          className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-lg text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-espresso)]"
        >
          <HouseIcon size={15} className="shrink-0 text-[var(--color-sage)]" />
          <span className="truncate">{household.name}</span>
          <ChevronDownIcon size={14} className="shrink-0" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 pt-0.5">
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
          <span className="absolute top-1.5 right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] leading-none font-bold text-white">
            {household.notificationCount}
          </span>
        </button>
      </div>
    </header>
  )
}
