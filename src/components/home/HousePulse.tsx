import type { HousePulseData } from '../../data/home-types'
import {
  CalendarIcon,
  CartIcon,
  CheckIcon,
  ChevronRightIcon,
  HouseIcon,
  PeopleIcon,
  PlaneIcon,
} from './icons'

type HousePulseProps = {
  data: HousePulseData
}

const iconMap = {
  people: PeopleIcon,
  plane: PlaneIcon,
  check: CheckIcon,
  cart: CartIcon,
} as const

export function HousePulse({ data }: HousePulseProps) {
  return (
    <section className="px-4 pb-2.5" aria-label="House pulse">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <div className="flex min-w-0 shrink-0 items-center gap-1.5">
            <HouseIcon
              size={14}
              className="shrink-0 text-[var(--color-sage)]"
            />
            <h2 className="text-[13px] font-semibold whitespace-nowrap text-[var(--color-espresso)]">
              House Pulse
            </h2>
          </div>
          <div className="ml-auto flex min-w-0 items-center justify-end gap-x-2 overflow-x-auto text-[11px] font-medium whitespace-nowrap text-[var(--color-ink-muted)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {data.stats.map((stat) => {
              const Icon = iconMap[stat.icon]
              return (
                <span
                  key={stat.id}
                  className={`inline-flex shrink-0 items-center gap-0.5 ${
                    stat.emphasis === 'danger'
                      ? 'text-[var(--color-danger)]'
                      : ''
                  }`}
                >
                  <Icon size={11} />
                  <span>
                    {stat.value} {stat.label}
                  </span>
                </span>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          className="flex w-full items-center gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-cream)] px-3 py-1 text-left transition-colors hover:bg-[var(--color-cream-deep)]"
        >
          <CalendarIcon
            size={13}
            className="shrink-0 text-[var(--color-rose)]"
          />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-espresso)]">
            {data.upcomingLabel}
          </span>
          <ChevronRightIcon
            size={14}
            className="shrink-0 text-[var(--color-ink-muted)]"
          />
        </button>
      </div>
    </section>
  )
}
