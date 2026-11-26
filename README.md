# bilan

Personal AI consumption aggregator on Cloudflare Workers + D1. This checkout
implements **B2, B3, and B4**: multi-machine Codex token usage pushed by
`debitmetre`, OpenCode Go usage and per-key quota windows pushed by `orihsus`,
and AGY plus Codex quota windows pushed by `telemetre`, alongside the B1
OpenRouter and DeepSeek balance path.

- Write Worker (`bilan-ingest`): scoped, replay-safe `POST /api/v1/ingest` on
  its own HTTPS hostname, plus scheduled pull adapters, D1 writes, and
  per-provider failure isolation. Zero read or UI routes.
- Read Worker (`bilan-web`): read-only JSON API plus the React dashboard,
  served exclusively on a separate Access-protected HTTPS hostname. No write
  routes and no upstream/ingest credentials. `workers_dev` and preview URLs are
  disabled.
- Shared D1 database: `producers`, `balance_snapshots`, `usage_buckets`, `quota_observations`, and `quota_windows`.
- Dashboard: producer heartbeat health, balances, 7d/30d net balance change,
  OpenRouter reported usage delta, Codex machine and OpenCode Go identity token
  usage, and latest-valid OpenCode Go, AGY, and Codex quota windows with
  failed/empty/clock-anomaly callouts.
- Host shippers: `shippers/debitmetre.py` for Codex usage,
  `shippers/orihsus.py` for OpenCode Go usage plus quota history, and
  `shippers/telemetre.py` for AGY and Codex quota history. All use the Python 3
  standard library only, durable cursors/outboxes, monotonic `batch_seq`, and
  idle heartbeats.

AGY token usage, pricing, and alerting remain out of scope.

## Layout

```text
migrations/                 D1 schema
packages/shared/            Shared API types, schemas, and timezone helpers
workers/ingest/             Scoped Push endpoint + scheduled balance pulls
workers/web/                Read API + React/Tailwind/shadcn/Recharts SPA
shippers/                   Standalone Python 3 stdlib host shippers
acceptance/                 B5 multi-host acceptance entry points
ops/                        Synthetic producer, systemd, and cron templates
docs/                       Design, tasks, operations, and Access guidance
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
pnpm typecheck:acceptance
pnpm test
pnpm build
pnpm test:e2e     # requires pnpm build; starts local Workers and the real shippers
pnpm test:e2e:b5  # focused B5 five-platform and host-migration acceptance
```

`pnpm test` runs:

- `bilan-ingest` Vitest worker-pool tests: scheduled pulls, push authentication
  and scopes, `batch_seq` replay/duplicate/stale behavior (including competing
  requests), UTC-hour correction, heartbeat liveness, validation, and the
  absence of read routes.
- `bilan-web` worker-pool tests: balance overview/history behavior, timezone
  month and daily usage slicing (including non-whole-hour offset disclosure),
  per-column completeness flags, latest-valid per-key quota selection, AGY and
  Codex quota subjects without AGY token usage, future-clock anomaly exclusion
  from windows and freshness, identity/machine usage separation, push-to-read
  integration over one D1 binding, and the absence of write routes.
- `bilan-web` jsdom tests: currency labels, partial-history labels, delayed
  samples, usage timezone/month controls, selection safety, initial-load retry,
  machine/identity/model/effort rows, OpenCode Go/AGY/Codex quota windows and
  warnings, daily rows, and partial-counter rendering.

`pnpm test` does **not** run the Python shipper suite. Run it separately:

```sh
python -m unittest discover -s shippers/tests -v
```

The Python suite covers synthetic CLI runs against a local replay-safe ingest
mock, including missing/empty logs, full-extent continuity, truncation and
same-size replacement, pending suffix continuity, bounded incremental capture
with concurrent appends, interrupted multi-chunk backfill resume, backfill-first
extents, lost ACKs, login redirects, `202`, exact 200-only ACKs, cursor safety,
per-key quota windows, AGY/Codex quota windows with late and same-second
samples, clock anomalies, and migration.

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
log remains idle and may heartbeat normally. The shipper verifies a full
streaming checkpoint over the source extent it has consumed or aggregated. If
that extent is shorter or no longer matches, it fails closed before pending
retry, heartbeat, or backfill and leaves the cursor/state unchanged. The same
checkpoint is stored with every in-flight batch, so an unacknowledged suffix
cannot be replaced or regrown before retry.

