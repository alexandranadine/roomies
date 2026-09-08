export type RoommateStatusTone = 'home' | 'away' | 'busy' | 'neutral'

export type Roommate = {
  id: string
  name: string
  shortName: string
  initials: string
  avatarTone: string
  statusLabel: string
  statusTone: RoommateStatusTone
  isYou?: boolean
  isPet?: boolean
}

export type HousePulseStat = {
  id: string
  label: string
  value: string
  icon: 'people' | 'plane' | 'check' | 'cart'
  emphasis?: 'danger' | 'muted'
}

export type HousePulseData = {
  stats: HousePulseStat[]
  upcomingLabel: string
}

export type QuickActionId = 'post' | 'task' | 'event' | 'supply'

export type QuickAction = {
  id: QuickActionId
  label: string
  icon: QuickActionId
  tone: 'sage' | 'rose'
}

export type CreateSheetActionId = QuickActionId | 'guest' | 'maintenance'

export type CreateSheetAction = {
  id: CreateSheetActionId
  label: string
  description: string
  icon: CreateSheetActionId
}

export type FeedAuthor = {
  name: string
  initials: string
  avatarTone: string
  isSystem?: boolean
  isPet?: boolean
}

export type FeedReaction = {
  type: 'heart' | 'comment'
  count: number
}

export type FeedItemBase = {
  id: string
  timestamp: string
  author: FeedAuthor
  body?: string
  reactions?: FeedReaction[]
  allowComments?: boolean
}

export type SocialPostFeedItem = FeedItemBase & {
  kind: 'post'
  statusBadge?: {
    label: string
    tone: 'danger' | 'home' | 'busy'
  }
}

export type SupplyFeedItem = FeedItemBase & {
  kind: 'supply'
  headline: string
  itemName: string
  itemStatus: string
  actionLabel?: string
}

export type KudosFeedItem = FeedItemBase & {
  kind: 'kudos'
  headline: string
}

export type EventFeedItem = FeedItemBase & {
  kind: 'event'
  title: string
  whenLabel: string
  attendees: Array<{
    id: string
    initials: string
    avatarTone: string
  }>
  extraAttendeeCount?: number
}

export type PollFeedItem = FeedItemBase & {
  kind: 'poll'
  title: string
  options: string[]
  voteCount: number
}

export type TravelFeedItem = FeedItemBase & {
  kind: 'travel'
  headline: string
}

export type MaintenanceFeedItem = FeedItemBase & {
  kind: 'maintenance'
  headline: string
  statusLabel: string
}

export type FeedItem =
  | SocialPostFeedItem
  | SupplyFeedItem
  | KudosFeedItem
  | EventFeedItem
  | PollFeedItem
  | TravelFeedItem
  | MaintenanceFeedItem

export type HouseholdSummary = {
  brand: string
  name: string
  notificationCount: number
}
