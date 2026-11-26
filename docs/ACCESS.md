# Cloudflare Access for `bilan-web`

`bilan-web` is the only browser-facing surface in B1. It must be reachable
only through a custom domain protected by Cloudflare Access (Zero Trust).
`bilan-ingest` is a scheduled, write-only Worker and must not be associated
with the dashboard hostname.

## Shipped configuration

`workers/web/wrangler.toml` sets:

```toml
workers_dev = false
preview_urls = false
```

It also declares only the shared D1 database and Workers Assets. It has no
upstream API key bindings and no write routes. Do not add `OPENROUTER_API_KEY`
or `DEEPSEEK_API_KEY` to this Worker; they belong only to `bilan-ingest`.

`workers/ingest/wrangler.toml` sets `workers_dev = false`,
`preview_urls = false`, and a cron trigger. Its HTTP handler returns 404 for
every route, so it exposes no read or UI surface.

## Access application before the custom domain

Create the Access policy **before** attaching the custom domain to the deployed
Worker. Attaching the hostname first can briefly expose the dashboard without
an Access application.

1. In Cloudflare Zero Trust, create a self-hosted Access application for the
   exact dashboard hostname (for example `bilan.example.com`), covering all
   paths including `/api/*`.
2. Add a restricted Allow policy scoped to the operator's email address, email
   domain, or Access group. Do not create a Bypass policy for the dashboard or
   its API routes.
3. Set a short session duration appropriate for a personal dashboard and leave
   one-time PIN or the chosen identity provider as the only login path.
4. Only after the Access application and policy exist, attach that exact
   hostname as a custom domain for `bilan-web` — never for `bilan-ingest`.
5. Keep DNS proxied through Cloudflare so Access intercepts the hostname.

If the hostname is already attached without Access, remove the custom domain
or disable the route until the Access application is in place.

Access is not a substitute for application authorization: every API route is
still read-only, and the Worker still has no write route or upstream secret.

## Verification

Immediately after attaching the custom domain, verify from an unauthenticated
client that Access is already enforcing the policy:

```sh
curl -sS -D - -o /dev/null https://bilan.example.com/
curl -sS -D - -o /dev/null https://bilan.example.com/api/v1/overview
```

Both requests must redirect to the Access login flow (typically a `302` with a
`location` on `*.cloudflareaccess.com`). They must not return the dashboard
HTML, a `200`, or balance JSON. If any request succeeds anonymously, remove the
custom domain until the Access application and policy are corrected.

After authenticating, `/api/v1/overview` should return JSON and `/` should return
the dashboard.

Also verify:

- `https://bilan.example.com/api/v1/ingest` returns 404, including `POST`.
- No `workers.dev` or preview hostname bypasses Access.
- `bilan-ingest` has no custom route for the dashboard hostname.
- Secrets exist only on `bilan-ingest` (`wrangler secret list` for each
  Worker).

## Credential handling in pull adapters

Both credentialed upstream requests send `Authorization: Bearer <key>` and
set `redirect: "error"`. The Worker therefore never follows a redirect that
could forward a Bearer header to another host. Pull errors are recorded as
bounded summaries such as `OpenRouter request failed (HTTP 502)`; raw response
bodies and keys are not written to D1.
