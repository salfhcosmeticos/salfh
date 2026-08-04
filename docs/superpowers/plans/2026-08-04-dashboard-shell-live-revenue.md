# Dashboard visual shell + live revenue cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the unstyled Vendas dashboard into a styled app with a persistent sidebar shell, four KPI cards (Total/Hoje/Semana/Mês) with period-over-period comparisons, and a live indicator that updates via Supabase Realtime without a page reload.

**Architecture:** Add Tailwind CSS + shadcn/ui as the styling foundation. Split the app into a root layout (html/body only) and a `(dashboard)` route group layout that adds the sidebar shell — so `/login` never gets the sidebar. Extract the orders query into one shared function used by both the initial server render and the client-side realtime refresh, so there is exactly one code path for "what does the dashboard show." A single Client Component (`VendasDashboardClient`) owns realtime subscription + derived state for the KPI cards, chart, and table.

**Tech Stack:** Next.js 15 (App Router) + React 18, Tailwind CSS v4, shadcn/ui, lucide-react, recharts (already present), Supabase (`@supabase/ssr`, Realtime), date-fns, Vitest + `@testing-library/react`.

**Builds on:** `docs/superpowers/specs/2026-08-04-dashboard-shell-live-revenue-design.md` (spec, reviewed and updated 2026-08-04).

## Global Constraints

- No new pages/routes for Produtos, Estoque, Anúncios, Financeiro, Margem de contribuição, Configurações, or Integrações — these are disabled "em breve" sidebar entries only, not links.
- No goal-setting/targets feature — KPI cards show a number + a period-over-period % badge, never a gauge.
- No changes to the Mercado Livre integration, OAuth, webhook, or backfill logic in `src/lib/mercadolivre/**`.
- No multi-tenant concerns (no "Assinatura" nav item, no per-user theming).
- Read-only access to marketplace APIs only, project-wide — not touched by this plan, but no task may add a write call against a marketplace API.
- TypeScript strict mode (`tsconfig.json` has `"strict": true`); the `@/*` path alias maps to `src/*`.
- All currency display goes through the existing `formatCurrencyBRL` helper (`src/lib/format.ts`) — never hand-rolled.
- All UI copy is Portuguese (pt-BR), matching existing strings ("Faturamento", "Pedidos", etc.).
- `@testing-library/jest-dom` is **not** installed in this project and this plan does not add it — component tests use plain Vitest assertions (`.textContent`, `getByText`/`getByTestId` existence, `toEqual`), not `toBeInTheDocument()`/`toHaveTextContent()`.

---

### Task 1: Enable Realtime on orders tables + pin container timezone

