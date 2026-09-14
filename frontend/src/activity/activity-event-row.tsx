import type { ActivityListItem } from './activity-api.js';
import { presentActivity } from './activity-copy.js';
import { ActivityEventIcon } from './activity-event-icon.js';
import { formatActivityTimestamp } from './activity-format.js';

export type ActivityEventRowProps = {
  item: ActivityListItem;
};

/**
 * Read-only Activity sentence. Not a control — there is no detail route.
 */
export function ActivityEventRow({ item }: ActivityEventRowProps) {
  const presentation = presentActivity(item);
  const timestamp = formatActivityTimestamp(item.occurredAt);

  return (
    <li className="flex gap-3 px-4 py-3">
      <ActivityEventIcon name={presentation.icon} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-text-primary sm:text-base">
          {presentation.sentence}
        </p>
        {timestamp.length > 0 ? (
          <time
            className="mt-0.5 block text-sm text-text-muted"
            dateTime={item.occurredAt}
          >
            {timestamp}
          </time>
        ) : null}
      </div>
    </li>
  );
}
