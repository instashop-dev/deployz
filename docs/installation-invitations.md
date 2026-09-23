# Installation invitations — lifecycle and security

The MVP Readiness 2 model for how a new installation starts. One concept
before deployment creation, a different concept after it.

## The two concepts

| Stage | Name | What it is |
| --- | --- | --- |
| Before confirmation | **Installation invitation** | A vendor-created entry point that names an application (and, for a targeted invitation, a customer). No deployment exists. |
| After deployment creation | **Customer deployment link** | The deployment's own `/install/:installLinkId` URL. It opens setup progress, status, access and domain information. It never creates another deployment. |

They are deliberately not presented as two kinds of "install link" — the
lifecycle stage, not the URL shape, is the product concept.

## Storage

Both invitation kinds live in `public_install_links`
(`packages/db/src/schema/public-install-links.ts`, migration `0044`):

- **Reusable public link** — `customer_id`/`token_hash` NULL, `enabled`
  gates it, one live per application. Anyone holding the URL may review and
  confirm; each confirmation creates its own customer and deployment.
- **Targeted invitation** — `customer_id` + `token_hash` set, `expires_at`
  (default 30 days), optional `recommended_region`. Exactly one deployment,
  ever: confirmation stamps `confirmed_at` (state `used`).

`region_selection` records Region ownership: `'customer'` for everything
new; `'legacy_publisher_fixed'` exists for the legacy `deploy_links` table,
whose Region the vendor fixed before this model existed.

## Derived status (no state machine)

`status = 'used'` when `confirmed_at` is set, else `'revoked'` when
`revoked_at` is set, else `'expired'` when `expires_at < now()`, else
`'active'`. Served by `GET /api/customers/:customerId/invitations`.

## Vendor flow

1. Vendor selects customer + application, optionally recommends a Region
   ("Your customer will make the final Region selection before deployment.").
2. `POST /api/customers/:customerId/invitations` creates the invitation —
   **no deployment row**.
3. The response reveals the link URL and the one-time token exactly once.
4. Customer opens the link; the web app presents the secret to the API in the
   `x-deployz-token` header.
5. Customer explicitly selects a Region (the recommendation is a badge, not
   a default), reviews the region-specific plan and cost
   (`GET /api/public-install/:id/plan?region=…`), supplies configuration,
   and confirms.
6. The server atomically re-validates the invitation (active, not expired,
   not revoked, not used), the subscription gate, preflight, Region and
   profile, then creates **exactly one** deployment (`source` =
   `public_link`). Region and profile become immutable; the invitation is
   consumed.
7. Confirmation is idempotent per idempotency key (replays return the same
   deployment); a *different* key on a consumed invitation gets `410
   PUBLIC_INSTALL_LINK_USED`.

Invitations are not deployments and never touch billing counts.

## Token security

- 256-bit random secret; only its sha256 is stored (`token_hash`).
- Revealed exactly once at creation (and on regeneration); never retrievable
  again, never in API logs, never in event payloads.
- Transported in the `x-deployz-token` header, never in URLs or Quick Create
  parameters.
- Authorizes only invitation review and confirmation — never relay or AWS
  permissions.
- Targeted invitations are expiring and revocable; either is terminal for
  confirmation.

## Customer deployment links

Each deployment keeps its own `install_link_id`
(`/install/:installLinkId`). Copy actions on the vendor's customer page are
attached to the deployment row and copy that deployment's own URL — there is
no customer-level "the install link" and no helper that picks one deployment
for a customer.

## Legacy compatibility

- Existing `/deploy/:publicId` links keep working end to end; the flow is
  marked `region_selection = 'legacy_publisher_fixed'`.
- Existing `/install/:installLinkId` links are unchanged (they were always
  per-deployment).
- No existing deployment is rewritten. The legacy `/deploy` creation surface
  and its removal are a post-MVP decision once old links have expired or
  been migrated.

## Audit

Phase 6 added the `invitation.*` event family (created/opened/regenerated/
revoked/confirmed/region_selected/deployment_created/
configuration_delivered). Payloads carry ids and counts only — never tokens,
config values, or customer PII.

## Post-MVP notes

- Browser token-transport polish: strip the token from visible history after
  the customer first opens a targeted invitation.
- `invitation.expired` / `invitation.configuration_expired` events (need new
  persistence hooks to be honest).
- Legacy `/deploy` route removal.
