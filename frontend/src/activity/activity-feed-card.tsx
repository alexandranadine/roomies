import { Link } from 'react-router';
import type { ActivityListItem } from './activity-api.js';
import { maintenanceDetailHref, presentActivity } from './activity-copy.js';
import { ActivityEventIcon } from './activity-event-icon.js';
import { formatActivityTimestamp } from './activity-format.js';

export type ActivityFeedCardProps = {
  homeId: string;
  item: ActivityListItem;
};

/**
 * Compact household feed card. Presentation-only — no fabricated social
 * features (reactions, comments, kudos).
 */
export function ActivityFeedCard({ homeId, item }: ActivityFeedCardProps) {
  const presentation = presentActivity(item);
  const timestamp = formatActivityTimestamp(item.occurredAt);
  const showHierarchy = presentation.actorLabel !== null;
  const maintenanceHref = maintenanceDetailHref(homeId, item);

  return (
    <li className="rounded-xl border border-border bg-surface px-3 py-2 shadow-card lg:px-4 lg:py-2.5">
      <article className="flex items-start gap-2.5 lg:gap-3">
        <ActivityEventIcon name={presentation.icon} framed />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-col gap-0 lg:flex-row lg:flex-wrap lg:items-baseline lg:gap-x-3">
            {showHierarchy ? (
              <p className="min-w-0 max-w-full break-words text-sm text-text-primary">
                <span className="font-semibold">{presentation.actorLabel}</span>
                <span> {presentation.actionLabel}</span>
              </p>
            ) : (
              <p className="min-w-0 max-w-full break-words text-sm font-medium text-text-primary">
                {presentation.sentence}
              </p>
            )}
            {presentation.contextLabel !== null ? (
              <p className="min-w-0 break-words text-sm text-text-secondary lg:min-w-[12rem] lg:flex-1">
                {presentation.contextLabel}
              </p>
            ) : (
              <span className="hidden min-w-0 flex-1 lg:block" />
            )}
            {timestamp.length > 0 ? (
              <time
                className="mt-0.5 shrink-0 text-xs text-text-muted lg:mt-0 lg:ml-auto"
                dateTime={item.occurredAt}
              >
                {timestamp}
              </time>
            ) : null}
          </div>
          {maintenanceHref !== null ? (
            <Link
              to={maintenanceHref}
              className="w-fit text-xs font-semibold text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
            >
              View maintenance
            </Link>
          ) : null}
        </div>
      </article>
    </li>
  );
}
