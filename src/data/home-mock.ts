import type {
  CreateSheetAction,
  FeedItem,
  HousePulseData,
  HouseholdSummary,
  QuickAction,
  Roommate,
} from './home-types'

export const household: HouseholdSummary = {
  brand: 'Roomies',
  name: 'Maple House',
  notificationCount: 3,
}

export const currentUser: Roommate = {
  id: 'you',
  name: 'You',
  shortName: 'You',
  initials: 'YO',
  avatarTone: '#7a9e7e',
  statusLabel: 'Home',
  statusTone: 'home',
  isYou: true,
}

export const roommates: Roommate[] = [
  currentUser,
  {
    id: 'alex',
    name: 'Alex',
    shortName: 'Alex',
    initials: 'AL',
    avatarTone: '#c4785a',
    statusLabel: 'Come say hi',
    statusTone: 'busy',
  },
  {
    id: 'jamie',
    name: 'Jamie',
    shortName: 'Jamie',
    initials: 'JA',
    avatarTone: '#6d8b74',
    statusLabel: 'Home',
    statusTone: 'home',
  },
  {
    id: 'taylor',
    name: 'Taylor',
    shortName: 'Taylor',
    initials: 'TA',
    avatarTone: '#8b7355',
    statusLabel: 'Working',
    statusTone: 'busy',
  },
  {
    id: 'casey',
    name: 'Casey',
    shortName: 'Casey',
    initials: 'CA',
    avatarTone: '#a67c6d',
    statusLabel: 'Out',
    statusTone: 'away',
  },
]

export const housePulse: HousePulseData = {
  stats: [
    { id: 'home', label: 'home', value: '4', icon: 'people' },
    { id: 'away', label: 'away', value: '1', icon: 'plane' },
    { id: 'tasks', label: 'tasks', value: '2', icon: 'check' },
    {
      id: 'low',
      label: 'low',
      value: '1',
      icon: 'cart',
      emphasis: 'danger',
    },
  ],
  upcomingLabel: 'Tomorrow: Movie night at 7:00 PM',
}

export const quickActions: QuickAction[] = [
  { id: 'post', label: 'Post', icon: 'post', tone: 'sage' },
  { id: 'task', label: 'Add Task', icon: 'task', tone: 'sage' },
  { id: 'event', label: 'Add Event', icon: 'event', tone: 'rose' },
  { id: 'supply', label: 'Need Supplies', icon: 'supply', tone: 'sage' },
]

export const createSheetActions: CreateSheetAction[] = [
  {
    id: 'post',
    label: 'Post',
    description: 'Share an update with the house',
    icon: 'post',
  },
  {
    id: 'task',
    label: 'Task',
    description: 'Add something that needs doing',
    icon: 'task',
  },
  {
    id: 'event',
    label: 'Event / Poll',
    description: 'Plan a night in or ask the house',
    icon: 'event',
  },
  {
    id: 'supply',
    label: 'Supply',
    description: 'Flag something running low',
    icon: 'supply',
  },
  {
    id: 'guest',
    label: 'Guest / Visitor',
    description: 'Let everyone know who’s coming by',
    icon: 'guest',
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    description: 'Track a fix or report an issue',
    icon: 'maintenance',
  },
]

export const feedItems: FeedItem[] = [
  {
    id: 'post-alex-pizza',
    kind: 'post',
    timestamp: '2h ago',
    author: {
      name: 'Alex',
      initials: 'AL',
      avatarTone: '#c4785a',
    },
    statusBadge: { label: 'Come say hi', tone: 'busy' },
    body: 'Pizza in the fridge if anyone wants some. Grab a slice before it disappears.',
    reactions: [
      { type: 'heart', count: 3 },
      { type: 'comment', count: 1 },
    ],
    allowComments: true,
  },
  {
    id: 'poll-halloween',
    kind: 'poll',
    timestamp: '3h ago',
    author: {
      name: 'House',
      initials: 'H',
      avatarTone: '#5f7d61',
      isSystem: true,
    },
    title: 'Halloween party?',
    body: 'Should we host a small costume hang at Maple House next Friday?',
    options: ['Yes, let’s do it', 'Maybe — keep it small', 'Not this year'],
    voteCount: 3,
    reactions: [{ type: 'comment', count: 2 }],
    allowComments: true,
  },
  {
    id: 'travel-jon',
    kind: 'travel',
    timestamp: '4h ago',
    author: {
      name: 'Jon',
      initials: 'JO',
      avatarTone: '#7a6a58',
    },
    headline: 'Jon will be out of town Friday–Sunday',
    body: 'Heading to visit family. Back Sunday evening — text if anything urgent comes up.',
    reactions: [{ type: 'heart', count: 4 }],
  },
  {
    id: 'kudos-jamie',
    kind: 'kudos',
    timestamp: '5h ago',
    author: {
      name: 'Casey',
      initials: 'CA',
      avatarTone: '#a67c6d',
    },
    headline: 'Casey gave kudos to Jamie',
    body: 'Thanks for bringing in everyone’s packages today. Absolute legend.',
    reactions: [{ type: 'heart', count: 6 }],
  },
  {
    id: 'supply-taylor',
    kind: 'supply',
    timestamp: '6h ago',
    author: {
      name: 'Taylor',
      initials: 'TA',
      avatarTone: '#8b7355',
    },
    headline: 'Taylor marked paper towels restocked',
    itemName: 'Paper towels',
    itemStatus: 'Restocked',
    reactions: [{ type: 'heart', count: 2 }],
  },
  {
    id: 'event-movie',
    kind: 'event',
    timestamp: 'Tomorrow · 7:00 PM',
    author: {
      name: 'House',
      initials: 'H',
      avatarTone: '#b86b6b',
      isSystem: true,
    },
    title: 'Movie night',
    whenLabel: 'Tomorrow · 7:00 PM',
    body: 'Pizza, snacks, and probably a questionable movie. Who’s in?',
    attendees: [
      { id: 'you', initials: 'YO', avatarTone: '#7a9e7e' },
      { id: 'alex', initials: 'AL', avatarTone: '#c4785a' },
      { id: 'jamie', initials: 'JA', avatarTone: '#6d8b74' },
    ],
    extraAttendeeCount: 2,
    reactions: [{ type: 'comment', count: 3 }],
    allowComments: true,
  },
  {
    id: 'post-mochi',
    kind: 'post',
    timestamp: 'Yesterday',
    author: {
      name: 'Mochi',
      initials: 'MO',
      avatarTone: '#d4a574',
      isPet: true,
    },
    body: 'Mochi’s birthday tomorrow. Expect chaos, tuna, and zero remorse.',
    reactions: [
      { type: 'heart', count: 8 },
      { type: 'comment', count: 2 },
    ],
    allowComments: true,
  },
  {
    id: 'maintenance-fixed',
    kind: 'maintenance',
    timestamp: 'Yesterday',
    author: {
      name: 'House',
      initials: 'H',
      avatarTone: '#5f7d61',
      isSystem: true,
    },
    headline: 'Kitchen faucet drip marked fixed',
    body: 'Maintenance request closed. Thanks for hanging in there, Maple House.',
    statusLabel: 'Fixed',
    reactions: [{ type: 'heart', count: 5 }],
  },
]
