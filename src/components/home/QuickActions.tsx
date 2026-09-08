import type { QuickAction, QuickActionId } from '../../data/home-types'
import { CalendarIcon, CartIcon, ChatIcon, TaskBoxIcon } from './icons'

type QuickActionsProps = {
  actions: QuickAction[]
  onSelect?: (id: QuickActionId) => void
}

const iconMap = {
  post: ChatIcon,
  task: TaskBoxIcon,
  event: CalendarIcon,
  supply: CartIcon,
} as const

export function QuickActions({ actions, onSelect }: QuickActionsProps) {
  return (
    <section className="px-4 pb-3.5" aria-label="Quick actions">
      <div className="grid grid-cols-4 gap-1.5">
        {actions.map((action) => {
          const Icon = iconMap[action.icon]
          const toneClass =
            action.tone === 'rose'
              ? 'text-[var(--color-rose)]'
              : 'text-[var(--color-sage)]'

          return (
            <button
              key={action.id}
              type="button"
              onClick={() => onSelect?.(action.id)}
              className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-cream)]/70 px-1 py-1.5 text-center transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-cream-deep)]"
            >
              <Icon size={17} className={toneClass} />
              <span className="text-[11px] leading-tight font-medium text-[var(--color-espresso)]">
                {action.label}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