**Files:**
- Create: `supabase/migrations/0002_enable_realtime_orders.sql`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `orders` and `order_items` tables emit `postgres_changes` events (required by Task 10's realtime subscription); the container's local timezone is `America/Sao_Paulo` (required for `summarizeRevenue` in Task 4 to bucket "Hoje/Semana/Mês" correctly in production).

- [ ] **Step 1: Write the migration**

`supabase/migrations/0002_enable_realtime_orders.sql`:

```sql
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
```

- [ ] **Step 2: Apply the migration**

Run this SQL in the Supabase project's SQL Editor (Dashboard → SQL Editor → paste contents of `0002_enable_realtime_orders.sql` → Run).
Expected: no errors. If either table is already in the publication, Postgres will error with "relation is already member of publication" — in that case remove just that line and re-run.

- [ ] **Step 3: Verify both tables are in the publication**

Run in the SQL Editor:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime';
```

Expected: rows for `public.orders` and `public.order_items` both present.

- [ ] **Step 4: Pin the container timezone**

In `Dockerfile`, add a line to the runner stage (the stage that actually runs in production), right after `ENV NODE_ENV=production`:

```dockerfile
ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_enable_realtime_orders.sql Dockerfile
git commit -m "feat: enable Realtime on orders/order_items and pin container timezone"
```

---

### Task 2: Add Tailwind CSS

**Files:**
- Create: `postcss.config.mjs`
- Create: `src/app/globals.css`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: Tailwind utility classes are available in any `.tsx` file; `src/app/globals.css` exists as the single global stylesheet (Task 3's `shadcn init` will append CSS variables to this same file).

- [ ] **Step 1: Install Tailwind**

```bash
npm install tailwindcss @tailwindcss/postcss postcss
```

- [ ] **Step 2: Add the PostCSS config**

`postcss.config.mjs`:

```js
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
```

- [ ] **Step 3: Add the global stylesheet**

`src/app/globals.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 4: Import it from the root layout**

Modify `src/app/layout.tsx`, add the import at the top:

```tsx
import './globals.css'

export const metadata = { title: 'Dashboard Marketplaces' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 5: Verify the build picks up Tailwind**

Temporarily add `className="text-red-500"` to the `<p>` in `src/app/login/page.tsx`'s error message, run:

```bash
npm run build
```

Expected: build succeeds with no PostCSS/Tailwind errors. Then remove the temporary `className` again (it was only to prove the pipeline works; login page styling is out of scope for this plan).

- [ ] **Step 6: Commit**

```bash
git add postcss.config.mjs src/app/globals.css src/app/layout.tsx package.json package-lock.json
git commit -m "feat: add Tailwind CSS"
```

---

### Task 3: Add shadcn/ui and the components this plan needs

**Files:**
- Create: `components.json` (generated)
- Create: `src/lib/utils.ts` (generated)
- Create: `src/components/ui/card.tsx`, `badge.tsx`, `table.tsx`, `toggle-group.tsx`, `toggle.tsx`, `sidebar.tsx`, `button.tsx`, `separator.tsx`, `tooltip.tsx`, `sheet.tsx`, `input.tsx` (all generated)
- Modify: `src/app/globals.css` (CLI appends theme tokens)

**Interfaces:**
- Consumes: Tailwind from Task 2.
- Produces: `cn()` from `@/lib/utils`; `Card`/`CardHeader`/`CardTitle`/`CardContent` from `@/components/ui/card`; `Badge` from `@/components/ui/badge`; `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` from `@/components/ui/table`; `ToggleGroup`/`ToggleGroupItem` from `@/components/ui/toggle-group`; `Sidebar`, `SidebarProvider`, `SidebarInset`, `SidebarTrigger`, `SidebarContent`, `SidebarHeader`, `SidebarGroup`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` from `@/components/ui/sidebar` — all consumed by Tasks 7–10.

- [ ] **Step 1: Initialize shadcn/ui**

```bash
npx shadcn@latest init -y -d
```

Expected: creates `components.json`, creates `src/lib/utils.ts` exporting a `cn()` helper, and appends CSS variable definitions (`@theme`/`:root` tokens) to `src/app/globals.css`. It may also install `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react` as dependencies — that's expected and needed (`lucide-react` is used for sidebar icons in Task 7).

- [ ] **Step 2: Add every primitive this plan uses**

```bash
npx shadcn@latest add card badge table toggle-group sidebar button separator tooltip sheet input -y
```

Expected: creates the files listed above under `src/components/ui/`. The `sidebar` component pulls in `button`, `separator`, `sheet`, `tooltip`, and `input` as dependencies if not already added — passing them explicitly here just makes that dependency set visible. (The spec also mentions a `Skeleton` component for loading states, but nothing in this plan has a genuine loading gap — `page.tsx` awaits the initial data server-side before rendering, and realtime refreshes swap data silently — so it's deliberately left out; add it later if a real loading state shows up.)

- [ ] **Step 3: Confirm the sidebar's cookie name**

```bash
grep -n "SIDEBAR_COOKIE_NAME" src/components/ui/sidebar.tsx
```

Expected: a line defining `const SIDEBAR_COOKIE_NAME = "sidebar_state"`. Task 7's layout reads this exact cookie name to set the sidebar's initial server-rendered state — if the generated value differs from `sidebar_state`, use whatever this grep actually shows instead.

- [ ] **Step 4: Verify the app still builds**

```bash
npm run build
```

Expected: succeeds (no page uses the new components yet, so this only proves the generated files themselves compile).

- [ ] **Step 5: Commit**

```bash
git add components.json src/lib/utils.ts src/components/ui src/app/globals.css package.json package-lock.json
git commit -m "feat: add shadcn/ui components"
```

---

### Task 4: Add `summarizeRevenue` for period-over-period KPI comparisons

**Files:**
- Modify: `src/lib/sales/aggregate.ts`
- Test: `src/lib/sales/aggregate.test.ts`

**Interfaces:**
- Consumes: `OrderForAggregation` (already defined in `aggregate.ts`: `{ orderDate: string; totalAmount: number }`).
- Produces: `PeriodComparison { current: number; previous: number; changePct: number | null }`, `RevenueSummary { total: number; today: PeriodComparison; week: PeriodComparison; month: PeriodComparison }`, and `summarizeRevenue(orders: OrderForAggregation[], now?: Date): RevenueSummary` — consumed by Task 10's KPI cards.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/sales/aggregate.test.ts` (add `summarizeRevenue` to the existing import line, then add this new `describe` block):

```ts
import { aggregateSales, filterRevenueOrders, isRevenueStatus, summarizeRevenue, REVENUE_STATUSES } from './aggregate'

// ... existing describe blocks stay unchanged ...

describe('summarizeRevenue', () => {
  const now = new Date('2026-08-04T12:00:00.000Z') // Tuesday

  it('splits today vs yesterday', () => {
    const orders = [
      { orderDate: '2026-08-04T09:00:00.000Z', totalAmount: 100 }, // today
      { orderDate: '2026-08-03T09:00:00.000Z', totalAmount: 40 }, // yesterday
      { orderDate: '2026-08-02T09:00:00.000Z', totalAmount: 999 }, // neither
    ]
    const summary = summarizeRevenue(orders, now)
    expect(summary.today).toEqual({ current: 100, previous: 40, changePct: 150 })
  })

  it('compares the current ISO week (Monday start) to the previous week', () => {
    const orders = [
      { orderDate: '2026-08-03T09:00:00.000Z', totalAmount: 100 }, // Mon this week
      { orderDate: '2026-08-04T09:00:00.000Z', totalAmount: 50 }, // Tue this week
      { orderDate: '2026-07-27T09:00:00.000Z', totalAmount: 60 }, // Mon last week
      { orderDate: '2026-07-20T09:00:00.000Z', totalAmount: 999 }, // two weeks ago
    ]
    const summary = summarizeRevenue(orders, now)
    expect(summary.week).toEqual({ current: 150, previous: 60, changePct: 150 })
  })

  it('compares the current calendar month to the previous month, not a different year with the same month number', () => {
    const orders = [
      { orderDate: '2026-08-01T09:00:00.000Z', totalAmount: 100 },
      { orderDate: '2026-08-04T09:00:00.000Z', totalAmount: 50 },
      { orderDate: '2026-07-15T09:00:00.000Z', totalAmount: 200 },
      { orderDate: '2025-08-15T09:00:00.000Z', totalAmount: 999 }, // same month number, wrong year
    ]
    const summary = summarizeRevenue(orders, now)
    expect(summary.month).toEqual({ current: 150, previous: 200, changePct: -25 })
  })

  it('returns changePct: null when the previous period had zero revenue', () => {
    const orders = [{ orderDate: '2026-08-04T09:00:00.000Z', totalAmount: 100 }]
    const summary = summarizeRevenue(orders, now)
    expect(summary.today).toEqual({ current: 100, previous: 0, changePct: null })
  })

  it('returns all-zero totals for an empty order list', () => {
    const summary = summarizeRevenue([], now)
    expect(summary).toEqual({
      total: 0,
      today: { current: 0, previous: 0, changePct: null },
      week: { current: 0, previous: 0, changePct: null },
      month: { current: 0, previous: 0, changePct: null },
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- aggregate
```

Expected: FAIL — `summarizeRevenue is not a function` (or a TypeScript error on the import).

- [ ] **Step 3: Implement `summarizeRevenue`**

Add to `src/lib/sales/aggregate.ts` (extend the existing `date-fns` import line and add the new code below the existing `aggregateSales` function):

```ts
import {
  format,
  isSameDay,
  isSameISOWeek,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'

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

function sumWhere(orders: OrderForAggregation[], predicate: (date: Date) => boolean): number {
  return orders
    .filter((order) => predicate(new Date(order.orderDate)))
    .reduce((sum, order) => sum + order.totalAmount, 0)
}

function comparePeriods(current: number, previous: number): PeriodComparison {
  return { current, previous, changePct: previous === 0 ? null : ((current - previous) / previous) * 100 }
}

export function summarizeRevenue(orders: OrderForAggregation[], now: Date = new Date()): RevenueSummary {
  const total = orders.reduce((sum, order) => sum + order.totalAmount, 0)

  const yesterday = subDays(now, 1)
  const lastWeek = subWeeks(now, 1)
  const lastMonth = subMonths(now, 1)

  return {
    total,
    today: comparePeriods(
      sumWhere(orders, (date) => isSameDay(date, now)),
      sumWhere(orders, (date) => isSameDay(date, yesterday))
    ),
    week: comparePeriods(
      sumWhere(orders, (date) => isSameISOWeek(date, now)),
      sumWhere(orders, (date) => isSameISOWeek(date, lastWeek))
    ),
    month: comparePeriods(
      sumWhere(orders, (date) => isSameMonth(date, now)),
      sumWhere(orders, (date) => isSameMonth(date, lastMonth))
    ),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- aggregate
```

Expected: PASS, all `summarizeRevenue` cases and all pre-existing `aggregateSales`/`filterRevenueOrders` cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales/aggregate.ts src/lib/sales/aggregate.test.ts
git commit -m "feat: add summarizeRevenue for Hoje/Semana/Mes KPI comparisons"
```

---

### Task 5: Extract the shared orders query into `fetchDashboardOrders`

**Files:**
- Create: `src/lib/sales/fetchOrders.ts`
- Test: `src/lib/sales/fetchOrders.test.ts`

**Interfaces:**
- Consumes: any object shaped like `{ from(table): { select(cols): { order(col, opts): Promise<{ data, error }> } } }` — both `createServerSupabaseClient()` and `createBrowserSupabaseClient()` satisfy this (they return `SupabaseClient` from `@supabase/supabase-js`/`@supabase/ssr`).
- Produces: `DashboardOrderRow { id: string; status: string; totalAmount: number; orderDate: string; itemsSummary: string }`, `DashboardOrdersResult { rows: DashboardOrderRow[]; error: boolean }`, and `fetchDashboardOrders(supabase): Promise<DashboardOrdersResult>` — consumed by Task 10 (both the server-rendered `page.tsx` and `VendasDashboardClient`'s realtime refetch).

- [ ] **Step 1: Write the failing tests**

`src/lib/sales/fetchOrders.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchDashboardOrders } from './fetchOrders'

function fakeSupabase(response: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve(response),
      }),
    }),
  } as unknown as SupabaseClient
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchDashboardOrders', () => {
  it('maps rows and joins item titles with a comma', async () => {
    const supabase = fakeSupabase({
      data: [
        {
          id: '1',
          status: 'paid',
          total_amount: 150.5,
          order_date: '2026-08-04T09:00:00.000Z',
          order_items: [{ title: 'Produto A' }, { title: 'Produto B' }],
        },
      ],
      error: null,
    })

    const result = await fetchDashboardOrders(supabase)

    expect(result).toEqual({
      error: false,
      rows: [
        {
          id: '1',
          status: 'paid',
          totalAmount: 150.5,
          orderDate: '2026-08-04T09:00:00.000Z',
          itemsSummary: 'Produto A, Produto B',
        },
      ],
    })
  })

  it('joins an empty items array into an empty string', async () => {
    const supabase = fakeSupabase({
      data: [{ id: '2', status: 'cancelled', total_amount: 0, order_date: '2026-08-01T00:00:00.000Z', order_items: [] }],
      error: null,
    })

    const result = await fetchDashboardOrders(supabase)

    expect(result.rows[0].itemsSummary).toBe('')
  })

  it('returns an empty list and error: true when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = fakeSupabase({ data: null, error: { message: 'boom' } })

    const result = await fetchDashboardOrders(supabase)

    expect(result).toEqual({ rows: [], error: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- fetchOrders
```

Expected: FAIL — `Cannot find module './fetchOrders'`.

- [ ] **Step 3: Implement `fetchDashboardOrders`**

`src/lib/sales/fetchOrders.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface DashboardOrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

export interface DashboardOrdersResult {
  rows: DashboardOrderRow[]
  error: boolean
}

export async function fetchDashboardOrders(supabase: SupabaseClient): Promise<DashboardOrdersResult> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, status, total_amount, order_date, order_items(title)')
    .order('order_date', { ascending: false })

  if (error) {
    console.error('Falha ao carregar pedidos no dashboard:', error)
    return { rows: [], error: true }
  }

  const rows = (data ?? []).map((order: Record<string, unknown>) => ({
    id: order.id as string,
    status: order.status as string,
    totalAmount: order.total_amount as number,
    orderDate: order.order_date as string,
    itemsSummary: ((order.order_items ?? []) as { title: string }[]).map((item) => item.title).join(', '),
  }))

  return { rows, error: false }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- fetchOrders
```

Expected: PASS, all three cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales/fetchOrders.ts src/lib/sales/fetchOrders.test.ts
git commit -m "feat: extract shared fetchDashboardOrders query"
```

---

### Task 6: Add the `LiveIndicator` component

**Files:**
- Create: `src/components/LiveIndicator.tsx`
- Test: `src/components/LiveIndicator.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `LiveIndicator({ isLive: boolean; lastUpdatedAt: Date | null })` — consumed by Task 10's `VendasDashboardClient`. Renders an element with `data-testid="last-updated"` holding `lastUpdatedAt?.toISOString() ?? ''`, so callers can assert on the exact timestamp instead of a human-readable string that changes with the clock.

- [ ] **Step 1: Write the failing test**

`src/components/LiveIndicator.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LiveIndicator } from './LiveIndicator'

describe('LiveIndicator', () => {
  it('shows Ao vivo and the exact last-updated timestamp when live', () => {
    const lastUpdatedAt = new Date('2026-08-04T12:00:00.000Z')
    render(<LiveIndicator isLive={true} lastUpdatedAt={lastUpdatedAt} />)

    expect(screen.getByText(/Ao vivo/)).toBeTruthy()
    expect(screen.getByTestId('last-updated').textContent).toBe(lastUpdatedAt.toISOString())
  })

  it('shows Offline and no timestamp yet when nothing has loaded', () => {
    render(<LiveIndicator isLive={false} lastUpdatedAt={null} />)

    expect(screen.getByText(/Offline/)).toBeTruthy()
    expect(screen.getByTestId('last-updated').textContent).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- LiveIndicator
```

Expected: FAIL — `Cannot find module './LiveIndicator'`.

- [ ] **Step 3: Implement `LiveIndicator`**

`src/components/LiveIndicator.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'

interface LiveIndicatorProps {
  isLive: boolean
  lastUpdatedAt: Date | null
}

function formatRelativeUpdate(lastUpdatedAt: Date | null, now: Date): string {
  if (!lastUpdatedAt) return 'aguardando atualização'
  const minutes = Math.floor((now.getTime() - lastUpdatedAt.getTime()) / 60000)
  return minutes < 1 ? 'atualizado agora' : `atualizado há ${minutes}m`
}

export function LiveIndicator({ isLive, lastUpdatedAt }: LiveIndicatorProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-green-500' : 'bg-gray-400'}`} aria-hidden="true" />
      <span>
        {isLive ? 'Ao vivo' : 'Offline'} · {formatRelativeUpdate(lastUpdatedAt, now)}
      </span>
      <span data-testid="last-updated" className="sr-only">
        {lastUpdatedAt?.toISOString() ?? ''}
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- LiveIndicator
```

Expected: PASS, both cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/LiveIndicator.tsx src/components/LiveIndicator.test.tsx
git commit -m "feat: add LiveIndicator component"
```

---

### Task 7: Add the sidebar shell (route group layout + AppSidebar)

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`
- Create: `src/components/AppSidebar.tsx`
- Test: `src/components/AppSidebar.test.tsx`
- Move: `src/app/page.tsx` → `src/app/(dashboard)/page.tsx` (content unchanged in this task)

**Interfaces:**
- Consumes: `Sidebar`, `SidebarProvider`, `SidebarInset`, `SidebarTrigger`, `SidebarContent`, `SidebarHeader`, `SidebarGroup`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` from `@/components/ui/sidebar` (Task 3).
- Produces: every route under `src/app/(dashboard)/` renders inside the sidebar shell; `/login` (outside the group) does not. This is a Next.js route group — the parentheses in the folder name do not add a URL segment, so `src/app/(dashboard)/page.tsx` still serves `/`.

**Why a route group instead of putting the sidebar in the existing root `layout.tsx`:** the spec's own purpose is styling the Vendas dashboard, not the login screen. If the sidebar shell were added directly to the root layout, `/login` would render inside it too — a nav rail with disabled links makes no sense on a screen the user sees before they're authenticated. The route group keeps the root layout to just `<html>`/`<body>`/global styles (from Task 2) and confines the shell to the dashboard pages.

- [ ] **Step 1: Move the Vendas page into the route group**

```bash
mkdir -p "src/app/(dashboard)"
git mv src/app/page.tsx "src/app/(dashboard)/page.tsx"
```

- [ ] **Step 2: Write the failing `AppSidebar` test**

`src/components/AppSidebar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppSidebar } from './AppSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'

describe('AppSidebar', () => {
  it('renders Vendas as a real link and every other item as disabled with no href', () => {
    render(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    )

    const vendasLink = screen.getByRole('link', { name: /Vendas/ })
    expect(vendasLink.getAttribute('href')).toBe('/')

    for (const label of ['Produtos', 'Estoque', 'Anúncios', 'Financeiro', 'Margem de contribuição', 'Integrações', 'Configurações']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull()
      expect(screen.getByText(new RegExp(label))).toBeTruthy()
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- AppSidebar
```

Expected: FAIL — `Cannot find module './AppSidebar'`.

- [ ] **Step 4: Implement `AppSidebar`**

`src/components/AppSidebar.tsx`:

```tsx
'use client'

import Link from 'next/link'
import type { ComponentType } from 'react'
import { LayoutDashboard, Megaphone, Package, PieChart, Plug, Settings, Wallet, Warehouse } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

interface NavItem {
  label: string
  href: string | null
  icon: ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Vendas', href: '/', icon: LayoutDashboard },
  { label: 'Produtos', href: null, icon: Package },
  { label: 'Estoque', href: null, icon: Warehouse },
  { label: 'Anúncios', href: null, icon: Megaphone },
  { label: 'Financeiro', href: null, icon: Wallet },
  { label: 'Margem de contribuição', href: null, icon: PieChart },
  { label: 'Integrações', href: null, icon: Plug },
  { label: 'Configurações', href: null, icon: Settings },
]

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-2 text-sm font-semibold">Dashboard Marketplaces</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.label}>
                  {item.href ? (
                    <SidebarMenuButton asChild isActive tooltip={item.label}>
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton disabled aria-disabled="true" tooltip={`${item.label} (em breve)`}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">em breve</span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- AppSidebar
```

Expected: PASS.

- [ ] **Step 6: Add the dashboard route group layout**

`src/app/(dashboard)/layout.tsx` (replace `sidebar_state` below with whatever Task 3 Step 3 actually found if it differed):

```tsx
import { cookies } from 'next/headers'
import { AppSidebar } from '@/components/AppSidebar'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false'

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset>
        <SidebarTrigger className="m-2" />
        <div className="p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
```

- [ ] **Step 7: Verify manually**

```bash
npm run dev
```

Visit `http://localhost:3000/` — expect the sidebar shell with "Vendas" highlighted and every other item muted/disabled, wrapping the existing (still unstyled) Vendas content. Visit `http://localhost:3000/login` — expect no sidebar at all. Stop the dev server.

- [ ] **Step 8: Run the full test suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)" src/components/AppSidebar.tsx src/components/AppSidebar.test.tsx
git commit -m "feat: add persistent sidebar shell via a dashboard route group"
```

---

### Task 8: Restyle `SalesChart` (responsive, `Card`, `ToggleGroup`)

**Files:**
- Modify: `src/components/SalesChart.tsx`

**Interfaces:**
- Consumes: `Card`, `CardHeader`, `CardTitle`, `CardContent` from `@/components/ui/card`; `ToggleGroup`, `ToggleGroupItem` from `@/components/ui/toggle-group` (Task 3); `ResponsiveContainer` from `recharts` (already a dependency).
- Produces: unchanged external props (`{ orders: { orderDate: string; totalAmount: number }[] }`) — this is a pure markup change, so `src/app/(dashboard)/page.tsx`'s existing call site keeps working without modification until Task 10.

This task only changes markup, not data logic — no new tests needed beyond the existing coverage of `aggregateSales` (unchanged) — but re-run the full suite at the end to prove nothing broke.

- [ ] **Step 1: Replace the fixed-size chart and raw buttons with responsive, styled markup**

Replace the full contents of `src/components/SalesChart.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, type TooltipProps, XAxis, YAxis } from 'recharts'
import { aggregateSales, type SalesGranularity, type SalesPoint } from '@/lib/sales/aggregate'
import { formatCurrencyBRL } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

interface SalesChartProps {
  orders: { orderDate: string; totalAmount: number }[]
}

const GRANULARITY_LABELS: Record<SalesGranularity, string> = {
  day: 'Dia',
  week: 'Semana',
  month: 'Mês',
  year: 'Ano',
}

// Validated categorical palette (dataviz skill, references/palette.md).
// Single series (revenue) → slot 1 (blue). Order count was dropped from
// this chart (owner decision, see task-11-report.md) in favor of a single
// left-axis bar chart; the total is already shown in the KPI cards above.
const COLOR_REVENUE = '#2a78d6' // categorical slot 1 (blue)

// Chart chrome tokens (dataviz skill, references/palette.md), light surface.
const INK_PRIMARY = '#0b0b0b'
const INK_SECONDARY = '#52514e'
const INK_MUTED = '#898781'
const GRID_LINE = '#e1e0d9'
const AXIS_LINE = '#c3c2b7'
const SURFACE = '#fcfcfb'

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null

  const revenue = payload.find((entry) => entry.dataKey === 'revenue')
  if (!revenue) return null

  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${GRID_LINE}`,
        borderRadius: 4,
        padding: '8px 12px',
      }}
    >
      <p style={{ margin: 0, fontSize: 12, color: INK_SECONDARY }}>{label}</p>
      <p style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <span style={{ display: 'inline-block', width: 12, height: 2, background: revenue.color }} />
        <strong style={{ color: INK_PRIMARY }}>{formatCurrencyBRL(revenue.value as number)}</strong>
        <span style={{ color: INK_SECONDARY }}>{revenue.name}</span>
      </p>
    </div>
  )
}

export function SalesChart({ orders }: SalesChartProps) {
  const [granularity, setGranularity] = useState<SalesGranularity>('day')
  const data = useMemo<SalesPoint[]>(() => aggregateSales(orders, granularity), [orders, granularity])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Faturamento</CardTitle>
        <ToggleGroup
          type="single"
          value={granularity}
          onValueChange={(value) => value && setGranularity(value as SalesGranularity)}
          aria-label="Granularidade do gráfico"
        >
          {(Object.keys(GRANULARITY_LABELS) as SalesGranularity[]).map((option) => (
            <ToggleGroupItem key={option} value={option} aria-label={GRANULARITY_LABELS[option]}>
              {GRANULARITY_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={data}>
            <CartesianGrid stroke={GRID_LINE} strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="period"
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={{ stroke: AXIS_LINE }}
              tick={{ fill: INK_MUTED, fontSize: 12 }}
            />
            <YAxis
              yAxisId="revenue"
              tickFormatter={(value) => formatCurrencyBRL(value)}
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={{ stroke: AXIS_LINE }}
              tick={{ fill: INK_MUTED, fontSize: 12 }}
              label={{ value: 'Faturamento (R$)', angle: -90, position: 'insideLeft', fill: INK_MUTED, fontSize: 12 }}
            />
            <Tooltip content={<ChartTooltip />} />
            <Bar yAxisId="revenue" dataKey="revenue" name="Faturamento" fill={COLOR_REVENUE} barSize={24} radius={[4, 4, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: PASS (no `SalesChart`-specific test exists; this confirms nothing else broke).

- [ ] **Step 3: Verify manually**

```bash
npm run dev
```

Visit `/`, resize the browser window and toggle the sidebar collapse button — the chart should fill its card width at any size instead of overflowing or leaving dead space. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/SalesChart.tsx
git commit -m "feat: restyle SalesChart with Card, ToggleGroup and a responsive container"
```

---

### Task 9: Restyle `OrdersTable` (`Table`, `ToggleGroup`, `Card`)

**Files:**
- Modify: `src/components/OrdersTable.tsx`

**Interfaces:**
- Consumes: `Card`, `CardHeader`, `CardTitle`, `CardContent` from `@/components/ui/card`; `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` from `@/components/ui/table`; `ToggleGroup`, `ToggleGroupItem` from `@/components/ui/toggle-group`; `Badge` from `@/components/ui/badge`.
- Produces: unchanged external props (`{ orders: OrderRow[] }`) — markup-only change, existing call site keeps working.

- [ ] **Step 1: Replace the raw table/buttons with styled markup**

Replace the full contents of `src/components/OrdersTable.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { formatCurrencyBRL } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Badge } from '@/components/ui/badge'

interface OrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

type FilterMode = 'all' | 'hideCancelled'

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'Todos',
  hideCancelled: 'Ocultar cancelados',
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'cancelled' ? 'destructive' : status === 'refunded' ? 'outline' : 'default'
  return <Badge variant={variant}>{status}</Badge>
}

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all')

  const displayedOrders = filterMode === 'hideCancelled' ? orders.filter((order) => order.status !== 'cancelled') : orders

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Pedidos</CardTitle>
        <ToggleGroup
          type="single"
          value={filterMode}
          onValueChange={(value) => value && setFilterMode(value as FilterMode)}
          aria-label="Filtrar pedidos"
        >
          {(Object.keys(FILTER_LABELS) as FilterMode[]).map((option) => (
            <ToggleGroupItem key={option} value={option} aria-label={FILTER_LABELS[option]}>
              {FILTER_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Valor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedOrders.map((order) => (
              <TableRow key={order.id}>
                <TableCell>{new Date(order.orderDate).toLocaleDateString('pt-BR')}</TableCell>
                <TableCell>{order.itemsSummary}</TableCell>
                <TableCell>
                  <StatusBadge status={order.status} />
                </TableCell>
                <TableCell className="text-right">{formatCurrencyBRL(order.totalAmount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/OrdersTable.tsx
git commit -m "feat: restyle OrdersTable with Card, Table and ToggleGroup"
```

---

### Task 10: KPI cards, `VendasDashboardClient`, and wiring it all into the page

**Files:**
- Modify: `src/components/SummaryCards.tsx`
- Test: `src/components/SummaryCards.test.tsx`
- Create: `src/components/VendasDashboardClient.tsx`
- Test: `src/components/VendasDashboardClient.test.tsx`
- Modify: `src/app/(dashboard)/page.tsx`

**Interfaces:**
- Consumes: `summarizeRevenue`/`RevenueSummary`/`PeriodComparison` (Task 4), `fetchDashboardOrders`/`DashboardOrderRow` (Task 5), `LiveIndicator` (Task 6), `filterRevenueOrders` (existing), `SalesChart`/`OrdersTable` (Tasks 8–9), `createBrowserSupabaseClient` (existing, `src/lib/supabase/browser.ts`), `createServerSupabaseClient` (existing).
- Produces: `SummaryCards({ summary: RevenueSummary })` (breaking change from the old `{ revenueTotal, orderCount, averageTicket }` — this is why the rewrite and the `page.tsx` wiring happen in the same task, so nothing is left calling the old signature); `VendasDashboardClient({ initialOrders: DashboardOrderRow[] })`.

This is the integration task — it lands the SummaryCards rewrite and the page wiring together so the build is never left in a broken state between the two.

- [ ] **Step 1: Write the failing `SummaryCards` test**

`src/components/SummaryCards.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryCards } from './SummaryCards'
import { formatCurrencyBRL } from '@/lib/format'
import type { RevenueSummary } from '@/lib/sales/aggregate'

const summary: RevenueSummary = {
  total: 5000,
  today: { current: 100, previous: 40, changePct: 150 },
  week: { current: 300, previous: 600, changePct: -50 },
  month: { current: 2000, previous: 0, changePct: null },
}

describe('SummaryCards', () => {
  it('shows the total and each period current value', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText(formatCurrencyBRL(5000))).toBeTruthy()
    expect(screen.getByText(formatCurrencyBRL(100))).toBeTruthy()
    expect(screen.getByText(formatCurrencyBRL(300))).toBeTruthy()
    expect(screen.getByText(formatCurrencyBRL(2000))).toBeTruthy()
  })

  it('shows a positive change badge for Hoje and a negative one for Semana', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText('150.0%')).toBeTruthy()
    expect(screen.getByText('50.0%')).toBeTruthy()
  })

  it('shows "novo" instead of a percentage when the previous period was zero', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText('novo')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- SummaryCards
```

Expected: FAIL — old `SummaryCards` requires `revenueTotal`/`orderCount`/`averageTicket`, not `summary`, so this is a type error / render mismatch.

- [ ] **Step 3: Rewrite `SummaryCards` as four KPI cards**

Replace the full contents of `src/components/SummaryCards.tsx`:

```tsx
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrencyBRL } from '@/lib/format'
import type { PeriodComparison, RevenueSummary } from '@/lib/sales/aggregate'

function ChangeBadge({ changePct }: { changePct: PeriodComparison['changePct'] }) {
  if (changePct === null) {
    return <Badge variant="secondary">novo</Badge>
  }
  const isPositive = changePct >= 0
  return (
    <Badge variant={isPositive ? 'default' : 'destructive'} className="gap-1">
      {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(changePct).toFixed(1)}%
    </Badge>
  )
}

function PeriodCard({ title, comparison }: { title: string; comparison: PeriodComparison }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <ChangeBadge changePct={comparison.changePct} />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{formatCurrencyBRL(comparison.current)}</p>
      </CardContent>
    </Card>
  )
}

export function SummaryCards({ summary }: { summary: RevenueSummary }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Total</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrencyBRL(summary.total)}</p>
        </CardContent>
      </Card>
      <PeriodCard title="Hoje" comparison={summary.today} />
      <PeriodCard title="Semana" comparison={summary.week} />
      <PeriodCard title="Mês" comparison={summary.month} />
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- SummaryCards
```

Expected: PASS, all three cases green.

- [ ] **Step 5: Write the failing `VendasDashboardClient` test**

`src/components/VendasDashboardClient.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { VendasDashboardClient } from './VendasDashboardClient'
import { formatCurrencyBRL } from '@/lib/format'
import * as browserClient from '@/lib/supabase/browser'
import * as fetchOrdersModule from '@/lib/sales/fetchOrders'

describe('VendasDashboardClient', () => {
  let changeHandler: (payload: unknown) => void

  beforeEach(() => {
    changeHandler = () => {}
    const channel = {
      on: vi.fn((_event: string, _filter: unknown, handler: (payload: unknown) => void) => {
        changeHandler = handler
        return channel
      }),
      subscribe: vi.fn((callback?: (status: string) => void) => {
        callback?.('SUBSCRIBED')
        return channel
      }),
    }
    vi.spyOn(browserClient, 'createBrowserSupabaseClient').mockReturnValue({
      channel: vi.fn().mockReturnValue(channel),
      removeChannel: vi.fn(),
    } as never)
  })

  it('renders the initial orders on first paint', () => {
    render(
      <VendasDashboardClient
        initialOrders={[
          { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        ]}
      />
    )

    expect(screen.getByText(formatCurrencyBRL(100))).toBeTruthy()
    expect(screen.getByText(/Ao vivo/)).toBeTruthy()
  })

  it('re-fetches and updates totals when a realtime event fires', async () => {
    vi.spyOn(fetchOrdersModule, 'fetchDashboardOrders').mockResolvedValue({
      rows: [
        { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        { id: '2', status: 'paid', totalAmount: 250, orderDate: '2026-08-04T10:00:00.000Z', itemsSummary: 'Produto B' },
      ],
      error: false,
    })

    render(<VendasDashboardClient initialOrders={[]} />)

    const before = screen.getByTestId('last-updated').textContent

    changeHandler({})

    await waitFor(() => {
      expect(screen.getByText(formatCurrencyBRL(350))).toBeTruthy()
    })
    expect(screen.getByTestId('last-updated').textContent).not.toBe(before)
  })

  it('keeps the last known snapshot when a refetch fails', async () => {
    vi.spyOn(fetchOrdersModule, 'fetchDashboardOrders').mockResolvedValue({ rows: [], error: true })

    render(
      <VendasDashboardClient
        initialOrders={[
          { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        ]}
      />
    )

    changeHandler({})

    await waitFor(() => {
      expect(fetchOrdersModule.fetchDashboardOrders).toHaveBeenCalled()
    })
    expect(screen.getByText(formatCurrencyBRL(100))).toBeTruthy()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npm test -- VendasDashboardClient
```

Expected: FAIL — `Cannot find module './VendasDashboardClient'`.

- [ ] **Step 7: Implement `VendasDashboardClient`**

`src/components/VendasDashboardClient.tsx`:

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'
import { fetchDashboardOrders, type DashboardOrderRow } from '@/lib/sales/fetchOrders'
import { filterRevenueOrders, summarizeRevenue } from '@/lib/sales/aggregate'
import { SummaryCards } from '@/components/SummaryCards'
import { SalesChart } from '@/components/SalesChart'
import { OrdersTable } from '@/components/OrdersTable'
import { LiveIndicator } from '@/components/LiveIndicator'

export function VendasDashboardClient({ initialOrders }: { initialOrders: DashboardOrderRow[] }) {
  const [orders, setOrders] = useState<DashboardOrderRow[]>(initialOrders)
  const [isLive, setIsLive] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const supabase = createBrowserSupabaseClient()

    async function refetch() {
      const result = await fetchDashboardOrders(supabase)
      if (result.error) return
      setOrders(result.rows)
      setLastUpdatedAt(new Date())
    }

    const channel = supabase
      .channel('orders-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, refetch)
      .subscribe((status: string) => setIsLive(status === 'SUBSCRIBED'))

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const revenueRows = useMemo(() => filterRevenueOrders(orders), [orders])
  const summary = useMemo(() => summarizeRevenue(revenueRows), [revenueRows])

  return (
    <div className="flex flex-col gap-4">
      <LiveIndicator isLive={isLive} lastUpdatedAt={lastUpdatedAt} />
      <SummaryCards summary={summary} />
      <SalesChart orders={revenueRows.map((row) => ({ orderDate: row.orderDate, totalAmount: row.totalAmount }))} />
      <OrdersTable orders={orders} />
    </div>
  )
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npm test -- VendasDashboardClient
```

Expected: PASS, all three cases green.

- [ ] **Step 9: Wire it into the page**

Replace the full contents of `src/app/(dashboard)/page.tsx`:

```tsx
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'
import { VendasDashboardClient } from '@/components/VendasDashboardClient'
import { fetchDashboardOrders } from '@/lib/sales/fetchOrders'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()

  // The login gate is deliberately off for now, so an anonymous visitor just
  // hits RLS and gets zero rows — indistinguishable from "no orders yet"
  // unless we say so explicitly. This is not a redirect: the page still
  // renders, it just renders a different (honest) empty state.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Dashboard de Vendas</h1>
        <p className="text-sm text-muted-foreground">Faça login para ver seus dados.</p>
      </main>
    )
  }

  const { rows, error } = await fetchDashboardOrders(supabase)

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard de Vendas</h1>
        <ConnectMercadoLivreButton />
      </div>
      {error ? <p className="text-sm text-destructive">Não foi possível carregar seus pedidos. Tente novamente.</p> : null}
      <VendasDashboardClient initialOrders={rows} />
    </main>
  )
}
```

- [ ] **Step 10: Run the full test suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass, build succeeds.

- [ ] **Step 11: Verify manually**

```bash
npm run dev
```

Log in, visit `/`. Expect: sidebar shell, four KPI cards (Total/Hoje/Semana/Mês) with a green "Ao vivo" dot, the chart, and the orders table, all reading real data from Supabase. Stop the dev server.

- [ ] **Step 12: Commit**

```bash
git add src/components/SummaryCards.tsx src/components/SummaryCards.test.tsx src/components/VendasDashboardClient.tsx src/components/VendasDashboardClient.test.tsx "src/app/(dashboard)/page.tsx"
git commit -m "feat: add live KPI cards and wire VendasDashboardClient into the page"
```

---

### Task 11: Final verification

**Files:** none (no code changes expected; this task only produces evidence the feature works end to end).

**Interfaces:** none.

- [ ] **Step 1: Run the full automated test suite**

```bash
npm test
```

Expected: every test file passes, including the pre-existing Mercado Livre/webhook/sync tests untouched by this plan.

- [ ] **Step 2: Run a production build**

```bash
npm run build
```

Expected: succeeds with Tailwind/shadcn/the new route group all compiled in.

- [ ] **Step 3: Confirm the Realtime migration is applied on the real Supabase project**

If Task 1's migration wasn't already applied there, apply it now (SQL Editor, same as Task 1 Step 2) before the smoke test below — otherwise the live indicator will stay grey/never update, since the tables won't be in the `supabase_realtime` publication yet.

- [ ] **Step 4: Manual realtime smoke test**

```bash
npm run dev
```

Log in and open `/` in the browser. In the Supabase SQL Editor, insert a test row directly into `orders` (and a matching `order_items` row) for the logged-in user's `account_id`/`user_id`, with `status = 'paid'` and today's date. Within a few seconds, without reloading the page, confirm: the "Hoje" KPI card's total increases, the chart's today bar grows, the new row appears in the orders table, and the live indicator's timestamp updates. Delete the test row afterward so it doesn't pollute real revenue figures. Stop the dev server.

- [ ] **Step 5: Confirm the timezone fix took effect**

```bash
docker build -t dashboard-marketplaces-tz-check . && docker run --rm dashboard-marketplaces-tz-check node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"
```

Expected: prints `America/Sao_Paulo`. (Skip this step if Docker isn't available locally — EasyPanel will build the same Dockerfile on deploy, so this is a nice-to-have local confirmation, not a blocker.)

This closes out the "P" (Plano) stage. Per the project's standing workflow, the next stage is "A" (Auditoria): run `/code-review` and a security review over this branch before shipping to `main`.
