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
    <section className="px-4 pb-4" aria-label="Quick actions">
      <div className="grid grid-cols-4 gap-2">
        {actions.map((action) => {
          const Icon = iconMap[action.icon]
          const toneClass =
            action.tone === 'rose'
              ? 'text-[var(--color-rose)]'
              : 'text-[var(--color-sage-deep)]'

          return (
            <button
              key={action.id}
              type="button"
              onClick={() => onSelect?.(action.id)}
              className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-2 text-center shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-cream)]"
            >
              <Icon size={18} className={toneClass} />
              <span className="text-[11px] leading-tight font-semibold text-[var(--color-espresso)]">
                {action.label}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
