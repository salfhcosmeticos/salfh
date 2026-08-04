# Dashboard visual shell + live revenue cards — design

**Date:** 2026-08-04
**Status:** approved by owner, spec-reviewed 2026-08-04, ready for planning
**Builds on:** `2026-08-03-vendas-mercadolivre-design.md` (Vendas/Mercado Livre module, already live in production)

## Purpose

The Vendas dashboard works but is currently unstyled HTML (plain `<main>`/`<p>` tags, no
CSS framework at all). The owner shared two reference screenshots of other dashboard
products (a generic e-commerce SaaS with gauge-style KPI cards, and a finance SaaS with a
left sidebar nav) and asked for something in that spirit — clean, visual — plus revenue
broken out by day/week/month and a live-updating total that reflects new sales without a
page reload.

This is a visual/UX pass over the existing Vendas module and a first cut at the persistent
navigation shell the rest of the roadmap (Estoque, Anúncios, Financeiro, etc.) will hang
off later. It does not add any new marketplace integration or business logic beyond revenue
period comparisons.

## Non-goals

- No new pages/routes for Produtos, Estoque, Anúncios, Financeiro, Margem de contribuição,
  Configurações, or Integrações. These become disabled "em breve" entries in the sidebar
  only. (Explicitly confirmed with the owner — the connect-Mercado-Livre button stays on
  the Vendas page rather than moving to a dedicated Integrações screen.)
- No goal-setting / targets feature. The reference screenshot's circular gauge widgets
  imply a configurable goal, which nothing in this project currently models. KPI cards use
  a number + a period-over-period % change badge instead of a gauge.
- No changes to the Mercado Livre integration, OAuth, webhook, or backfill logic (Tasks
  1–12 of the prior plan). This spec only touches presentation (`src/app/page.tsx` and the
  components it renders) and adds one new pure calculation module.
- No multi-tenant concerns (no "Assinatura" nav item, no per-user theming) — this is a
  single-company internal dashboard.

## Architecture

### Styling foundation

Add Tailwind CSS (with the standard Next.js/PostCSS setup) and shadcn/ui, plus
`lucide-react` for icons. shadcn/ui is chosen over a heavier component library (MUI,
Chakra) because it copies small, editable components directly into the repo (no runtime
dependency bloat) and is the de facto standard for this exact style of dashboard in
Next.js. Components used: `Card`, `Badge`, `Table`, `ToggleGroup`, `Skeleton` (for loading
states), plus shadcn's `Sidebar` block (`SidebarProvider`/`Sidebar`/`SidebarMenu`
primitives) rather than a hand-rolled sidebar — it already implements the cookie-based
collapse persistence described below, so there's nothing to reinvent.

### App shell

`src/app/layout.tsx` gains a persistent two-column shell: a left `Sidebar` (client
component, collapsible) and a main content area. Collapse state is persisted the way
shadcn's own sidebar block does it — a cookie set from the client on toggle and read
server-side in `layout.tsx` to set the initial state — not `localStorage`. A
client-only `localStorage` read would render the sidebar expanded on first paint and
then flip after hydration, causing a visible flash/mismatch; the cookie approach lets
the server render the correct initial state. The sidebar renders these items top to
bottom, each with a `lucide-react` icon:

| Item | Route | State |
|---|---|---|
| Vendas | `/` | active (current page) |
| Produtos | — | disabled, "em breve" |
| Estoque | — | disabled, "em breve" |
| Anúncios | — | disabled, "em breve" |
| Financeiro | — | disabled, "em breve" |
| Margem de contribuição | — | disabled, "em breve" |
| Integrações | — | disabled, "em breve" |
| Configurações | — | disabled, "em breve" |

Disabled items are visually muted, not links (no `href`, or `href` pointing nowhere with
`aria-disabled`), so there is no dead-end navigation. Only "Vendas" is a real, highlighted
link for now. There is no separate "Home" entry — Vendas is the landing page.

### Data flow: server fetch + client realtime

