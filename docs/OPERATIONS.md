# Operating bilan across independent hosts (v1)

This runbook describes how an operator provisions the two Workers against one D1
database, protects the read surface with Cloudflare Access, creates scoped
producer tokens, and runs the three shippers independently on separate hosts.
It also defines the host-migration procedure and the v1 acceptance checklist.

Everything here is a handoff for an operator. **This repository never deploys,
installs timers, changes Access policies, or contacts live upstream APIs.** All
host names and accounts in examples are synthetic aliases (`host-a`, `host-b`,
`host-c`, `bilan.example.com`, `machine-a`, `personal`, `work`).

Canonical design authority: [DESIGN.md](DESIGN.md). Task framing:
[TASKS.md](TASKS.md). Access details: [ACCESS.md](ACCESS.md).

## 1. v1 platform matrix

| Platform | Transport | Balance | Token usage | Quota windows |
| :--- | :--- | :--- | :--- | :--- |
| Codex (ChatGPT Pro) | Push | — | `debitmetre` `usage.jsonl` | `telemetre` Codex observations |
| OpenCode Go | Push | — | `orihsus` `audit.jsonl` | `orihsus` `usage/YYYY-MM-DD.jsonl` |
| Antigravity (AGY) | Push | — | **Deferred; never shown as `0`** | `telemetre` AGY observations |
| OpenRouter | Worker Cron Pull | `/api/v1/credits` | — | — |
| DeepSeek | Worker Cron Pull | `/user/balance` | — | — |

AGY has quota cards only. It must never appear in a token-usage table, summary,
daily row, or zero-valued placeholder.

## 2. Two Workers, one D1 database

`bilan-ingest` owns every write: `POST /api/v1/ingest` plus the scheduled
OpenRouter/DeepSeek pullers. `bilan-web` owns every read: the read-only JSON API
and the dashboard served through Workers Assets. Both bind the **same** D1
database, but they never share secrets.

Provisioning order:

1. Create one D1 database and put its ID in both
   `workers/ingest/wrangler.toml` and `workers/web/wrangler.toml`.
2. Apply the migrations once against that database:
   `pnpm --filter bilan-ingest exec wrangler d1 migrations apply bilan --remote`.
