import { Plus } from 'lucide-react';
import { PageContainer } from '../components/page-container.js';
import { RoomiesWordmark } from '../components/roomies-wordmark.js';
import { IconButton } from '../components/ui/index.js';
import { NotificationBellLink } from '../notifications/notification-bell-link.js';
import { HomeDesktopNav } from './home-desktop-nav.js';
import { HomeSelector } from './home-selector.js';

export type HomeShellHeaderProps = {
  home: {
    id: string;
    name: string;
    hasPhoto: boolean;
  };
  isDesktop: boolean;
  isWide: boolean;
  onAdd: () => void;
};

/**
 * Home chrome. Mobile/tablet keep a stacked brand + selector; desktop (lg+)
 * uses a single full-width header with destinations in the middle.
 */
export function HomeShellHeader({
  home,
  isDesktop,
  isWide,
  onAdd,
}: HomeShellHeaderProps) {
  if (isWide) {
    return (
      <header className="border-b border-border bg-bg">
        <PageContainer className="flex items-center gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <RoomiesWordmark />
            <HomeSelector
              homeId={home.id}
              homeName={home.name}
              hasPhoto={home.hasPhoto}
            />
          </div>
          <div className="flex min-w-0 flex-1 justify-center">
            <HomeDesktopNav homeId={home.id} variant="inline" />
          </div>
          <nav aria-label="Global" className="flex shrink-0 items-center gap-1">
            <NotificationBellLink />
            <IconButton
              variant="primary"
              aria-label="Add to this Home"
              className="rounded-full"
              onClick={onAdd}
            >
              <Plus className="size-5" aria-hidden="true" />
            </IconButton>
          </nav>
        </PageContainer>
      </header>
    );
  }

  return (
    <header className="border-b border-border bg-bg">
      <PageContainer className="flex flex-col gap-0.5 pt-2 pb-1">
        <div className="flex items-center justify-between gap-3">
          <RoomiesWordmark />
          <nav aria-label="Global" className="flex items-center gap-1">
            <NotificationBellLink />
          </nav>
        </div>
        <div className="flex items-center justify-between gap-2">
          <HomeSelector
            homeId={home.id}
            homeName={home.name}
            hasPhoto={home.hasPhoto}
          />
          {isDesktop ? (
            <IconButton
              variant="primary"
              aria-label="Add to this Home"
              className="rounded-full"
              onClick={onAdd}
            >
              <Plus className="size-5" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </PageContainer>
      {isDesktop ? (
        <PageContainer>
          <HomeDesktopNav homeId={home.id} />
        </PageContainer>
      ) : null}
    </header>
  );
}

/** Wordmark + notifications while Home context is loading or unavailable. */
export function HomeShellFallbackHeader() {
  return (
    <header className="border-b border-border bg-bg">
      <PageContainer className="flex items-center justify-between gap-3 py-2.5">
        <RoomiesWordmark />
        <nav aria-label="Global" className="flex items-center gap-1">
          <NotificationBellLink />
        </nav>
      </PageContainer>
    </header>
  );
}
