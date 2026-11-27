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
They render the same `App` component, Tailwind styles, and UI components as the
application. Only `fetch` is replaced at the read-API boundary, so the app's own
validation, error handling, controls, and refresh timer still run.

| Story       | What it covers                                                     |
| ----------- | ------------------------------------------------------------------ |
| `Populated` | Five producers, two balances, quota windows, usage, and history    |
| `Loading`   | The initial loading placeholders                                   |
| `Empty`     | Explicit empty states, never zero-filled metrics                   |
| `Failure`   | Fetch failure banner and unavailable usage state                   |

The fixtures in
[`workers/web/src/client/stories/fixtures.ts`](../workers/web/src/client/stories/fixtures.ts)
are synthetic and deterministic. They use the fixed clock
`2026-11-27T12:00:00Z`, synthetic accounts such as `primary`, `machine-a`, and
`key-fp-1`, and no production identifiers. The set intentionally includes
current samples, a delayed DeepSeek balance, a stale OpenCode Go key, a failed
producer, and a future-clock anomaly.

## Add a scenario

1. Add a builder to `fixtures.ts` (or extend an existing one) that returns one
   of the schemas from `@bilan/shared/schemas`.
2. If the scenario needs a new fetch behavior, add it to
   `workers/web/src/client/stories/fetch-mock.ts` and extend `StorybookScenario`.
3. Export a story in `Dashboard.stories.tsx`:

   ```tsx
   export const PartialHistory: Story = {
     parameters: { bilanScenario: "partial-history" },
   };
   ```

4. Read query parameters from the request URL when a fixture should respond to
   the timezone or month controls, rather than hard-coding one selection.

Storybook resolves the scenario through `.storybook/preview.tsx`, installs the
mock before the story renders, and pins `Date` so relative ages and the default
month do not drift.