3. Keep `workers_dev = false` and `preview_urls = false` in both configs.
4. Put `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, and `INGEST_PRODUCERS_JSON`
   only on `bilan-ingest`.
5. Do not add `[vars]`, upstream keys, ingest tokens, or write routes to
   `bilan-web`. It must expose only the read API and static assets.

The local equivalent for development and acceptance uses one persisted state
directory for both Workers:

```sh
pnpm db:migrate:local
pnpm dev:ingest   # scheduled test trigger on http://127.0.0.1:8787
pnpm dev:web      # read surface on http://127.0.0.1:8788
```

## 3. Producer setup and scoped tokens

A producer is a **logical dataset**, never a hostname. Every producer gets one
opaque token, one explicit set of `(source, kind)` scopes, and one stable
`producer_id`. The same token may move with its dataset during a host migration.

Generate a token and its SHA-256 hash:

```sh
python -c "import secrets; print(secrets.token_urlsafe(32))"
python -c "import hashlib; print(hashlib.sha256(b'replace-with-generated-token').hexdigest())"
```

`INGEST_PRODUCERS_JSON` stores only the hash. Start from
[`ops/producers.example.json`](../ops/producers.example.json) and replace every
placeholder hash:

| `producer_id` | Allowed scopes |
| :--- | :--- |
| `debitmetre-main` | `(codex, usage_buckets)` |
| `orihsus-main` | `(opencode, usage_buckets)`, `(opencode, quota_observations)` |
| `telemetre-quota` | `(agy, quota_observations)`, `(codex, quota_observations)` |

The scopes are explicit tuples, not a source/kind Cartesian product. In
particular `telemetre-quota` must not be able to write Codex or AGY usage, and
`debitmetre-main` must not be able to write quota observations.

Token handling:

- Prefer `--token-file` over `--token` so the token does not appear in process
  arguments or shell history.
- Store the token file with mode `0600`, readable only by the shipper user.
- Put the same token on exactly one active writer for that `producer_id`.
- To rotate, add the new hash under the same `producer_id`, deploy the config,
  update the host token file, and then remove the old hash. Never give two
  different logical datasets one token.
- Never commit a token, its plaintext, or a real hash to this repository.

## 4. Cloudflare Access: effective order

Access must already be enforcing the policy **before** the dashboard hostname
resolves to the Worker. The effective order is:

1. **Create the Access application first** for the exact dashboard hostname
   (for example `bilan.example.com`), covering all paths including `/api/*`.
2. **Create a restricted Allow policy** for the operator's email/group. Do not
   add a Bypass policy, and do not create a policy that covers only `/`.
3. **Attach the custom domain to `bilan-web` only after steps 1–2 exist.** Retry
   the attachment if the hostname is already exposed; remove the route until
   Access is correct.
4. **Verify from an unauthenticated client** that every path, including the API,
   redirects to the Access login flow and never returns dashboard HTML or JSON.
5. Keep DNS proxied through Cloudflare. Never attach the dashboard hostname to
   `bilan-ingest`.

Access is evaluated before the Worker handles a request, but it is not
application authorization: `bilan-web` still has only read routes and still has
no upstream/ingest secret. The verification commands and failure handling are in
[ACCESS.md](ACCESS.md).

## 5. Independent host schedules

Each collector runs on its own host and timer. There is no central scheduler and
no manual pull step. The shipper lockfile is the single-writer guard: never run
two timers or a manual run against the same state file at the same time.

| Host alias | Shipper | Source | Suggested timer period |
| :--- | :--- | :--- | :--- |
| `host-a` | `debitmetre.py` | `usage.jsonl` | 15 minutes |
| `host-b` | `orihsus.py` | `audit.jsonl` + `usage/` | 5 minutes |
| `host-c` | `telemetre.py` | centre quota SQLite (read-only) | 15 minutes |

Templates live under [`ops/systemd/`](../ops/systemd/). They use synthetic
paths (`/opt/bilan`, `/var/lib/bilan/host-a`, `/etc/bilan`) and do **not**
install anything. A cron alternative is in
[`ops/cron/bilan-shippers.example`](../ops/cron/bilan-shippers.example).
Choose one mechanism per host, not both.

Example enablement after an operator installs and reviews a template (not
performed by this repository):

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now bilan-debitmetre.timer
systemctl list-timers 'bilan-*'
journalctl -u bilan-debitmetre.service --since today
```

Schedules are intentionally independent: a stalled host, a delayed timer, or an
offline backlog on one collector does not block the other two. Each shipper
stores its cursor/outbox beside its own state path, retries the identical
`batch_seq` after a lost ACK, and advances only after HTTP `200`.

## 6. Host migration without double-counting

`producer_id` identifies the dataset. Move the dataset, not a new identity.

1. Stop the old shipper process and disable its timer/unit. Confirm no manual or
   scheduled run can still push from the old host.
2. Copy the **source log and the exact state/outbox file together** to the new
   host directory. If a batch is pending, the state file contains the identical
   payload and `batch_seq` that must be retried.
3. Start the new host with the same `producer_id`, the same token (or its
   rotated replacement), and the copied state file.
4. Run once and verify the producer heartbeat updates, the sequence advances by
   one, and totals do not double. Do not run both hosts concurrently.

Never reset `batch_seq` to `1`, never edit the state file, and never replay a
truncated/replaced source log. The shipper verifies a digest over the consumed
source extent and fails closed instead of overwriting a complete hourly total.
If state is lost, recover the recorded sequence or restore the state/outbox
backup before writing again. The local acceptance suite exercises this exact
copy-and-continue path for `debitmetre` and asserts one row with three units, not
double-counted data.

## 7. Local five-platform acceptance

The reproducible acceptance test uses two real local Workers sharing one D1
database, three real shipper CLIs in separate host directories, and mocked
scheduled OpenRouter/DeepSeek responses. It performs no cloud call.

```sh
pnpm build
pnpm --filter bilan-web exec vitest run --config vitest.e2e.config.ts test/e2e/b5.test.tsx
```

The test:

- applies the real migrations to a temporary persisted D1 database;
- starts `bilan-ingest` through a test-only entry that redirects only the two
  scheduled upstream URLs to a loopback mock;
- starts `bilan-web` against the same D1 state;
- triggers the real scheduled handler and verifies both provider calls;
- runs `shippers/debitmetre.py`, `shippers/orihsus.py`, and
  `shippers/telemetre.py` with separate state files and scoped tokens;
- reads the normal overview, daily usage, and quota responses and renders the
  normal dashboard sections;
- migrates the `debitmetre` host with a copied log/state and asserts zero
  double-counting;
- probes read/write route isolation, rejects cross-scope pushes with `403`, and
  checks that no token or upstream key appears in read output.

Full project checks:

```sh
pnpm check
python -m unittest discover -s shippers/tests -v
```

## 8. Acceptance and security checklist

- [ ] Both Workers bind the same D1 database and apply the same migrations.
- [ ] `bilan-web` has `workers_dev = false`, `preview_urls = false`, zero write
      routes, and zero upstream/ingest secrets.
- [ ] `bilan-ingest` has `workers_dev = false`, `preview_urls = false`, a cron
      trigger, and zero read/UI routes.
- [ ] All five v1 platforms render on the normal dashboard with zero manual
      pull: Codex usage/quota, OpenCode Go usage/quota, AGY quota, OpenRouter
      balance, DeepSeek balance.
- [ ] AGY is absent from every token-usage view and is never rendered as `0`.
- [ ] Codex and OpenCode Go token columns remain separate by source and
      `accounting_basis`; partial columns stay explicitly flagged.
- [ ] DeepSeek differences are labeled net balance change, never spend/burn.
- [ ] Each producer token resolves one logical `producer_id` from its explicit
      scopes; out-of-scope `(source, kind)` pushes return `403`.
- [ ] A migrated host keeps its `producer_id`, copies log plus state, and does
      not double-count or reset `batch_seq`.
- [ ] Access is enforcing before the hostname is attached, including `/api/*`.
- [ ] D1 and read responses contain no raw keys, tokens, prompts, or unredacted
      upstream bodies.
- [ ] `oxfmt`, `oxlint`, typecheck, Vitest, and Python `unittest` pass.

## 9. Troubleshooting

| Symptom | Check |
| :--- | :--- |
| `401 unauthorized` | Token is missing or its hash is not in `INGEST_PRODUCERS_JSON`. |
| `403 forbidden_scope` | The producer is pushing a `(source, kind)` pair it does not own. |
| `409 stale_batch` | Old host or stale state is still writing; restore the correct state. |
| Missing log / shorter log | Restore the complete source file; do not truncate or replace it. |
| Heartbeat fresh but data old | Expected: liveness and data freshness are separate. |
| Quota card stale | Check the shipper timer, the latest attempt warning, and the sample age. |
| AGY token total missing | Expected in v1: AGY token usage is not collected and must not be shown as `0`. |
