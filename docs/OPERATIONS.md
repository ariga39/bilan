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
and the TanStack Start SSR dashboard through the Cloudflare Vite plugin. Both
bind the **same** D1 database, but they never share secrets.

Provisioning order:

1. Create one D1 database and put its ID in both
   `workers/ingest/wrangler.toml` and `workers/web/wrangler.toml`.
2. Apply the migrations once against that database:
   `pnpm --filter bilan-ingest exec wrangler d1 migrations apply bilan --remote`.
3. Keep `workers_dev = false` and `preview_urls = false` in both configs.
4. Put `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, and `INGEST_PRODUCERS_JSON`
   only on `bilan-ingest`.
5. Do not add `[vars]`, upstream keys, ingest tokens, or write routes to
   `bilan-web`. It must expose only the read API and the SSR application; D1
   access stays in server functions and the Hono `/api` entry.

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

Generate the token directly into its protected file, then hash the file contents.
The token itself never appears in shell arguments or history:

```sh
sudo install -d -m 0750 -o root -g bilan /etc/bilan
sudo sh -c 'umask 077; python3 -c "import secrets; print(secrets.token_urlsafe(32))" > /etc/bilan/debitmetre.token'
sudo chown root:bilan /etc/bilan/debitmetre.token
sudo chmod 0640 /etc/bilan/debitmetre.token
sudo python3 -c "import hashlib, pathlib; t = pathlib.Path('/etc/bilan/debitmetre.token').read_text(encoding='utf-8').splitlines()[0]; print(hashlib.sha256(t.encode('utf-8')).hexdigest())"
```

The directory is traversable by the `bilan` service group, the token is
group-readable only, and the token value never appears in argv or shell history.
Repeat with the matching token file for `orihsus` and `telemetre`.

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
- Store the token file as `root:bilan` mode `0640`, or `0600` owned by the
  shipper user. Never make it world-readable.
- Put the same token on exactly one active writer for that `producer_id`.
- `INGEST_PRODUCERS_JSON` accepts exactly one `token_sha256` per producer, so
  rotation is coordinated and brief downtime is expected:
  1. Stop the shipper and disable its timer/unit.
  2. Generate the new token into the protected file and compute its hash.
  3. Replace the single `token_sha256` in `INGEST_PRODUCERS_JSON` and deploy
     `bilan-ingest`.
  4. Replace the host token file, start the same `producer_id` and state file,
     and verify the next push gets HTTP `200`.
  5. Resume the timer only after that check. The old token now gets `401`; do
     not run old and new tokens concurrently.
- Never give two different logical datasets one token, and never commit a
  token, its plaintext, or a real hash to this repository.

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
[`ops/cron/bilan-shippers.example`](../ops/cron/bilan-shippers.example); its
lines use per-user crontab syntax (no username field), so install them in the
shipper user's own crontab. A system `/etc/cron.d` file needs a different format
that includes the user field. Choose one mechanism per host, not both.

Create least-privilege state and source directories before enabling a timer. The
service runs as `bilan`, must read its own token, and must write only its state
directory:

```sh
sudo install -d -m 0750 -o bilan -g bilan /var/lib/bilan/host-a /var/lib/bilan/host-a/state
sudo install -d -m 0750 -o bilan -g bilan /var/lib/bilan/host-b /var/lib/bilan/host-b/state
sudo install -d -m 0750 -o bilan -g bilan /var/lib/bilan/host-c /var/lib/bilan/host-c/state
```

Ensure each source directory is readable by `bilan` and each state directory is
writable only by `bilan`. If an upstream collector runs as another account, use a
shared group rather than world-readable files. `ProtectSystem=strict` plus
`ReadWritePaths` keeps the rest of the host read-only for the shipper.

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

1. **Pause the actual source writers as well as the shipper.** Stop and disable
   the service that writes this collector's input: `debitmetre`'s `usage.jsonl`
   writer, `orihsus`'s `audit.jsonl` and `usage/*.jsonl` writer, or `telemetre`'s
   centre quota sampler/database writer. If writes must continue, buffer them
   **away from both the old and new dataset paths**; do not point writers at the
   destination yet. Wait for in-flight writes to finish and confirm file
   sizes/mtimes stop changing. A pre-seed copy is fine for speed, but the final
   snapshot must be taken while the source is paused.
2. Stop the old shipper process and disable its timer/unit. Confirm no manual or
   scheduled run can still push from the old host. Never let old and new
   shippers write the same `producer_id` at once.
3. Copy **all** of that collector's inputs and its exact state/outbox file from
   the stable snapshot to the new host directory. If a batch is pending, the
   state file contains the identical payload and `batch_seq` that must be
   retried.

   | Collector | Copy with the state file | Keep |
   | :--- | :--- | :--- |
   | `debitmetre` | `usage.jsonl` | The explicit `--state-file` path, or the default `.bilan-debitmetre-state.json` beside the log. |
   | `orihsus` | `audit.jsonl`, every retained `audit.jsonl.N[.gz]`, **and every `usage/YYYY-MM-DD.jsonl` file** | The explicit `--state-file` path, or the default `.bilan-orihsus-state.json` beside `audit.jsonl`. A missing usage file is treated as empty, so omitting it drops unsent quota observations. Recovery is limited to audit generations still inside retention. |
   | `telemetre` | A SQLite backup of the centre quota database made with the SQLite backup API/CLI, or a verified offline backup after stopping the database | The explicit `--state-file` path, or the default `.bilan-telemetre-state.json` beside the database. For example: `sqlite3 SOURCE.sqlite3 ".backup 'TARGET.sqlite3'"`; do not casually copy a live database or rely on ad-hoc `-wal`/`-shm` copies. |

   Copy the token file too (or perform the coordinated rotation above).

4. **Final catch-up and cutover.** Start the new host first with the same
   `producer_id`, the same token (or its rotated replacement), and restore the
   copied state file to its final `--state-file` path. Run it once and complete
   the first HTTP `200` ACK; verify the producer heartbeat updates, the sequence
   advances, any pending batch is retried, and totals do not double. Only after
   that ACK succeeds, restore any
   buffered writes and enable/redirect the source writers at the destination.
   Resume order is: new shipper first, completed ACK, buffered writes, then
   source writers. Leave the old shipper disabled and the old state file
   untouched; never resume both sides.

A copied JSONL input is a new file generation, so the first run on the new host
warns and restarts from byte `0`; complete hourly buckets are replaced
idempotently.

Never reset `batch_seq` to `1` and never edit the state file. Always replay a
pending outbox first, even if the source is currently missing. If a source is
truncated or replaced, the shipper warns and restarts from byte `0`; it does not
fail closed or verify a prefix digest. A shortened replacement can overwrite an
already-published part of the active hour, and unread tails or late records can
affect more than one hour. Same-inode `copytruncate` followed by rapid regrowth
past the cursor may go undetected. Exact totals require quiescing writers and
preserving complete logs/state. If state is lost, recover the recorded sequence
or restore the state/outbox backup before writing again. The local acceptance
suite exercises this exact copy-and-continue path for `debitmetre` and asserts
one row with three units, not double-counted data.

## 7. Local five-platform acceptance

The reproducible acceptance test uses two real local Workers sharing one D1
database, three real shipper CLIs in separate host directories, and injected
synthetic OpenRouter/DeepSeek HTTP responses. It performs no cloud call.

```sh
pnpm build
pnpm test:e2e:b5
```

The test:

- applies the real migrations to a temporary persisted D1 database;
- starts `bilan-ingest` through a test-only entry that passes the real
  production adapters an injected fetch returning synthetic HTTP responses for
  only the two exact upstream URLs; every other destination is refused, no
  network call is made, and the real scheduled orchestration, parsing,
  calculations, failure isolation, and D1 writes stay unchanged;
- starts `bilan-web` against the same D1 state;
- triggers the real scheduled handler, verifies both provider calls, changes the
  synthetic responses to prove OpenRouter and DeepSeek parsing/calculation
  changes, and checks a 302 fails without following or forwarding credentials;
- runs `shippers/debitmetre.py`, `shippers/orihsus.py`, and
  `shippers/telemetre.py` with separate state files and scoped tokens;
- reads the normal overview, daily usage, and quota responses and renders the
  normal dashboard sections;
- migrates the `debitmetre` host with a copied log/state and asserts zero
  double-counting;
- probes read/write route isolation, rejects cross-scope pushes with `403`, and
  checks that no token or upstream key appears in read output.

The B5 quota fixtures give each subject one distinct latest valid sample. The
run therefore does not depend on same-second tie ordering; that behavior stays
covered by the B4 quota tests, so a B4 ordering change does not require a B5
fixture change unless the shared read contract itself changes.

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
- [ ] Quota current windows come only from the latest valid sample; a sample
      more than 5 minutes ahead of its own ingestion time is excluded as a clock
      anomaly even when the upstream `time_anomaly` flag is absent.
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
| Missing log / shorter or replaced log | Missing input blocks new reads, but a pending outbox is still retried first. A shorter or replaced log warns and restarts from zero, which can overwrite part of the active hour; quiesce writers and restore complete logs/state for exact totals. |
| Heartbeat fresh but data old | Expected: liveness and data freshness are separate. |
| Quota card stale | Check the shipper timer, the latest attempt warning, and the sample age. |
| AGY token total missing | Expected in v1: AGY token usage is not collected and must not be shown as `0`. |
