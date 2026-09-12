export { createAuthRuntime, type AuthRuntime } from './runtime.js';
export {
  AUTH_HTTP_PATH_PREFIX,
  AUTH_HTTP_ROUTE,
  createAuthHttpHandler,
} from './http.js';
export {
  createCanonicalIdentityByEmailLookup,
  findCanonicalIdentityByEmail,
  type CanonicalIdentity,
  type CanonicalIdentityByEmailLookup,
  type CanonicalIdentityQuery,
} from './canonical-identity-by-email.js';
export {
  createCanonicalUserLookup,
  createPrincipalResolver,
  type AuthenticatedPrincipal,
  type CanonicalUserLookup,
  type CreatePrincipalResolverOptions,
  type PrincipalResolver,
} from './principal.js';
export {
  createVerifiedEmailLookup,
  type VerifiedEmailIdentity,
  type VerifiedEmailLookup,
} from './verified-email.js';
export {
  InvalidNormalizedEmailError,
  normalizeEmail,
  type NormalizedEmail,
} from '../../../auth-runtime/src/index.js';
export {
  assertNoNormalizedEmailCollisions,
  NormalizedEmailCollisionError,
  type EmailCollisionQuery,
} from './normalized-email-collision-audit.js';
export { AuthInfrastructureError, UnauthenticatedError } from './errors.js';
