# Account lifecycle (M8)

Frozen Roomies-owned account deletion. This is the only production delete
path. Better Auth generic delete-user stays unused.

## Request

`DELETE /api/v1/account` with exact JSON `{ "confirmation": "DELETE" }`.

- Origin protection uses the frozen `/api/v1` mutation guard.
- Session must be a live Better Auth session mapped to a canonical User.
- `session.createdAt` age must be `<= 5 minutes`. Exactly 5 minutes is
  allowed. Older, missing, or future timestamps fail closed as `401`
  `UNAUTHENTICATED` with no lifecycle work and no expiry cookie.
- HTTP reads `userId` from the principal only.

## Database order

One `READ COMMITTED` transaction:

1. Lock the canonical User.
2. Capture current AuthIdentity email.
3. Discover **all historical Membership tenures** by Membership ID (never
   `userId + homeId`).
4. Lock those Homes, then global preflight.
5. Membership / Home structural cleanup.
6. Task / Supply / Notification cleanup owned by those Memberships.
7. Erase authored Maintenance (and derived Activity / Notification /
   audience rows) across every historical tenure.
8. Erase invitations targeted at the captured canonical email.
9. Set `User.deletedAt`.
10. Tear down AuthIdentity / AuthAccount / AuthSession / attributable
    AuthVerification **last**.
11. Commit, then expire the Better Auth session cookie.

## LAST_ADMIN_REQUIRED

If any active Home has the deleting User as the sole active Admin and
another active roommate remains, the entire command is `409`
`LAST_ADMIN_REQUIRED`. Zero lifecycle mutation anywhere. No Owner role.
No automatic Admin promotion.

If the deleting User is the final active roommate, archive the Home and
end the Membership. If another Admin remains, end the Membership only.

## Retained vs erased

Erased: active access, authored Maintenance and its derived projections,
targeted invitations, and auth infrastructure rows.

Retained: the canonical User UUID tombstone (`deletedAt`), historical
Membership rows, shared Task / Supply / structural Activity history,
audience-only or resolver-only Maintenance not authored by the deleting
User, and Home-owned shared data. Home photo ownership is unchanged
(Homes have no separate photo-owner transfer).

## Same-email re-signup

Ordinary Better Auth email sign-up after deletion creates a **new**
AuthIdentity UUID and a **new** canonical User UUID. The old User stays
deleted. Old Memberships stay attached to the old User. The new User
inherits no Homes, Memberships, private Maintenance, ActivityRecipient,
Notification, or invitation access.

## HTTP / cookie

Success is `204` empty with an expired Better Auth cookie after commit.
`401` / `403` / `400` / `409` / `5xx` do not expire the cookie.
Concurrent pre-authenticated `DELETE`s may both return `204`; only one
lifecycle mutation / event set commits. There is no `account.deleted`
outbox event.

## Rate limiting

`DELETE /api/v1/account` uses the `sensitive` class (canonical `userId`,
10 requests / 15 minutes by default). `429 RATE_LIMITED` is returned after
auth and before freshness, body confirmation, lifecycle, or cookie expiry.
See [`production-security.md`](production-security.md).