A backfill-first run checkpoints the extent it aggregated even though the
incremental cursor remains `0`, and records durable per-chunk progress. If a
backfill is interrupted, the next normal periodic run retries any in-flight
chunk and continues the remaining chunks of that same stable extent; records
appended later are left for normal incremental processing. Restore the complete
source log before retrying a failed continuity check; never truncate or replace
it with a partial file.

### Migrating a shipper to another host

A migrated shipper must retain the same logical dataset and sequence, so moving
only `usage.jsonl` is not enough:

1. Quiesce or redirect the actual source writer (debitmetre/orihsus log writer
   or telemetre database sampler), then stop the old shipper and disable its
   timer/systemd unit. Confirm no scheduled or manual run can still push from
   the old host.
2. Copy all of that collector's inputs and the **exact** state/outbox file from
   the stable snapshot together. If a batch is pending, the state file contains
   the identical payload and `batch_seq` that must be retried on the new host.

   | Collector    | Copy with the state file                                | State file                                                                    |
   | :----------- | :------------------------------------------------------ | :---------------------------------------------------------------------------- |
   | `debitmetre` | `usage.jsonl`                                           | Explicit `--state-file`, or `.bilan-debitmetre-state.json` beside the log     |
   | `orihsus`    | `audit.jsonl` **and every `usage/YYYY-MM-DD.jsonl`**    | Explicit `--state-file`, or `.bilan-orihsus-state.json` beside `audit.jsonl`  |
   | `telemetre`  | A consistent SQLite backup of the centre quota database | Explicit `--state-file`, or `.bilan-telemetre-state.json` beside the database |

   Omitting `orihsus` daily usage files treats them as empty and drops unsent
   observations. For a live telemetre database, stop the writer or use SQLite's
   backup API; a raw file copy must include `-wal` and `-shm` consistently.

3. Start the new shipper first with the same `--producer-id` and copied state
   file, run its final catch-up, and verify HTTP `200` plus a non-double-counted
   total. Then resume/redirect the source writers. Resume order is new shipper
   first, then source writers; leave the old shipper disabled. Do not run old
   and new writers concurrently. Exact paths, permissions, and token rotation
   are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

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

## B3: OpenCode Go usage and per-key quotas

B3 adds the `orihsus` shipper and two read surfaces:

- OpenCode Go token usage from `audit.jsonl`, attributed to the caller
  `gateway_key` as `actor_kind = 'identity'` with
  `accounting_basis = 'orihsus-audit-v1'`.
- Per-key quota history from `usage/YYYY-MM-DD.jsonl`. Each key fingerprint is
  its own `(source, account)` subject, and only the single latest valid
  observation (`status = 'ok'` and `time_anomaly IS NULL`) supplies current
  windows. Window labels use the optional redacted upstream `key_alias` when
  present; the account remains the key fingerprint and raw key fields are never
  read.
- The dashboard shows Codex machine rows and OpenCode Go identity rows in
  separate usage tables, plus a quota section with sample age, reset countdowns,
  and separate failed/empty/anomaly callouts.

The existing local migration command applies the B3 schema, including
`migrations/0004_quota_observations.sql`; no separate B3 migration command is
needed:

```sh
pnpm db:migrate:local
```

Add an `orihsus-main` entry to `INGEST_PRODUCERS_JSON` with both explicit
OpenCode Go scopes:

```json
{
  "orihsus-main": {
    "token_sha256": "<sha256-hex-of-your-local-orihsus-token>",
    "display_name": "orihsus (OpenCode Go)",
    "expected_interval_seconds": 1800,
    "scopes": [
      { "source": "opencode", "kind": "usage_buckets" },
      { "source": "opencode", "kind": "quota_observations" }
    ]
  }
}
```

