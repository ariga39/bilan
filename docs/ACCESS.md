# Cloudflare Access and hostname split for `bilan`

`bilan-web` is the only browser-facing surface. It must be reachable only
through a custom HTTPS hostname protected by Cloudflare Access (Zero Trust).

`bilan-ingest` is a separate write plane. It exposes only the authenticated
`POST /api/v1/ingest` route on its own HTTPS hostname (for example
`ingest.example.com`). It has zero read/UI routes and must never share the
dashboard hostname.

## Shipped configuration

`workers/web/wrangler.toml` sets:

```toml
workers_dev = false
preview_urls = false
```

It declares only the shared D1 database and Workers Assets. It has no upstream
API key bindings and no write routes. Do not add `OPENROUTER_API_KEY`,
`DEEPSEEK_API_KEY`, or `INGEST_PRODUCERS_JSON` to this Worker.

`workers/ingest/wrangler.toml` sets `workers_dev = false`,
`preview_urls = false`, a cron trigger, and the D1 binding. Its HTTP surface is
only `POST /api/v1/ingest`, authenticated by a hashed scoped Bearer token from
`INGEST_PRODUCERS_JSON`. Every other method or path returns 404; it exposes no
read or UI routes.

## Hostname and route split

- **Dashboard/read hostname** (for example `bilan.example.com`):
  route it exclusively to `bilan-web`. Protect the whole hostname, including
  `/api/v1/*`, with a Cloudflare Access self-hosted application.
- **Ingest hostname** (for example `ingest.example.com`): route it exclusively
  to `bilan-ingest`. Expose only `POST /api/v1/ingest`, using HTTPS and the
  scoped Bearer token. Do not attach the dashboard Access application or serve
  dashboard/read routes here.
- Never attach the dashboard hostname to `bilan-ingest`, and never attach the
  ingest hostname to `bilan-web`. Do not create a hostname that serves both.

## Access application before the dashboard custom domain

Create the Access policy **before** attaching the dashboard custom domain to
`bilan-web`. Attaching the hostname first can briefly expose the dashboard
without an Access application.

1. In Cloudflare Zero Trust, create a self-hosted Access application for the
   exact dashboard hostname (for example `bilan.example.com`), covering all
   paths including `/api/*`.
2. Add a restricted Allow policy scoped to the operator's email address, email
   domain, or Access group. Do not create a Bypass policy for the dashboard or
   its API routes.
3. Set a short session duration appropriate for a personal dashboard and leave
   one-time PIN or the chosen identity provider as the only login path.
4. Only after the Access application and policy exist, attach that exact
   hostname as a custom domain for `bilan-web`.
5. Keep DNS proxied through Cloudflare so Access intercepts the hostname.

If the dashboard hostname is already attached without Access, remove the custom
domain or disable the route until the Access application is in place.

Access is not a substitute for application authorization: every `bilan-web`
API route is still read-only, and the Worker still has no write route or
upstream/ingest secret.

## Ingest hostname setup

1. Attach a separate custom HTTPS hostname to `bilan-ingest`; do not reuse the
   dashboard hostname.
2. Expose only `POST /api/v1/ingest` if the platform route configuration allows
   it. The Worker itself also returns 404 for every other method/path.
3. Do not put an Access login flow in front of the shipper endpoint. Its
   authorization boundary is the scoped, hashed Bearer token mapped to one
   logical `producer_id` and explicit `(source, kind)` scopes.
4. Keep `INGEST_PRODUCERS_JSON` only on `bilan-ingest`. Tokens are stored as
   SHA-256 hashes, never plaintext.
5. Do not attach any dashboard/read route or UI asset to this hostname.

## Verification

Immediately after attaching the dashboard custom domain, verify from an
unauthenticated client that Access is already enforcing the policy:

```sh
curl -sS -D - -o /dev/null https://bilan.example.com/
curl -sS -D - -o /dev/null https://bilan.example.com/api/v1/overview
```

Both requests must redirect to the Access login flow (typically a `302` with a
`location` on `*.cloudflareaccess.com`). They must not return the dashboard
HTML, a `200`, or balance JSON. If any request succeeds anonymously, remove the
custom domain until the Access application and policy are corrected.

After authenticating, `/api/v1/overview` should return JSON and `/` should
return the dashboard.

Also verify the split boundaries:

- `https://bilan.example.com/api/v1/ingest` returns 404, including `POST`.
- `https://ingest.example.com/` returns 404.
- `https://ingest.example.com/api/v1/overview` returns 404.
- `POST https://ingest.example.com/api/v1/ingest` without a Bearer token returns
  401; with a valid scoped token the same route accepts a valid envelope.
- No `workers.dev` or preview hostname bypasses Access or exposes ingest.
- `bilan-ingest` has no custom route for the dashboard hostname.
- Secrets exist only on `bilan-ingest` (`wrangler secret list` for each
  Worker).

## Credential handling in pull adapters

Both credentialed upstream requests send `Authorization: Bearer <key>` and
set `redirect: "error"`. The Worker therefore never follows a redirect that
could forward a Bearer header to another host. Pull errors are recorded as
bounded summaries such as `OpenRouter request failed (HTTP 502)`; raw response
bodies and keys are not written to D1.
