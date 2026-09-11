import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthRuntime } from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError, UnauthenticatedError } from './errors.js';
import { createPrincipalResolver } from './principal.js';

function stubAuth(
  getSession: () => Promise<{ user?: { id?: string } } | null>,
): AuthRuntime {
  return {
    api: {
      getSession,
    },
  } as unknown as AuthRuntime;
}

function resolveSession(userId?: string) {
  if (userId === undefined) {
    return Promise.resolve(null);
  }
  return Promise.resolve({ user: { id: userId } });
}

const headers = { cookie: 'better-auth.session_token=test-session' };

void describe('createPrincipalResolver', () => {
  void it('resolves an authenticated session to a Roomies userId only', async () => {
    const resolver = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1')),
      hasCanonicalUser: (userId) => Promise.resolve(userId === 'user-1'),
    });

    assert.deepEqual(await resolver.resolvePrincipal({ headers }), {
      userId: 'user-1',
    });
    assert.deepEqual(await resolver.requirePrincipal({ headers }), {
      userId: 'user-1',
    });
  });

  void it('treats missing and empty sessions as unauthenticated', async () => {
    const missing = createPrincipalResolver({
      auth: stubAuth(() => resolveSession()),
      hasCanonicalUser: () =>
        Promise.reject(new Error('must not query users when unauthenticated')),
    });
    const empty = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('')),
      hasCanonicalUser: () => Promise.resolve(true),
    });

    assert.equal(await missing.resolvePrincipal({ headers: {} }), null);
    assert.equal(await empty.resolvePrincipal({ headers }), null);
    await assert.rejects(
      () => missing.requirePrincipal({ headers: {} }),
      UnauthenticatedError,
    );
  });

  void it('fails closed when the canonical User invariant is broken', async () => {
    const resolver = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1')),
      hasCanonicalUser: () => Promise.resolve(false),
    });

    await assert.rejects(
      () => resolver.resolvePrincipal({ headers }),
      AuthInfrastructureError,
    );
  });

  void it('does not expose session or lookup failures', async () => {
    const sessionFailure = createPrincipalResolver({
      auth: stubAuth(() =>
        Promise.reject(new Error('SELECT token FROM auth_sessions')),
      ),
      hasCanonicalUser: () => Promise.resolve(true),
    });
    const lookupFailure = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1')),
      hasCanonicalUser: () =>
        Promise.reject(new Error('relation users does not exist')),
    });

    await assert.rejects(
      () => sessionFailure.resolvePrincipal({ headers }),
      (error: unknown) => {
        assert.ok(error instanceof AuthInfrastructureError);
        assert.equal(error.message.includes('SELECT'), false);
        assert.equal(error.message.includes('token'), false);
        return true;
      },
    );
    await assert.rejects(
      () => lookupFailure.resolvePrincipal({ headers }),
      AuthInfrastructureError,
    );
  });
});
