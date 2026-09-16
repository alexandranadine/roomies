import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthRuntime } from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError, UnauthenticatedError } from './errors.js';
import { createPrincipalResolver, readSessionCreatedAt } from './principal.js';

function stubAuth(getSession: () => Promise<unknown>): AuthRuntime {
  return {
    api: {
      getSession,
    },
  } as unknown as AuthRuntime;
}

function resolveSession(userId?: string, sessionCreatedAt?: Date) {
  if (userId === undefined) {
    return Promise.resolve(null);
  }
  if (sessionCreatedAt === undefined) {
    return Promise.resolve({ user: { id: userId } });
  }
  return Promise.resolve({
    user: { id: userId },
    session: { createdAt: sessionCreatedAt },
  });
}

const headers = { cookie: 'better-auth.session_token=test-session' };

void describe('createPrincipalResolver', () => {
  void it('resolves an authenticated session to a Roomies userId only', async () => {
    const resolver = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1')),
      hasCanonicalUser: (userId) =>
        Promise.resolve(userId === 'user-1' ? 'active' : 'missing'),
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
      hasCanonicalUser: () => Promise.resolve('active'),
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
      hasCanonicalUser: () => Promise.resolve('missing'),
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
      hasCanonicalUser: () => Promise.resolve('active'),
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

  void it('treats a deleted canonical User as unauthenticated', async () => {
    const resolver = createPrincipalResolver({
      auth: stubAuth(() =>
        resolveSession('user-1', new Date('2026-09-15T18:00:00.000Z')),
      ),
      hasCanonicalUser: () => Promise.resolve('deleted'),
    });

    assert.equal(await resolver.resolvePrincipal({ headers }), null);
    await assert.rejects(
      () => resolver.requirePrincipal({ headers }),
      UnauthenticatedError,
    );
  });

  void it('does not distinguish deleted Users from missing sessions', async () => {
    const deleted = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1')),
      hasCanonicalUser: () => Promise.resolve('deleted'),
    });
    const missing = createPrincipalResolver({
      auth: stubAuth(() => resolveSession()),
      hasCanonicalUser: () =>
        Promise.reject(new Error('must not query users when unauthenticated')),
    });

    const deletedError = await deleted.requirePrincipal({ headers }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const missingError = await missing.requirePrincipal({ headers }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(deletedError instanceof UnauthenticatedError);
    assert.ok(missingError instanceof UnauthenticatedError);
    assert.equal(deletedError.name, missingError.name);
    assert.equal(deletedError.message, missingError.message);
    assert.equal(deletedError.code, missingError.code);
    assert.equal(deletedError.message.includes('deleted'), false);
  });

  void it('captures authoritative session.session.createdAt from the same resolution', async () => {
    const createdAt = new Date('2026-09-15T17:55:00.000Z');
    const resolver = createPrincipalResolver({
      auth: stubAuth(() => resolveSession('user-1', createdAt)),
      hasCanonicalUser: () => Promise.resolve('active'),
    });

    assert.deepEqual(await resolver.resolvePrincipal({ headers }), {
      userId: 'user-1',
      sessionCreatedAt: createdAt,
    });
  });

  void it('does not invent createdAt from updatedAt or expiresAt', async () => {
    const resolver = createPrincipalResolver({
      auth: stubAuth(() =>
        Promise.resolve({
          user: { id: 'user-1' },
          session: {
            updatedAt: new Date('2026-09-15T18:00:00.000Z'),
            expiresAt: new Date('2026-09-22T18:00:00.000Z'),
          },
        }),
      ),
      hasCanonicalUser: () => Promise.resolve('active'),
    });

    assert.deepEqual(await resolver.resolvePrincipal({ headers }), {
      userId: 'user-1',
    });
  });
});

void describe('readSessionCreatedAt', () => {
  void it('reads Date and parseable session.createdAt only', () => {
    const createdAt = new Date('2026-09-15T18:00:00.000Z');
    assert.equal(
      readSessionCreatedAt({ session: { createdAt } })?.getTime(),
      createdAt.getTime(),
    );
    assert.equal(
      readSessionCreatedAt({
        session: { createdAt: '2026-09-15T18:00:00.000Z' },
      })?.getTime(),
      createdAt.getTime(),
    );
    assert.equal(
      readSessionCreatedAt({ session: { updatedAt: createdAt } }),
      undefined,
    );
    assert.equal(readSessionCreatedAt({ createdAt }), undefined);
    assert.equal(readSessionCreatedAt(null), undefined);
  });
});
