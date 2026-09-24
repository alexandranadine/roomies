/**
 * Canonical Home as loaded for authorized reads. Archive state, timestamps,
 * and Membership fields are out of scope.
 *
 * `photoObjectKey` is DOMAIN-ONLY. Never spread this model into an HTTP
 * response; map through the Home DTO whitelist (`hasPhoto`) instead.
 */
export type Home = Readonly<{
  id: string;
  name: string;
  timezone: string;
  photoObjectKey: string | null;
}>;