The `orders` query (select id, status, total_amount, order_date, order_items(title),
ordered by order_date desc) is extracted from `page.tsx` into a shared function,
`fetchDashboardOrders(supabase)`, in `src/lib/sales/fetchOrders.ts`. It accepts either the
server or the browser Supabase client (both satisfy the same `SupabaseClient` type) and
returns the same mapped row shape used today. This makes "server load and realtime
refresh use the exact same read path" literally true — one function, not two hand-copied
queries that can drift apart.

`src/app/page.tsx` stays a Server Component and keeps its current responsibilities
unchanged: resolve the authenticated user, render the existing logged-out / query-error
states, and call `fetchDashboardOrders`. Instead of rendering `SummaryCards` /
`SalesChart` / `OrdersTable` directly, it passes the fetched rows as `initialOrders` into a
new Client Component, `VendasDashboardClient`.

`VendasDashboardClient` owns all client-side state:

- Holds `orders` in state, seeded from `initialOrders`.
- On mount, opens a single Supabase Realtime channel subscribed to both tables that feed
  the dashboard:
  `supabase.channel('orders-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, handler).on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, handler)`.
  Both tables are listened to because `upsertOrder` (`src/lib/mercadolivre/sync.ts`) writes
  `orders` and `order_items` as two separate upserts, not one transaction — listening to
  `orders` alone risks a refetch landing between the two writes and showing a blank
  `itemsSummary` for the new order, with no later event to correct it.
- On any event, calls `fetchDashboardOrders` again and replaces state wholesale.
  Re-querying instead of patching the row locally is deliberate: it reuses the exact same
  read path as the initial load (one code path to reason about), and correctly handles a
  status transition (e.g. `paid` → `cancelled`) without hand-rolled reconciliation logic.
- Derives `revenueRows`, the four KPI numbers, chart data, and table rows from that single
  `orders` state via the existing `filterRevenueOrders` / `aggregateSales` helpers plus the
  new `summarizeRevenue` helper (below) — all pure functions, all recomputed on every
  state change.
- Tracks a `lastUpdatedAt` timestamp, bumped whenever a realtime event is processed, to
  drive the "atualizado agora" live indicator.
- If the channel disconnects, the Supabase client's built-in reconnect handles recovery;
  the UI keeps showing the last good snapshot in the meantime. No custom retry logic.

This keeps exactly one realtime subscription per page view, shared by the cards, chart,
and table, rather than each component subscribing independently.

**Enabling Realtime on these tables:** `postgres_changes` only fires for tables added to
the `supabase_realtime` publication — a separate opt-in from RLS. Neither `orders` nor
`order_items` is in that publication today (`supabase/migrations/0001_init.sql` never
touches it), so without action the whole live-update feature would silently no-op (no
error, it just never updates). A new migration adds both tables:

```sql
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
```

Existing RLS policies (`orders_owner_select`, `order_items_owner_select`) already scope
`select` to the owning user, and Realtime respects RLS for authenticated clients, so this
doesn't widen access — it only turns on the change feed.

### KPI cards

Four `Card` components in a row, replacing the current bare `SummaryCards`:

1. **Total** — sum of all revenue-eligible orders ever (unchanged from today's
   "Faturamento" card).
2. **Hoje** — revenue-eligible orders with `order_date` today, compared to yesterday.
3. **Semana** — current ISO week (Monday start, matching `aggregateSales`'s existing
   week bucketing) compared to the previous week.
4. **Mês** — current calendar month compared to the previous calendar month.

Each of cards 2–4 shows the current-period total plus a small `Badge` with the % change
vs. the prior period (green + up arrow for positive, red + down arrow for negative, neutral
style when the previous period was zero and no % is meaningful — show "novo" instead of a
misleading infinite/undefined percentage).

New pure function in `src/lib/sales/aggregate.ts`:

```ts
export interface PeriodComparison {
  current: number
  previous: number
  changePct: number | null // null = previous period had zero revenue, no % shown
}

export interface RevenueSummary {
  total: number
  today: PeriodComparison
  week: PeriodComparison
  month: PeriodComparison
}

export function summarizeRevenue(orders: OrderForAggregation[], now?: Date): RevenueSummary
```

