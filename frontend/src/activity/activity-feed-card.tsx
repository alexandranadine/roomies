import type { ActivityListItem } from './activity-api.js';
import { presentActivity } from './activity-copy.js';
import { ActivityEventIcon } from './activity-event-icon.js';
import { formatActivityTimestamp } from './activity-format.js';

export type ActivityFeedCardProps = {
  item: ActivityListItem;
};

/**
 * Compact household feed card. Presentation-only — no fabricated social
 * features (reactions, comments, kudos).
 */
export function ActivityFeedCard({ item }: ActivityFeedCardProps) {
  const presentation = presentActivity(item);
  const timestamp = formatActivityTimestamp(item.occurredAt);
  const showHierarchy = presentation.actorLabel !== null;

  return (
    <li className="rounded-xl border border-border bg-surface p-3 shadow-card">
      <article className="flex gap-3">
        <ActivityEventIcon name={presentation.icon} framed />
        <div className="min-w-0 flex-1">
          {showHierarchy ? (
            <p className="break-words text-sm text-text-primary">
              <span className="font-semibold">{presentation.actorLabel}</span>
              <span> {presentation.actionLabel}</span>
            </p>
          ) : (
            <p className="break-words text-sm font-medium text-text-primary">
              {presentation.sentence}
            </p>
          )}
          {presentation.contextLabel !== null ? (
            <p className="mt-0.5 break-words text-sm text-text-secondary">
              {presentation.contextLabel}
            </p>
          ) : null}
          {timestamp.length > 0 ? (
            <time
              className="mt-1 block text-xs text-text-muted"
              dateTime={item.occurredAt}
            >
              {timestamp}
            </time>
          ) : null}
        </div>
      </article>
    </li>
  );
}
