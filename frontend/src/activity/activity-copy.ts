import type { ActivityActorDisplay, ActivityListItem } from './activity-api.js';

/** Presentation-only label for a missing historical roommate name. */
export const FORMER_ROOMMATE_LABEL = 'Former roommate';

/** Inline Maintenance Activity link text — never a raw id or source title. */
export const MAINTENANCE_LINK_TEXT = 'maintenance item';

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
  actorLabel: string | null;
  actionLabel: string;
  contextLabel: string | null;
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

function presentation(
  icon: ActivityIconName,
  sentence: string,
  actorLabel: string | null,
  actionLabel: string,
  contextLabel: string | null = null,
): ActivityPresentation {
  return { icon, sentence, actorLabel, actionLabel, contextLabel };
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
      if (subject === null) {
        return presentation(
          'user-plus',
          'A roommate joined the home',
          null,
          'A roommate joined the home',
        );
      }
      return presentation(
        'user-plus',
        `${subject} joined the home`,
        subject,
        'joined the home',
      );
    }
    case ACTIVITY_EVENT_TYPES.MEMBERSHIP_ENDED: {
      const subject = personLabel(item.subject);
      if (subject === null) {
        return presentation(
          'user-minus',
          'A roommate left the home',
          null,
          'A roommate left the home',
        );
      }
      return presentation(
        'user-minus',
        `${subject} left the home`,
        subject,
        'left the home',
      );
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
      return presentation(
        'shield',
        sentence,
        actor,
        actor === null ? sentence : 'updated a home role',
        subject === null ? null : `${possessive(subject)} home role`,
      );
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
      return presentation(
        'check',
        sentence,
        actor,
        actor === null ? sentence : 'completed a task',
        title,
      );
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
      return presentation(
        'package',
        sentence,
        actor,
        actor === null ? sentence : 'marked a supply obtained',
        title,
      );
    }
    case ACTIVITY_EVENT_TYPES.MAINTENANCE_CREATED: {
      const actor = personLabel(item.actor);
      const sentence =
        actor === null
          ? 'A maintenance item was added'
          : `${actor} added a maintenance item`;
      return presentation(
        'wrench',
        sentence,
        actor,
        actor === null ? sentence : 'added a maintenance item',
      );
    }
    case ACTIVITY_EVENT_TYPES.MAINTENANCE_RESOLVED: {
      const actor = personLabel(item.actor);
      const sentence =
        actor === null
          ? 'A maintenance item was resolved'
          : `${actor} resolved a maintenance item`;
      return presentation(
        'check-circle',
        sentence,
        actor,
        actor === null ? sentence : 'resolved a maintenance item',
      );
    }
    default:
      return presentation(
        'check',
        'Something happened around the home',
        null,
        'Something happened around the home',
      );
  }
}

/**
 * Detail href for household Maintenance Activity. Private Maintenance omits
 * `sourceTitle` in the DTO, so a missing title must not grow a link.
 * Uses `sourceEntityId` as the existing Maintenance entry id — never titles.
 */
export type MaintenanceSentenceParts = {
  prefix: string;
  suffix: string;
};

/**
 * Splits Maintenance Activity copy around the linkable phrase so only
 * `maintenance item` becomes the destination control.
 */
export function maintenanceSentenceParts(
  presentation: ActivityPresentation,
): MaintenanceSentenceParts | null {
  const { actorLabel, actionLabel, sentence } = presentation;

  if (actorLabel !== null) {
    if (!actionLabel.endsWith(MAINTENANCE_LINK_TEXT)) {
      return null;
    }
    return {
      prefix: actionLabel.slice(0, -MAINTENANCE_LINK_TEXT.length),
      suffix: '',
    };
  }

  const lead = `A ${MAINTENANCE_LINK_TEXT}`;
  if (!sentence.startsWith(lead)) {
    return null;
  }

  return {
    prefix: 'A ',
    suffix: sentence.slice(lead.length),
  };
}

export function maintenanceDetailHref(
  homeId: string,
  item: ActivityListItem,
): string | null {
  if (item.sourceEntityType !== 'MAINTENANCE' || homeId.length === 0) {
    return null;
  }
  const title = item.sourceTitle?.trim() ?? '';
  if (title.length === 0) {
    return null;
  }
  return `/homes/${encodeURIComponent(homeId)}/maintenance/${encodeURIComponent(item.sourceEntityId)}`;
}

