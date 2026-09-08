import type { ReactNode } from 'react'

import type { FeedItem, FeedReaction } from '../../data/home-types'
import { Avatar } from './Avatar'
import {
  CalendarIcon,
  CartIcon,
  CommentIcon,
  HeartIcon,
  MoreIcon,
  PlaneIcon,
  StarIcon,
  WrenchIcon,
} from './icons'

type FeedListProps = {
  items: FeedItem[]
}

function ReactionRow({
  reactions,
  allowComments,
}: {
  reactions?: FeedReaction[]
  allowComments?: boolean
}) {
  if (!reactions?.length) return null

  return (
    <div className="mt-3 flex items-center gap-3 text-[var(--color-ink-muted)]">
      {reactions.map((reaction) => {
        const Icon = reaction.type === 'heart' ? HeartIcon : CommentIcon
        const show = reaction.type === 'comment' ? Boolean(allowComments) : true
        if (!show) return null

        return (
          <button
            key={reaction.type}
            type="button"
            className="inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-[var(--color-espresso)]"
          >
            <Icon
              size={15}
              className={
                reaction.type === 'heart' ? 'text-[var(--color-rose)]' : ''
              }
            />
            <span>{reaction.count}</span>
          </button>
        )
      })}
    </div>
  )
}

function FeedCardShell({
  children,
  menuLabel = 'More options',
}: {
  children: ReactNode
  menuLabel?: string
}) {
  return (
    <article className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 shadow-[var(--shadow-soft)]">
      <div className="relative">
        <button
          type="button"
          aria-label={menuLabel}
          className="absolute top-0 right-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-cream-deep)]"
        >
          <MoreIcon size={16} />
        </button>
        {children}
      </div>
    </article>
  )
}

function badgeClass(tone: 'danger' | 'home' | 'busy') {
  if (tone === 'home') {
    return 'bg-[var(--color-sage-soft)] text-[var(--color-sage-deep)]'
  }
  if (tone === 'busy') {
    return 'bg-[var(--color-rose-soft)] text-[var(--color-rose)]'
  }
  return 'bg-[var(--color-rose-soft)] text-[var(--color-danger)]'
}

function SystemIconBubble({
  children,
  tone = 'sage',
}: {
  children: ReactNode
  tone?: 'sage' | 'rose' | 'ochre'
}) {
  const bg =
    tone === 'rose'
      ? 'bg-[var(--color-rose-soft)] text-[var(--color-rose)]'
      : tone === 'ochre'
        ? 'bg-[var(--color-ochre-soft)] text-[var(--color-ochre)]'
        : 'bg-[var(--color-sage-soft)] text-[var(--color-sage-deep)]'

  return (
    <div
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${bg}`}
    >
      {children}
    </div>
  )
}

function PostFeedItem({ item }: { item: Extract<FeedItem, { kind: 'post' }> }) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <Avatar
          initials={item.author.initials}
          tone={item.author.avatarTone}
          size="md"
          isPet={item.author.isPet}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.author.name}
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.timestamp}
            </span>
            {item.statusBadge ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeClass(item.statusBadge.tone)}`}
              >
                {item.statusBadge.label}
              </span>
            ) : null}
          </div>
          {item.body ? (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
              {item.body}
            </p>
          ) : null}
          <ReactionRow
            reactions={item.reactions}
            allowComments={item.allowComments}
          />
        </div>
      </div>
    </FeedCardShell>
  )
}

function SupplyFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'supply' }>
}) {
  const restocked = item.itemStatus.toLowerCase() === 'restocked'

  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <SystemIconBubble>
          <CartIcon size={16} />
        </SystemIconBubble>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.headline}
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.timestamp}
            </span>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3 rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-cream)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-espresso)]">
                {item.itemName}
              </p>
              <p
                className={`text-xs font-semibold ${
                  restocked
                    ? 'text-[var(--color-sage)]'
                    : 'text-[var(--color-danger)]'
                }`}
              >
                {item.itemStatus}
              </p>
            </div>
            {item.actionLabel ? (
              <button
                type="button"
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-espresso)]"
              >
                {item.actionLabel}
              </button>
            ) : null}
          </div>
          <ReactionRow reactions={item.reactions} allowComments={false} />
        </div>
      </div>
    </FeedCardShell>
  )
}

function KudosFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'kudos' }>
}) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <Avatar
          initials={item.author.initials}
          tone={item.author.avatarTone}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <p className="text-sm font-semibold text-[var(--color-espresso)]">
                  {item.headline}
                </p>
                <span className="text-xs text-[var(--color-ink-muted)]">
                  {item.timestamp}
                </span>
              </div>
              {item.body ? (
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
                  {item.body}
                </p>
              ) : null}
              <ReactionRow reactions={item.reactions} allowComments={false} />
            </div>
            <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-ochre-soft)] text-[var(--color-ochre)]">
              <StarIcon size={22} />
            </div>
          </div>
        </div>
      </div>
    </FeedCardShell>
  )
}

function EventFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'event' }>
}) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <SystemIconBubble tone="rose">
          <CalendarIcon size={16} />
        </SystemIconBubble>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.title}
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.whenLabel}
            </span>
          </div>
          {item.body ? (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
              {item.body}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center">
              <span className="mr-2 text-xs font-medium text-[var(--color-ink-muted)]">
                Who’s in?
              </span>
              <div className="flex -space-x-2">
                {item.attendees.map((person) => (
                  <Avatar
                    key={person.id}
                    initials={person.initials}
                    tone={person.avatarTone}
                    size="sm"
                    className="ring-[var(--color-surface)]"
                  />
                ))}
              </div>
              {item.extraAttendeeCount ? (
                <span className="ml-1.5 text-xs font-semibold text-[var(--color-ink-muted)]">
                  +{item.extraAttendeeCount}
                </span>
              ) : null}
            </div>
          </div>
          <ReactionRow
            reactions={item.reactions}
            allowComments={item.allowComments}
          />
        </div>
      </div>
    </FeedCardShell>
  )
}

function PollFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'poll' }>
}) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <SystemIconBubble>
          <CalendarIcon size={16} />
        </SystemIconBubble>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.title}
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.timestamp}
            </span>
          </div>
          {item.body ? (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
              {item.body}
            </p>
          ) : null}
          <div className="mt-2.5 space-y-1.5">
            {item.options.map((option) => (
              <button
                key={option}
                type="button"
                className="flex w-full items-center justify-between rounded-[12px] border border-[var(--color-border)] bg-[var(--color-cream)] px-3 py-2 text-left text-sm font-medium text-[var(--color-espresso)] transition-colors hover:bg-[var(--color-cream-deep)]"
              >
                <span>{option}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs font-medium text-[var(--color-ink-muted)]">
            {item.voteCount} votes so far
          </p>
          <ReactionRow
            reactions={item.reactions}
            allowComments={item.allowComments}
          />
        </div>
      </div>
    </FeedCardShell>
  )
}

function TravelFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'travel' }>
}) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <SystemIconBubble tone="ochre">
          <PlaneIcon size={16} />
        </SystemIconBubble>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.headline}
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.timestamp}
            </span>
          </div>
          {item.body ? (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
              {item.body}
            </p>
          ) : null}
          <ReactionRow reactions={item.reactions} allowComments={false} />
        </div>
      </div>
    </FeedCardShell>
  )
}

function MaintenanceFeedItemView({
  item,
}: {
  item: Extract<FeedItem, { kind: 'maintenance' }>
}) {
  return (
    <FeedCardShell>
      <div className="flex items-start gap-2.5 pr-8">
        <SystemIconBubble>
          <WrenchIcon size={16} />
        </SystemIconBubble>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold text-[var(--color-espresso)]">
              {item.headline}
            </p>
            <span className="rounded-full bg-[var(--color-sage-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-sage-deep)]">
              {item.statusLabel}
            </span>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {item.timestamp}
            </span>
          </div>
          {item.body ? (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-espresso)]">
              {item.body}
            </p>
          ) : null}
          <ReactionRow reactions={item.reactions} allowComments={false} />
        </div>
      </div>
    </FeedCardShell>
  )
}

export function FeedItemCard({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case 'post':
      return <PostFeedItem item={item} />
    case 'supply':
      return <SupplyFeedItemView item={item} />
    case 'kudos':
      return <KudosFeedItemView item={item} />
    case 'event':
      return <EventFeedItemView item={item} />
    case 'poll':
      return <PollFeedItemView item={item} />
    case 'travel':
      return <TravelFeedItemView item={item} />
    case 'maintenance':
      return <MaintenanceFeedItemView item={item} />
  }
}

export function FeedList({ items }: FeedListProps) {
  return (
    <section className="px-4 pb-24" aria-label="Household feed">
      <div className="space-y-3">
        {items.map((item) => (
          <FeedItemCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}