The scoped token resolves `producer_id`; never send it in the request body.

Run the shipper against synthetic or real local files:

```sh
python shippers/orihsus.py \
  --audit-file /path/to/orihsus/audit.jsonl \
  --usage-dir /path/to/orihsus/usage \
  --producer-id orihsus-main \
  --endpoint http://127.0.0.1:8787/api/v1/ingest \
  --token replace-with-local-orihsus-token \
  --observer-machine gateway-a
```

`--state-file` defaults next to `audit.jsonl`; use an explicit durable path for
a production host. The shipper re-reads the complete touched UTC hours from the
audit log, sends every unsent daily quota file (offline backlog included), and
retries the exact in-flight envelope and `batch_seq` after a lost ACK.

Audit log safety:

- A missing audit log fails closed before any heartbeat.
- If the audit file shrinks or its already-consumed prefix changes (truncation,
  rotation, or replacement), the shipper exits non-zero **without sending** and
  without advancing its cursor. This also applies when retrying an in-flight
  multi-chunk batch: every durable batch persists and verifies the full audit
  extent it consumed, not just its cursor at the last ACK.
- This prevents an incomplete replay from overwriting an already-shipped
  complete hourly total. Restore the original audit log/state pair, or recover
  the recorded sequence and log deliberately, before running again.

The dashboard and read API expose:

```sh
curl "http://127.0.0.1:8788/api/v1/overview?tz=UTC&month=2026-11"
curl "http://127.0.0.1:8788/api/v1/quotas"
```

`overview.usage.rows` contains both `codex` machine rows and `opencode` identity
rows, never summed across sources or accounting bases. `overview.quotas.subjects`
contains the latest valid windows per key fingerprint; a window missing from the
latest valid sample disappears immediately. `GET /api/v1/quotas` returns the
same quota block for focused consumers.

Run the focused E2E after building the SPA. It starts local Workers against a
temporary D1 database, invokes the real `orihsus.py` CLI, pushes a synthetic
Codex bucket, reads the web overview, and renders the usage/quota UI:

```sh
pnpm build
pnpm test:e2e
```

The E2E uses only synthetic gateway keys, fingerprints, machine names, and
logs.

## B4: AGY and Codex quota via telemetre

B4 adds `shippers/telemetre.py` and reuses the existing B3 quota ingestion, read
API, and dashboard:

- The shipper reads telemetre's centre SQLite database read-only and pushes
  only `(agy, quota_observations)` and `(codex, quota_observations)`. It never
  pushes AGY token usage.
- Observations are consumed in centre insertion order, so late-arriving older
  `sampled_at` values and same-second samples are not dropped. `error`,
  `empty`, and `time_anomaly` samples are preserved explicitly.
- Each `(source, account)` shows windows only from its single latest valid
  (`status = 'ok'`, non-anomalous) observation. Failed/empty attempts and clock
  anomalies are separate warnings; a future-clock sample cannot replace the
  current reading or pin freshness, even when the upstream anomaly flag is
  absent. The read selection excludes any sample more than 5 minutes ahead of
  its own ingestion time.
- AGY is quota-only on the dashboard and is omitted from token usage totals
  (never rendered as `0`).

The existing local migration already includes the B3 quota schema:

```sh
pnpm db:migrate:local
```

Add a `telemetre-quota` entry to `INGEST_PRODUCERS_JSON` with exactly the two
quota scopes, and no usage scopes:

```json
{
  "telemetre-quota": {
    "token_sha256": "<sha256-hex-of-your-local-telemetre-token>",
    "display_name": "telemetre (AGY + Codex quota)",
    "expected_interval_seconds": 1800,
    "scopes": [
      { "source": "agy", "kind": "quota_observations" },
      { "source": "codex", "kind": "quota_observations" }
    ]
  }
}
```

The example `.dev.vars.example` includes a `telemetre-quota` entry using
`replace-with-local-telemetre-token`. Generate a different hash with:

