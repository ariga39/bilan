# bilan project collaboration rules

This file records only the rules that apply to the project itself and can be shared publicly with all contributors. Machine-local orchestration tooling and credential-operations conventions are not repository content.

Functional delivery comes first: process, documentation, review, and compliance checks must stay proportional to actual risk and must not dominate a small personal project.

## Authoritative references

- [docs/DESIGN.md](docs/DESIGN.md) is the authoritative v1 design specification (architecture, D1 schema, accounting rules, Push/Pull contracts, security boundaries, and locked tech stack).
- [docs/TASKS.md](docs/TASKS.md) defines the v1 behavior slices (`B1`–`B5`).

## Tech stack & tooling (locked)

Do not substitute bare/vanilla HTML+JS or alternate stacks without explicit new authority:

- **Monorepo & Workers**: `pnpm` workspaces, TypeScript (`strict`), Cloudflare Workers + D1 (`wrangler`), routed with **Hono**.
- **Frontend (`bilan-web`)**: **React + TypeScript + Vite + TanStack Start (SSR, file routes and search) + TanStack Router + TanStack Query + Tailwind CSS + shadcn/ui + lucide-react + Recharts**.
- **Cloudflare build/runtime**: **`@cloudflare/vite-plugin`** with **`wrangler`**, D1 bindings, and a custom Worker server entry that routes public `/api/*` requests through Hono while TanStack Start serves the SSR application. D1 remains server-only.
- **Formatting, Linting & Testing (JS/TS)**:
  - **oxfmt** for formatting.
  - **oxlint** with Cloudflare's official preset (**`@cloudflare/oxlint-config`**).
  - **Vitest** (with `@cloudflare/vitest-pool-workers` for local Miniflare/D1 behavior tests).
- **Host Shippers (`shippers/`)**: Python 3 standard library only (zero third-party runtime dependencies), tested with `unittest`.

## Behavior-based TDD

- Development follows behavior-based TDD. Tests describe behavior observable through the public interface (HTTP endpoints, Worker Cron entry points, shipper CLIs, rendered UI behavior); they do not test private helpers, internal call counts, or implementation structure.
- Use small vertical loops: for one behavior, first write a failing test (red), then the minimal implementation that just satisfies that behavior (green), then move on to the next behavior.
- Do not break a behavior into horizontal layer tasks ("database first, then API, then UI, then tests") or prescribe internal abstractions before a current caller proves the seam.
- Test expectations must come from [docs/DESIGN.md](docs/DESIGN.md), synthetic protocol fixtures, or independent known results; they must not re-implement the same algorithm and form tautological tests.
- Refactoring belongs after a behavior passes, keeping external behavior unchanged.

## GitHub issue → PR → merge

- Split issues and tasks by observable behavior, not by files, layers, functions, or exhaustive edge-case matrices.
- Deliver the smallest useful behavior with behavior-based TDD and no speculative scope.
- Once the required behavior works and its focused checks (`oxfmt`, `oxlint`, typecheck, Vitest / `unittest`) pass, commit and open the PR promptly. Do not hold the PR for speculative hardening or imagined edge cases.
- Missing required functionality, real regressions, broken accounting invariants, or exposed secrets are blockers. Non-critical enhancements and extra edge cases become explicit follow-up issues.

## Security, accounting & privacy red lines

- **Public repository**: Treat every commit as immediately public. Never commit real secrets, API keys, Bearer tokens, Cloudflare account/D1 IDs if private, OAuth credentials, or identifiable personal/machine data (real usernames, hostnames, IPs, private paths, or real usage logs). Use synthetic placeholders such as `bilan.example.com`, `machine-a`, or `key-fp-1`.
- **Two-Worker read/write isolation**:
  - `bilan-web` must keep `workers_dev = false`, `preview_urls = false`, zero write routes, and zero upstream/ingest secrets.
  - `bilan-ingest` must expose zero read/UI routes and resolve `producer_id` strictly from the authenticated scoped Bearer token.
- **Accounting integrity**:
  - Never display uncollected metrics (e.g., AGY token usage) as `0`.
  - Never label balance-only differences (e.g., DeepSeek `net_delta`) as spend/burn.
  - Never collapse `NULL` into `0`, never sum across incompatible `accounting_basis` or `unit_kind`, and never present partial token sums (`SUM(col_counted) < SUM(unit_count)`) as complete totals.
  - Never let heartbeats or historical backfills refresh data freshness, and never let future-anomalous clocks poison `MAX(sampled_at)`.

## Scope discipline & community reuse

- Do not implement v2 features (pricing catalog, subscription ledger UI, AGY token ingestion, alerting webhooks) in advance.
- Do not modify upstream repositories (`debitmetre`, `orihsus`, `telemetre`) as part of tasks in this repository.
- Prefer mature, well-maintained libraries already in the locked stack (`Hono`, `shadcn/ui`, `Recharts`, `wrangler`, Python stdlib) over bespoke reinvention.
