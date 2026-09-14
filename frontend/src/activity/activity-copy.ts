import type { ActivityActorDisplay, ActivityListItem } from './activity-api.js';

/** Presentation-only label for a missing historical roommate name. */
export const FORMER_ROOMMATE_LABEL = 'Former roommate';

export const ACTIVITY_EVENT_TYPES = {
  MEMBERSHIP_STARTED: 'membership.started.v1',
  MEMBERSHIP_ENDED: 'membership.ended.v1',
  MEMBERSHIP_ROLE_CHANGED: 'membership.role_changed.v1',
  TASK_COMPLETED: 'task.completed.v1',
  SUPPLY_OBTAINED: 'supply.obtained.v1',
  MAINTENANCE_CREATED: 'maintenance.created.v1',
  MAINTENANCE_RESOLVED: 'maintenance.resolved.v1',
} as const;

export type ActivityIconName =
  | 'user-plus'
  | 'user-minus'
  | 'shield'
  | 'check'
  | 'package'
  | 'wrench'
  | 'check-circle';

export type ActivityPresentation = {
  sentence: string;
  icon: ActivityIconName;
};

function personLabel(person: ActivityActorDisplay | null): string | null {
  if (person === null) {
    return null;
  }
  const trimmed = person.name?.trim() ?? '';
  if (trimmed.length === 0) {
    return FORMER_ROOMMATE_LABEL;
  }
  return trimmed;
}

function possessive(name: string): string {
  return `${name}'s`;
}

function titledValue(title: string | null): string | null {
  const trimmed = title?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Maps a frozen Activity DTO to recipient-safe display copy.
 *
 * Presentation only — does not decide whether a row is allowed to exist.
 * Event strings are centralized here so UI components do not switch on them.
 */
export function presentActivity(item: ActivityListItem): ActivityPresentation {
  switch (item.eventType) {
    case ACTIVITY_EVENT_TYPES.MEMBERSHIP_STARTED: {
      const subject = personLabel(item.subject);
      return {
        icon: 'user-plus',
        sentence:
          subject === null
            ? 'A roommate joined the home'
            : `${subject} joined the home`,
      };
    }
    case ACTIVITY_EVENT_TYPES.MEMBERSHIP_ENDED: {
      const subject = personLabel(item.subject);
      return {
        icon: 'user-minus',
        sentence:
          subject === null
            ? 'A roommate left the home'
            : `${subject} left the home`,
      };
    }
    case ACTIVITY_EVENT_TYPES.MEMBERSHIP_ROLE_CHANGED: {
      const actor = personLabel(item.actor);
      const subject = personLabel(item.subject);
      let sentence: string;
      if (actor !== null && subject !== null) {
        sentence = `${actor} updated ${possessive(subject)} home role`;
      } else if (actor !== null) {
        sentence = `${actor} updated a roommate's home role`;
      } else if (subject !== null) {
        sentence = `${possessive(subject)} home role was updated`;
      } else {
        sentence = 'A home role was updated';
      }
      return { icon: 'shield', sentence };
    }
    case ACTIVITY_EVENT_TYPES.TASK_COMPLETED: {
      const actor = personLabel(item.actor);
      const title = titledValue(item.sourceTitle);
      let sentence: string;
      if (actor !== null && title !== null) {
        sentence = `${actor} completed ${title}`;
      } else if (actor !== null) {
        sentence = `${actor} completed a task`;
      } else if (title !== null) {
        sentence = `${title} was completed`;
      } else {
        sentence = 'A task was completed';
      }
      return { icon: 'check', sentence };
    }
    case ACTIVITY_EVENT_TYPES.SUPPLY_OBTAINED: {
      const actor = personLabel(item.actor);
      const title = titledValue(item.sourceTitle);
      let sentence: string;
      if (actor !== null && title !== null) {
        sentence = `${actor} marked ${title} obtained`;
      } else if (actor !== null) {
        sentence = `${actor} marked a supply obtained`;
      } else if (title !== null) {
        sentence = `${title} was marked obtained`;
      } else {
        sentence = 'A supply was marked obtained';
      }
      return { icon: 'package', sentence };
    }
    case ACTIVITY_EVENT_TYPES.MAINTENANCE_CREATED: {
      const actor = personLabel(item.actor);
      return {
        icon: 'wrench',
        sentence:
          actor === null
            ? 'A maintenance item was added'
            : `${actor} added a maintenance item`,
      };
    }
    case ACTIVITY_EVENT_TYPES.MAINTENANCE_RESOLVED: {
      const actor = personLabel(item.actor);
      return {
        icon: 'check-circle',
        sentence:
          actor === null
            ? 'A maintenance item was resolved'
            : `${actor} resolved a maintenance item`,
      };
    }
    default:
      return {
        icon: 'check',
        sentence: 'Something happened around the home',
      };
  }
}
