import {
  allow,
  type AuthorizationDecision,
} from '../../platform/authz/decision.js';

/**
 * Authenticated current-user Notification capability. There is no Home
 * scope and no structural-authority bypass. Row eligibility is repository SQL.
 */
export function decideNotificationList(): AuthorizationDecision<never> {
  return allow();
}

export function decideNotificationMarkOne(): AuthorizationDecision<never> {
  return allow();
}

export function decideNotificationReadAll(): AuthorizationDecision<never> {
  return allow();
}
