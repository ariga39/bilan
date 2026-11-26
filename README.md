# bilan

Personal AI consumption aggregator on Cloudflare Workers + D1. This checkout
implements **B1**: live OpenRouter and DeepSeek balances with collection
health, the first usable end-to-end data path.

- Write Worker (`bilan-ingest`): scheduled pull adapters, D1 writes, failure
  isolation per provider. No read or UI routes.
- Read Worker (`bilan-web`): read-only JSON API plus the React dashboard.
  No write routes and no upstream credentials. `workers_dev` and preview URLs
  are disabled.
- Shared D1 database: `producers` and `balance_snapshots`.
- Dashboard: producer heartbeat health, current balances per provider and
  currency, 7d/30d net balance change, OpenRouter reported usage delta, and
  30-day history charts.

B1 does not include the push ingest endpoint, shippers, token usage, quota
windows, pricing, or alerting.

## Layout

```text
migrations/                 D1 schema
packages/shared/            Shared API types and collection constants
workers/ingest/             Scheduled OpenRouter/DeepSeek pull Worker
workers/web/                Read API + React/Tailwind/shadcn/Recharts SPA
docs/                       Design, tasks, and Access guidance
```

## Install and checks

Requires Node.js 22.18+ (or 24+), pnpm 11, and Python is not needed for B1.

```sh
pnpm install
pnpm check
```

Individual checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs:

- `bilan-ingest` Vitest worker-pool tests: successful pulls, DeepSeek failure
  isolation, redirect rejection, no read routes.
- `bilan-web` worker-pool tests: overview/history behavior, absence of write
  routes, and scheduled-pull-to-read-API integration over one D1 binding.
- `bilan-web` jsdom tests: currency labels, partial-history labels, delayed
  samples, and error visibility in the rendered components.

## Local development against one D1 database

The read and write Workers must share the same local D1 state. Both root
scripts use `.wrangler/state` at the repository root.

```sh
pnpm db:migrate:local
```

Create `workers/ingest/.dev.vars` from
`workers/ingest/.dev.vars.example` with local-only values. It is gitignored.
The scheduled handler skips an adapter when its key is absent. Deterministic
upstream success and failure behavior is covered by the Vitest suite, which
stubs outbound `fetch` inside the Workers runtime.

Run the Workers in separate terminals:

```sh
pnpm dev:ingest   # http://127.0.0.1:8787, test scheduled trigger enabled
pnpm dev:web      # http://127.0.0.1:8788, builds the SPA first
```

Trigger the real scheduled entry point:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=*/30+*+*+*+*"
```

Then open `http://127.0.0.1:8788` or query:

```sh
curl "http://127.0.0.1:8788/api/v1/overview"
curl "http://127.0.0.1:8788/api/v1/balances/history?provider=openrouter&days=30"
```

The write Worker has no HTTP read route; in deployed use it is driven by the
cron trigger and, in later B2 work, the scoped push endpoint.

## Production configuration

1. Create one D1 database and replace the placeholder `database_id` in both
   `workers/*/wrangler.toml` files with its real ID.
2. Apply migrations with:

   ```sh
   pnpm --filter bilan-ingest exec wrangler d1 migrations apply bilan --remote
   ```

3. Put `OPENROUTER_API_KEY` and `DEEPSEEK_API_KEY` only on `bilan-ingest`:

   ```sh
   pnpm --filter bilan-ingest exec wrangler secret put OPENROUTER_API_KEY
   pnpm --filter bilan-ingest exec wrangler secret put DEEPSEEK_API_KEY
   ```

4. Attach a custom domain to `bilan-web` and protect it with Cloudflare
   Access. See [docs/ACCESS.md](docs/ACCESS.md).
5. Deploying is outside B1 authority; the commands above are the intended
   handoff for the operator.

## Data rules enforced by B1

- `NULL` is not rendered as `0`; absent values say "Not reported".
- Balances are grouped by provider, account, and currency. Currencies are
  never summed or plotted on a shared axis.
- A balance difference is labeled **Net balance change**. DeepSeek balances
  are balance-only, so a difference is never labeled spend or burn.
- OpenRouter `cumulative_usage` differences are labeled **Reported usage
  delta** and flagged as a discontinuity when they decrease.
- A 7d/30d delta is marked full only when the current sample is near now and a
  baseline sample is near the window boundary. Otherwise the API returns
  `coverage: "partial"` with the actual interval, and the UI labels it
  "Partial coverage · actual …". A missing baseline is "Incomplete history".
- History requests return every sampled point in the supported range; there is
  no silent row cap that can drop a later currency series.
- Producer heartbeat time is displayed separately from each balance's
  `sampled_at`. A successful pull updates liveness; historical data does not
  become fresh because the collector is alive.
- Pull failures record a bounded, sanitized `last_error` such as
  `DeepSeek request failed (HTTP 500)`. Response bodies and API keys are never
  stored.
