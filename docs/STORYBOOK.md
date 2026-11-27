# Storybook dashboard preview

`pnpm storybook` previews the real dashboard without Cloudflare, D1, a local
Worker, or any live API credentials. Storybook is a development-only
dependency and is not imported by the production application entry point.

## Commands

From the repository root, after `pnpm install`:

```sh
pnpm storybook        # dev server at http://localhost:6006
pnpm build-storybook  # static build in workers/web/storybook-static/
```

The preview is fully offline after dependencies are installed. To inspect a
static build locally, serve the output directory with any static file server,
for example:

```sh
python -m http.server 6006 --directory workers/web/storybook-static
```

## Viewports

The Storybook toolbar provides two presets:

- **Desktop (1440 × 900)**
- **Mobile (390 × 844)**

The `Dashboard/Populated` story starts at Desktop. The
`Dashboard/Populated (mobile)` story pins the Mobile preset so it can be opened
directly.

## Scenarios

Stories live in
[`workers/web/src/client/stories/Dashboard.stories.tsx`](../workers/web/src/client/stories/Dashboard.stories.tsx).
Each story uses the actual TanStack Router route tree with memory history and a
request-scoped TanStack Query client. A synthetic `DashboardDataSource` supplies
the fixture data, so route search, loaders, navigation, refresh invalidation,
month and timezone controls behave like the application without D1 or a Worker.
Storybook pins `Date` so relative ages and the default month do not drift.

| Story       | What it covers                                                     |
| ----------- | ------------------------------------------------------------------ |
| `Populated` | Five producers, two balances, quota windows, usage, and history    |
| `Loading`   | The pending dashboard state                                       |
| `Empty`     | Explicit empty states, never zero-filled metrics                   |
| `Failure`   | The route error state for a failed read                            |
| `Stale`     | A stale OpenCode Go key and delayed sample                         |
| `Failed`    | A visible key whose latest attempt failed                          |
| `Anomalous` | A clock-anomaly warning on an otherwise current key                |
| `Missing reset` | Windows whose reset time is not reported                       |
| `Funded provider` | A balance with funded/credit values                          |
| `Usage (populated)` | Today, monthly totals, mixed coverage and daily trends    |
| `Usage (mobile)` | Compact 390 × 844 usage header and first platform values     |
| `Usage (sparse partial and unknown coverage)` | Partial and NULL token columns |
| `Usage (empty historical month)` | A labelled historical range with no rows      |
| `Usage (Asia/Kolkata approximation)` | The non-whole-hour attribution note      |

The fixtures in
[`workers/web/src/client/stories/fixtures.ts`](../workers/web/src/client/stories/fixtures.ts)
are synthetic and deterministic. They use the fixed clock
`2026-11-27T12:00:00Z`, synthetic accounts such as `primary`, `machine-a`, and
`key-fp-1`, and no production identifiers. The set intentionally includes
current samples, a delayed DeepSeek balance, a stale OpenCode Go key, a failed
producer, and a future-clock anomaly. Usage rows only exist for November 2026:
selecting another month returns empty usage rows (and empty freshness metadata)
for both the overview and daily responses, while producers, balances, and live
quota windows stay populated. The usage stories open the dedicated view directly
with `view=usage`, and exercise the sparse/partial/unknown fixture, the empty
historical month, and the Asia/Kolkata approximation note. The nine OpenCode Go
keys exercise the dashboard visibility rule: three recent keys are visible (one
just under seven days, one restored by a recent failed attempt) and six older
keys are omitted, including the exact seven-day boundary and a
future-anomalous timestamp.

## Add a scenario

1. Add a builder to `fixtures.ts` (or extend an existing one) that returns one
   of the schemas from `@bilan/shared/schemas`.
2. Add the scenario to `STORYBOOK_SCENARIOS` and, when it needs transformed
   data, `buildScenarioOverview` in
   `workers/web/src/client/stories/scenarios.ts`. Loading, empty and failure
   behavior lives in `createDataSource` in `Dashboard.stories.tsx`; extend that
   switch instead of adding a duplicate option list.
3. Export a story in `Dashboard.stories.tsx`:

   ```tsx
   export const PartialHistory: Story = {
     args: { scenario: "partial-history" },
   };
   ```

4. Keep fixture responses keyed by the router search (`view`, `tz`, `month`) so
   navigation, refresh and the controls keep working through the same route
   loader and query keys.

The Storybook Vite config intentionally excludes the Cloudflare/Start plugins
because the memory router and synthetic data source never call the Worker.
