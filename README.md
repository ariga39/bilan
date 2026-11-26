# bilan

Personal AI consumption aggregator on Cloudflare Workers + D1. This checkout
implements **B2**: multi-machine Codex token usage pushed by `debitmetre`,
alongside the B1 OpenRouter and DeepSeek balance path.

- Write Worker (`bilan-ingest`): scoped, replay-safe `POST /api/v1/ingest`,
  scheduled pull adapters, D1 writes, and per-provider failure isolation. No
  read or UI routes.
- Read Worker (`bilan-web`): read-only JSON API plus the React dashboard.
  No write routes and no upstream credentials. `workers_dev` and preview URLs
  are disabled.
- Shared D1 database: `producers`, `balance_snapshots`, and `usage_buckets`.
- Dashboard: producer heartbeat health, balances, 7d/30d net balance change,
  OpenRouter reported usage delta, and Codex token usage broken down by
  timezone/month, machine, model, effort, and day, with explicit partial
  counters.
- Host shipper (`shippers/debitmetre.py`): Python 3 standard library only,
  durable cursor/outbox, monotonic `batch_seq`, idle heartbeat, and
  `--backfill`.

B2 does not include OpenCode Go or AGY token usage, quota windows, pricing,
alerting, or the `orihsus` / `telemetre` shippers.

## Layout

```text
migrations/                 D1 schema
packages/shared/            Shared API types, schemas, and timezone helpers
workers/ingest/             Scoped Push endpoint + scheduled balance pulls
workers/web/                Read API + React/Tailwind/shadcn/Recharts SPA
shippers/                   Standalone Python 3 stdlib host shippers
docs/                       Design, tasks, and Access guidance
```

## Install and checks

Requires Node.js 22.18+ (or 24+), pnpm 11, and Python 3.9+ for the shipper.

```sh
pnpm install
pnpm check
pnpm build
python -m unittest discover -s shippers/tests -v
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

- `bilan-ingest` Vitest worker-pool tests: scheduled pulls, push authentication
  and scopes, `batch_seq` replay/duplicate/stale behavior (including competing
  requests), UTC-hour correction, heartbeat liveness, validation, and the
  absence of read routes.
- `bilan-web` worker-pool tests: balance overview/history behavior, timezone
  month and daily usage slicing (including non-whole-hour offset disclosure),
  per-column completeness flags, push-to-read integration over one D1 binding,
  and the absence of write routes.
- `bilan-web` jsdom tests: currency labels, partial-history labels, delayed
  samples, usage timezone/month controls, selection safety, initial-load retry,
  machine/model/effort rows, daily rows, and partial-counter rendering.

`pnpm test` does **not** run the Python shipper suite. Run it separately:

```sh
python -m unittest discover -s shippers/tests -v
```

The Python suite covers synthetic CLI runs against a local replay-safe ingest
mock, including missing/empty logs, truncation/replacement recovery, pending
suffix continuity, backfill-first extents, lost ACKs, login redirects, `202`,
exact 200-only ACKs, cursor safety, and migration.

## Local development against one D1 database

The read and write Workers must share the same local D1 state. Both root
scripts use `.wrangler/state` at the repository root.

```sh
pnpm db:migrate:local
```

Create `workers/ingest/.dev.vars` from
`workers/ingest/.dev.vars.example` with local-only values. It is gitignored.

`INGEST_PRODUCERS_JSON` is the authoritative mapping from a scoped Bearer token
to one logical `producer_id`. Generate a token hash (the token itself is never
stored in the Worker config):

```sh
python -c "import hashlib; print(hashlib.sha256(b'your-local-token').hexdigest())"
```

A minimal local producer entry is:

```json
{
  "debitmetre-main": {
    "token_sha256": "<sha256-hex-of-your-local-token>",
    "display_name": "debitmetre (Codex usage)",
    "expected_interval_seconds": 3600,
    "scopes": [{ "source": "codex", "kind": "usage_buckets" }]
  }
}
```

The `.dev.vars.example` file uses the local example token
`replace-with-local-shipper-token`, whose hash is already filled in.

Run the Workers in separate terminals:

```sh
pnpm dev:ingest   # http://127.0.0.1:8787, test scheduled trigger enabled
pnpm dev:web      # http://127.0.0.1:8788, builds the SPA first
```

Trigger the real scheduled balance pull:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=*/30+*+*+*+*"
```

Push synthetic Codex usage through the shipper:

```sh
printf '%s\n' '{"schema_version":1,"kind":"request","event_id":"e1","timestamp":"2026-11-01T00:15:00Z","machine_id":"machine-a","operation":"response","upstream_status":200,"outcome":"completed","model":"gpt-5","accounting_quality":"complete","metering_error":null,"reasoning_effort":"high","usage":{"input_total":100,"uncached":40,"cache_read":50,"cache_write":10,"output_total":20,"reasoning":5,"total":125}}' > /tmp/usage.jsonl

python shippers/debitmetre.py \
  --usage-file /tmp/usage.jsonl \
  --producer-id debitmetre-main \
  --endpoint http://127.0.0.1:8787/api/v1/ingest \
  --token replace-with-local-shipper-token
```

Then open `http://127.0.0.1:8788` or query:

```sh
curl "http://127.0.0.1:8788/api/v1/overview?tz=Asia%2FShanghai&month=2026-11"
curl "http://127.0.0.1:8788/api/v1/usage/daily?tz=Asia%2FShanghai&month=2026-11"
curl "http://127.0.0.1:8788/api/v1/balances/history?provider=openrouter&days=30"
```

