import type {
  CreateSheetAction,
  CreateSheetActionId,
} from '../../data/home-types'
import {
  CalendarIcon,
  CartIcon,
  ChatIcon,
  GuestIcon,
  TaskBoxIcon,
  WrenchIcon,
} from './icons'

type CreateSheetProps = {
  open: boolean
  actions: CreateSheetAction[]
  onClose: () => void
  onSelect?: (id: CreateSheetActionId) => void
}

const iconMap = {
  post: ChatIcon,
  task: TaskBoxIcon,
  event: CalendarIcon,
  supply: CartIcon,
  guest: GuestIcon,
  maintenance: WrenchIcon,
} as const

export function CreateSheet({
  open,
  actions,
  onClose,
  onSelect,
}: CreateSheetProps) {
  if (!open) return null

  return (
    <div className="absolute inset-0 z-30 flex items-end">
      <button
        type="button"
        aria-label="Dismiss create sheet"
        className="absolute inset-0 bg-[rgb(44_36_27_/_0.35)]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create something"
        className="relative max-h-[min(82dvh,640px)] w-full overflow-y-auto rounded-t-[22px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 pb-6 shadow-[0_-8px_30px_rgb(44_36_27_/_0.12)]"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[var(--color-border)]" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--color-espresso)]">
            Create
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--color-ink-muted)] hover:bg-[var(--color-cream-deep)] hover:text-[var(--color-espresso)]"
          >
            Close
          </button>
        </div>
        <ul className="space-y-2">
          {actions.map((action) => {
            const Icon = iconMap[action.icon]
            return (
              <li key={action.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect?.(action.id)
                    onClose()
                  }}
                  className="flex w-full items-center gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-cream)] px-3 py-3 text-left transition-colors hover:bg-[var(--color-cream-deep)]"
                >
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-sage-deep)]">
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[var(--color-espresso)]">
                      {action.label}
                    </span>
                    <span className="block text-xs text-[var(--color-ink-muted)]">
                      {action.description}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
