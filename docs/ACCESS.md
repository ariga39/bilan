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

## Access application

1. In Cloudflare Zero Trust, add the custom hostname (for example
   `bilan.example.com`) as a Worker custom domain for `bilan-web`, not for
   `bilan-ingest`.
2. Create an Access application for that exact hostname, including all paths.
3. Add an Allow policy scoped to the operator's email address, email domain,
   or Access group. Do not create a Bypass policy for the dashboard or its
   `/api/*` routes.
4. Set a short session duration appropriate for a personal dashboard and
   leave one-time PIN or the chosen identity provider as the only login path.
5. Keep DNS proxied through Cloudflare so Access can intercept the hostname.

Access is not a substitute for application authorization: every API route is
still read-only, and the Worker still has no write route or upstream secret.

## Verification

From an unauthenticated client:

```sh
curl -I https://bilan.example.com/
curl -I https://bilan.example.com/api/v1/overview
```

Both requests should redirect to the Access login flow (typically a `302` to
`*.cloudflareaccess.com`) rather than return the SPA or balance JSON. After
authenticating, `/api/v1/overview` should return JSON and `/` should return
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