The shipper keeps its durable cursor/outbox next to `usage.jsonl` by default
(or use `--state-file`). Only an exact HTTP 200 clears an in-flight batch;
redirects and other 2xx responses leave the identical payload queued for retry.
Run `--backfill` to replay the whole log without moving the incremental cursor.
An idle run sends an empty heartbeat by default; `--no-heartbeat` disables it.
A missing log path fails closed before any heartbeat, while a real existing empty
log remains idle and may heartbeat normally. The shipper checkpoints the source
extent it has consumed or aggregated. If that prefix is shorter or no longer
matches, it fails closed before pending retry, heartbeat, or backfill and leaves
the cursor/state unchanged. The same checkpoint is stored with every in-flight
batch, so an unacknowledged suffix cannot be replaced or regrown before retry.
A backfill-first run checkpoints the extent it aggregated even though the
incremental cursor remains `0`. Restore the complete source log before retrying;
never truncate or replace it with a partial file.

### Migrating a shipper to another host

A migrated shipper must retain the same logical dataset and sequence, so moving
only `usage.jsonl` is not enough:

1. Stop the old shipper process and disable its timer/systemd unit. Confirm no
   scheduled or manual run can still push from the old host.
2. Copy the source log and the **exact** state/outbox file together. If a batch
   is pending, the state file contains the identical payload and `batch_seq`
   that must be retried on the new host.
3. Start the new host with the same `--producer-id` and the copied state file.
   Do not run the old and new writers concurrently.

The shipper verifies a content checkpoint over the consumed or aggregated
source extent, including any in-flight batch. If the log has been truncated or
replaced, stop the shipper, restore the complete log from the backup/copy, and
only then retry. It will not replay a shortened file, skip an unacknowledged
suffix, or advance the cursor past an incomplete source.

If the state file is lost, restarting from sequence `1` is unsafe: a producer
whose last accepted sequence is higher will reject it with `409`, while a
producer whose last accepted sequence is exactly `1` will no-op duplicate-ACK
it without writing the missing data. Recovery never resets the sequence; restore
the state/outbox from the backup/copy, or otherwise recover the recorded
sequence before writing again.

## Production configuration

1. Create one D1 database and replace the placeholder `database_id` in both
   `workers/*/wrangler.toml` files with its real ID.
2. Apply migrations with:

   ```sh
   pnpm --filter bilan-ingest exec wrangler d1 migrations apply bilan --remote
   ```

3. Put `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, and `INGEST_PRODUCERS_JSON`
   only on `bilan-ingest`:

   ```sh
   pnpm --filter bilan-ingest exec wrangler secret put OPENROUTER_API_KEY
   pnpm --filter bilan-ingest exec wrangler secret put DEEPSEEK_API_KEY
   pnpm --filter bilan-ingest exec wrangler secret put INGEST_PRODUCERS_JSON
   ```

   Use one scoped producer entry per independently written shard. Keep the same
   logical `producer_id` and copy the exact shipper state when moving it to
   another host; see “Migrating a shipper to another host” above.

4. Before attaching a custom domain to `bilan-web`, create the Cloudflare
   Access self-hosted application for that exact hostname and all paths with a
   restricted Allow policy. Then attach the custom domain. See
   [docs/ACCESS.md](docs/ACCESS.md).
5. Deploying is outside B2 authority; the commands above are the intended
   handoff for the operator.

## Data rules enforced by B2

- `NULL` is not rendered as `0`; absent values say "Not reported". An explicitly
  reported zero remains `0`.
- Balance differences are labeled **Net balance change**. DeepSeek balances are
  balance-only, so a difference is never labeled spend or burn. OpenRouter
  `cumulative_usage` differences are labeled **Reported usage delta**.
- Token columns are never collapsed into one cross-basis total. Each column has
  its own `*_counted` value; a column is partial when its counted units are fewer
  than `unit_count`, or when `coverage_gaps > 0`.
- Usage is stored in UTC hourly buckets and sliced by the selected timezone and
  calendar month on the read surface. Defaults are `Asia/Shanghai` and the
  current month in that timezone.
- Usage is attributed to a local month/day by `bucket_start`. Whole-hour offsets
  are exact; non-whole-hour offsets (for example `Asia/Kolkata`) disclose that
  boundary hours are approximate in both the API and dashboard, rather than
  pretending an hourly bucket can be split.
- `batch_seq` is persisted per logical producer. `batch_seq < last_batch_seq`
  returns 409 with zero writes; an equal value returns a 200 no-op ACK; a higher
  value commits usage rows and the producer sequence atomically.
- A correction at a higher `batch_seq` replaces the complete touched UTC-hour
  bucket rather than adding a delta.
- An empty heartbeat updates only producer liveness. Data freshness is derived
  from `MAX(usage_buckets.bucket_start)` / balance `sampled_at`, so heartbeats
  and historical backfills never make old data look fresh.
- Ingest authenticates a hashed scoped Bearer token and resolves `producer_id`
  from that token, never from the request body. B2 producers are authorized only
  for `(codex, usage_buckets)`.
- Producer heartbeat time is displayed separately from data timestamps. Pull
  failures record a bounded, sanitized `last_error`; response bodies, tokens, and
  API keys are never stored.
