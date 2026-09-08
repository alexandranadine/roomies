import type { Roommate } from '../../data/home-types'
import { Avatar } from './Avatar'
import { ImageIcon } from './icons'

type PostComposerProps = {
  user: Roommate
  onFocusCompose?: () => void
}

export function PostComposer({ user, onFocusCompose }: PostComposerProps) {
  return (
    <section className="px-4 pb-2" aria-label="Share with the house">
      <div className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 shadow-[var(--shadow-soft)]">
        <Avatar initials={user.initials} tone={user.avatarTone} size="md" />
        <button
          type="button"
          onClick={onFocusCompose}
          className="min-w-0 flex-1 truncate text-left text-sm text-[var(--color-ink-muted)]"
        >
          Share something with the house…
        </button>
        <button
          type="button"
          aria-label="Add photo"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-cream-deep)] hover:text-[var(--color-espresso)]"
        >
          <ImageIcon size={18} />
        </button>
      </div>
    </section>
  )
}
