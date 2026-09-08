import type { Roommate } from '../../data/home-types'
import { Avatar } from './Avatar'
import { PlaneIcon, StatusDotIcon } from './icons'

type RoommateStatusRowProps = {
  roommates: Roommate[]
}

const statusClass: Record<Roommate['statusTone'], string> = {
  home: 'text-[var(--color-sage)]',
  away: 'text-[var(--color-ochre)]',
  busy: 'text-[var(--color-rose)]',
  neutral: 'text-[var(--color-ink-muted)]',
}

export function RoommateStatusRow({ roommates }: RoommateStatusRowProps) {
  return (
    <section className="px-4 pt-1 pb-3" aria-label="Roommate status">
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {roommates.map((roommate) => (
          <article
            key={roommate.id}
            className="flex w-[4.6rem] shrink-0 flex-col items-center gap-1.5 text-center"
          >
            <div className="relative">
              <Avatar
                initials={roommate.initials}
                tone={roommate.avatarTone}
                size="xl"
                isPet={roommate.isPet}
              />
              <span className="absolute right-0 bottom-0 rounded-full bg-[var(--color-cream)] p-0.5">
                {roommate.statusTone === 'away' &&
                roommate.statusLabel.toLowerCase().includes('out') ? (
                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--color-ochre)] text-white">
                    <PlaneIcon size={9} strokeWidth={2.2} />
                  </span>
                ) : (
                  <StatusDotIcon tone={roommate.statusTone} size={11} />
                )}
              </span>
            </div>
            <div className="w-full">
              <p className="truncate text-[13px] font-semibold text-[var(--color-espresso)]">
                {roommate.shortName}
              </p>
              <p
                className={`truncate text-[11px] font-medium ${statusClass[roommate.statusTone]}`}
              >
                {roommate.statusLabel}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
