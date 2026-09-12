/**
 * Canonical Home as loaded for authorized reads. Archive state, timestamps,
 * and Membership fields are out of scope.
 */
export type Home = Readonly<{
  id: string;
  name: string;
  timezone: string;
}>;
