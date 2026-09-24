# Installation invitations — lifecycle and security

How a new installation starts. One concept
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
4. Customer opens the link. The API requires the one-time token in the
   `x-deployz-token` header for a targeted invitation (a missing or wrong
   token is the same 404 as an unknown id).
   **Known gap:** the customer install page currently resolves the link
   without any token and has no way to accept one, so a targeted invitation
   cannot be completed in the browser today; only the reusable public link
   and the vendor-created deployment work end to end. The API contract is
   as designed; the web transport is the missing piece.
5. Customer selects a Region, reviews the region-specific plan and cost
   (`GET /api/public-install/:id/plan?region=…`), supplies configuration,
   and confirms. The intended rule is an explicit choice with the
   recommendation shown as a badge; the current page pre-selects the
   recommended Region, or the first offered Region when there is none.
6. The server atomically re-validates the invitation (active, not expired,
   not revoked, not used), the subscription gate, preflight, Region and
   profile, then creates **exactly one** deployment (`source` =
   `public_link`). Region and profile become immutable; the invitation is
   consumed.
7. Confirmation is idempotent per idempotency key (replays return the same
   deployment); a *different* key on a consumed invitation gets `410
   PUBLIC_INSTALL_LINK_USED`.

Invitations are not deployments and never touch billing counts.

The dashboard's primary "Create deployment" path still creates a deployment
directly, with a vendor-chosen Region and a per-deployment install link; it
is not an invitation. See `docs/product/user-flows.md` for all entry points.

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

The `invitation.*` event family (created/opened/regenerated/
revoked/confirmed/region_selected/deployment_created/
configuration_delivered). Payloads carry ids and counts only — never tokens,
config values, or customer PII.

## Post-MVP notes

- Browser token-transport polish: strip the token from visible history after
  the customer first opens a targeted invitation.
- `invitation.expired` / `invitation.configuration_expired` events (need new
  persistence hooks to be honest).
- Legacy `/deploy` route removal.
