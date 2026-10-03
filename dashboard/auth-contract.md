# Staff onboarding API proposal

This proposal extends the shared core contract for invitation-based staff access. The shared `docs/contract.md` must be updated by its owner before the core implementation is changed.

Neon Auth creates accounts and verifies email. ReadyFor controls staff membership and role; creating a Neon account never grants clinical access. The dashboard uses the managed vanilla SDK through a same-origin provider proxy. It obtains a short-lived JWT for core requests and does not persist that token in browser storage.

## Routes

- `GET /auth/me` — authenticated provider identity and nullable staff membership. No membership means no surgery access. Unverified accounts cannot accept an invitation.
- `GET /auth/invitations/:token` — invitation preview for the bearer of an unexpired opaque link: clinic name, recipient email, role, expiry. Returns 404 for invalid/used/revoked invitations.
- `POST /auth/invitations/:token/accept` — authenticated, verified, matching email only. Atomically consumes the invitation and creates staff membership.
- `POST /auth/invitations` — clinic administrator only; creates a seven-day invitation for a coordinator, nurse, surgeon, or administrator. Response includes a link for the administrator to copy and share. This route does not send email.
- `POST /auth/bootstrap` — only the verified identity matching the locally configured bootstrap administrator email may create the initial administrator membership.
- `POST /auth/access-requests` — bounded public request (name, email, optional note). Submission grants no access and returns a generic receipt.
- `POST /auth/onboarding` — member acknowledges the brief introduction; records completion time.
- `GET /health` retains existing fields and advertises `auth: { enforced: true, provider: "neon", contractVersion: 1 }` only when the core actually enforces staff/service authorization. The dashboard checks this before enabling its auth gateway; the inherited unauthenticated core cannot accidentally enable staff mode.

Errors retain `{error:{code,message}}`. Authentication failures use 401; unauthorized role, wrong invitation recipient, or unverified email uses 403. No client-provided actor or role determines permissions.

All existing clinical routes require staff membership or a restricted internal service identity. Public routes are health, auth configuration, invitation preview, and access request. Medication approval is nurse/surgeon/admin; logistics completion and task creation are allowed for staff. Reset and invitation administration require admin. Service credentials never enter browser bundles.

Staff roles and invitation tokens live in application tables outside `neon_auth`. Store only invitation token hashes. Application auth data survives demo clinical resets. Restrict the first version to one clinic; document that limit rather than implying multitenant isolation.

## Dashboard states

Invitation preview → create account or sign in → verify email code → accept invitation → short orientation → coordinator dashboard. A visitor without an invitation can request access. An authenticated account without membership sees a pending-access screen, never the surgery dashboard. The bootstrap administrator signs in with the configured email and activates clinic administration.

For local validation, a deliberately selected synthetic demo-auth provider may supply test identities. It must be visibly labeled, restricted to local development, and never selected automatically in deployed mode.

## Response shapes used by the dashboard

`GET /auth/me`:

```json
{
  "user": { "id": "provider-user-id", "name": "Dana", "email": "dana@example.invalid", "emailVerified": true },
  "membership": { "clinicName": "ReadyFor Demo Clinic", "role": "coordinator", "onboardedAt": null },
  "canBootstrap": false
}
```

Use `membership: null` for a provider user without staff access. `canBootstrap` is true only for the verified configured first-admin email while no administrator exists. It is never inferred from the first arbitrary account.

Invitation preview returns `{clinicName,email,role,expiresAt}`. Creation accepts `{email,role}` and returns `{token,expiresAt}`; use a cryptographically random 32-byte base64url token (43 characters), store its hash, and default to seven days. Acceptance returns the membership. Repeated acceptance by the same member should be idempotent without permitting role escalation; other used-token requests return 404. Membership requires the provider's verified email to match the invited email, case-insensitively.

Bootstrap/onboarding return `{ok:true}`. Access-request submission accepts `{name,email,note}` and returns `{ok:true}` without disclosing whether an account already exists. An admin review endpoint/UI remains a follow-up; do not imply these requests generate an automatic email invitation.

## Pending core work and integration validation

The implementation in this branch is dashboard preparation only. Core authorization, invitation persistence, and Neon Auth provisioning are not implemented. Do not enable staff mode or deploy the inherited unauthenticated core as a protected clinical API.

Before enabling: update the shared contract; create membership/invitation/access-request tables; verify JWT signature, issuer, audience, expiry, and email verification against Neon JWKS; authorize every existing clinical route; derive the audit actor server-side; provision/configure Managed Auth email verification; select the bootstrap administrator email; add restricted credentials to the iMessage and agent services. Keep application auth rows outside demo reset.

Integration checks must prove: anonymous surgery access fails; an account without membership cannot read records; a different verified email cannot use an invitation; expired/replayed invites cannot create membership; coordinators cannot approve clinical requirements; staff cannot invite/admin-reset; clinical actors cannot be forged; signout/expired JWT blocks further actions; resetting synthetic surgery data preserves memberships.