```sh
python -c "import hashlib; print(hashlib.sha256(b'your-local-telemetre-token').hexdigest())"
```

Run the shipper against telemetre's centre database:

```sh
python shippers/telemetre.py \
  --database ~/.local/state/telemetre/quota.sqlite3 \
  --producer-id telemetre-quota \
  --endpoint http://127.0.0.1:8787/api/v1/ingest \
  --token replace-with-local-telemetre-token
```

`--state-file` defaults next to the centre database; use an explicit durable
path on a production host. The shipper persists the exact in-flight envelope,
retries it after a lost ACK, and advances its insertion-order cursor only on an
exact HTTP 200. `--no-heartbeat` disables idle liveness pushes. The centre
database is opened read-only; telemetre itself is never modified.

The normal overview and focused quota endpoint expose the same data:

```sh
curl "http://127.0.0.1:8788/api/v1/overview?tz=UTC&month=2026-11"
curl "http://127.0.0.1:8788/api/v1/quotas"
```

`overview.quotas.subjects` contains AGY and Codex accounts alongside OpenCode Go
key fingerprints. `GET /api/v1/quotas` returns the same quota block for focused
consumers.

The focused E2E runs the real `telemetre.py` CLI against a synthetic centre
SQLite database, including late-arriving and same-second AGY/Codex samples, then
validates the overview and renders the quota cards:

```sh
pnpm build
pnpm test:e2e
```

The E2E uses only synthetic accounts, machine names, quota windows, and logs.

## B5: Multi-host operations and acceptance

B5 closes v1 with an operator runbook and a reproducible full-stack acceptance
run. The runbook covers the effective Cloudflare Access order, one shared D1
database across both Workers, scoped producer-token setup, independent
per-host systemd/cron schedules, host migration with copied log and state, and
the security/privacy checklist:

- [docs/OPERATIONS.md](docs/OPERATIONS.md)
- [`ops/producers.example.json`](ops/producers.example.json)
- [`ops/systemd/`](ops/systemd/) and [`ops/cron/bilan-shippers.example`](ops/cron/bilan-shippers.example)

Run the five-platform acceptance after building the SPA:

```sh
pnpm build
pnpm test:e2e:b5
```

It starts both real local Workers against one temporary D1 database, runs the
real `debitmetre.py`, `orihsus.py`, and `telemetre.py` CLIs from separate host
directories with separate state and scoped tokens, and gives the real production
scheduled adapters synthetic HTTP responses for only the two exact upstream
URLs (no network). Changing those fixtures proves the actual parsing and
balance calculations. It verifies Codex usage/quota, OpenCode Go usage/quota,
AGY quota without any AGY token total, and OpenRouter/DeepSeek balances through
the normal read API and dashboard sections. A 302 fixture confirms redirects
fail without following or forwarding credentials. It also copies a
collector log and state to a migrated host to assert zero double-counting, and
checks route/secret isolation plus cross-scope `403` rejection.

No live credentials, cloud calls, deployment, or production changes are
involved; all host aliases, tokens, keys, accounts, and logs are synthetic. The
B5 fixture gives each quota subject one distinct latest valid sample, so B5 does
not depend on same-second tie ordering; that ordering remains covered by the B4
quota tests.

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

4. Attach a separate HTTPS hostname for `bilan-ingest` (for example
   `ingest.example.com`) and expose only `POST /api/v1/ingest` there. Do not
   attach the dashboard hostname or Access login flow to the ingest hostname;
   its authorization boundary is the scoped Bearer token. The Worker itself
   returns 404 for every other method/path, so it has zero read/UI routes.

5. Before attaching a custom domain to `bilan-web`, create the Cloudflare
   Access self-hosted application for that exact dashboard hostname and all
   paths with a restricted Allow policy. Then attach that separate custom
   domain. Never share the dashboard and ingest hostnames. See
   [docs/ACCESS.md](docs/ACCESS.md).
6. Deploying is outside B2 authority; the commands above are the intended
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
