import { useState } from 'react'

import {
  createSheetActions,
  currentUser,
  feedItems,
  household,
  housePulse,
  quickActions,
  roommates,
} from '../data/home-mock'
import { BottomNav } from '../components/home/BottomNav'
import { CreateSheet } from '../components/home/CreateSheet'
import { FeedList } from '../components/home/FeedList'
import { HomeHeader } from '../components/home/HomeHeader'
import { HousePulse } from '../components/home/HousePulse'
import { PostComposer } from '../components/home/PostComposer'
import { QuickActions } from '../components/home/QuickActions'
import { RoommateStatusRow } from '../components/home/RoommateStatusRow'

export function HomePage() {
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-[var(--color-cream)]">
      <div className="flex-1 overflow-y-auto">
        <HomeHeader household={household} />
        <RoommateStatusRow roommates={roommates} />
        <HousePulse data={housePulse} />
        <PostComposer
          user={currentUser}
          onFocusCompose={() => setCreateOpen(true)}
        />
        <QuickActions
          actions={quickActions}
          onSelect={() => setCreateOpen(true)}
        />
        <FeedList items={feedItems} />
      </div>

      <BottomNav active="home" onCreate={() => setCreateOpen(true)} />
      <CreateSheet
        open={createOpen}
        actions={createSheetActions}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  )
}