`now` is an optional injected clock (defaults to `new Date()`) purely for testability, same
pattern already used by `buildMonthlyWindows` in `sync.ts`. Callers pass already
revenue-filtered orders (`filterRevenueOrders(orders)`), consistent with how
`SummaryCards`/`SalesChart` are fed today.

**Timezone:** day/week/month boundaries are computed from the Node process's local
timezone (via `date-fns`'s `startOfDay`/`startOfWeek`/`startOfMonth`, same as the existing
`aggregateSales`). Nothing in the project currently pins a timezone — the Dockerfile sets
none — so on EasyPanel this defaults to UTC, three hours ahead of the owner's
America/Sao_Paulo clock. Left unfixed, "Hoje" would roll over at 21:00 Brasília time
instead of midnight, visibly misclassifying evening orders on the one feature this spec
adds that's explicitly framed around calendar days. Fix at the deployment level, not in
the aggregation code: add `ENV TZ=America/Sao_Paulo` to the `Dockerfile`. This corrects
`summarizeRevenue` and every existing day/week/month bucketing in `aggregateSales` at
once, with no code change to either.

### Live indicator

A small element near the KPI section header: a colored dot (green when the realtime
channel is subscribed, grey otherwise) and text "Ao vivo · atualizado agora" /
"atualizado há Xm", updating from `lastUpdatedAt`. Purely presentational, no new data
dependency beyond what `VendasDashboardClient` already tracks.

### Chart and table

`SalesChart` and `OrdersTable` keep their existing logic (granularity toggle, aggregation,
cancelled-orders filter) untouched at the data level. Only their markup changes: chart
controls move to a shadcn `ToggleGroup`, both get wrapped in `Card`, and colors are
reconciled with the existing validated palette already documented in `SalesChart.tsx`
(`COLOR_REVENUE` etc. stay as the source of truth for the chart itself — the dataviz skill
should be consulted again if new chart colors are introduced beyond what's already there).

`SalesChart` currently renders a fixed-size `ComposedChart` (`width={720} height={360}`),
which doesn't fit a layout with a collapsible sidebar — it'll overflow or leave dead space
depending on viewport and collapse state. Since this pass already touches the chart's
wrapper markup, swap in recharts' `ResponsiveContainer` (`height={360}`, `width="100%"`)
around the existing `ComposedChart` so it fills its `Card` at any sidebar width.

## Error handling

- Logged-out and query-error states from `page.tsx` are preserved, just restyled with the
  new components.
- A `summarizeRevenue` call on an empty `orders` array returns all-zero totals and
  `changePct: null` everywhere — no special-casing needed by callers.
- Realtime subscription failures degrade to "last known snapshot, live dot goes grey" —
  never a crash, never a blank dashboard.

## Testing

- `summarizeRevenue`: unit tests in `src/lib/sales/aggregate.test.ts` covering today/
  yesterday boundaries, week boundaries (Monday start), month boundaries, a zero-previous-
  period case (`changePct: null`), and an empty-orders case.
- `VendasDashboardClient`: a lightweight test with `@testing-library/react` (already a
  dependency) that mocks the Supabase channel, fires a simulated `postgres_changes` event,
  and asserts the displayed totals update and `lastUpdatedAt` changes.
- Existing tests for `aggregateSales`, `filterRevenueOrders`, the webhook route, and
  `sync.ts` are unaffected and must keep passing.
- `npm run build` must succeed with Tailwind/shadcn wired in (new PostCSS/Tailwind config
  files, `globals.css`).

## Rollout

Mostly a frontend/presentation change plus one new pure function, but it also carries two
small infrastructure pieces surfaced during spec review: a new migration enabling Realtime
on `orders`/`order_items`, and a one-line `Dockerfile` change pinning the container
timezone. No new environment variables, no changes to the Mercado Livre integration logic
itself. The migration must be applied to the Supabase project before or alongside the
deploy — a live dashboard with no Realtime events is a silent failure, not a loud one, so
it's worth confirming manually after rollout (trigger a webhook/backfill and watch the live
dot). Ships the same way as prior work: commits to `main`, deployed via the existing
EasyPanel GitHub-connected pipeline.
