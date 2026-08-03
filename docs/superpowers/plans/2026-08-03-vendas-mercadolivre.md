# Vendas — Integração Mercado Livre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working "Vendas" dashboard that connects to one Mercado Livre seller account (read-only) and shows orders + a revenue/order-count chart (day/week/month/year), kept up to date in real time via webhooks with a periodic reconciliation safety net.

**Architecture:** Single Next.js (App Router, TypeScript) application, deployed as one Docker container on EasyPanel at `https://salfhcosmeticos.tech`. Next.js Route Handlers implement the OAuth callback, the connect redirect, and the webhook receiver. Supabase provides Postgres (with RLS) + Auth. A `node-cron` job started via Next.js `instrumentation.ts` runs periodic reconciliation.

**Tech Stack:** Next.js 15 (App Router, TypeScript, standalone output), Supabase (`@supabase/supabase-js`, `@supabase/ssr`), `date-fns`, `recharts`, `node-cron`, Vitest + `@testing-library/react` for tests, Docker.

## Global Constraints

- **Read-only only.** No code in this plan may issue a write request (POST/PUT/PATCH/DELETE) against the Mercado Livre API. Only `GET` requests are implemented against `api.mercadolibre.com`. The Mercado Livre DevCenter app's scopes are all configured as "Leitura" — the code must not attempt anything beyond that.
- **Single user for now.** Only the account owner logs in (Supabase Auth). Data model must not block adding employee access later, but no roles/permissions system is built in this plan (YAGNI).
- **Infra already provisioned — do not recreate:** VPS `2.25.95.146` with EasyPanel; domain `salfhcosmeticos.tech` (DNS + SSL already live); EasyPanel project `dashboard-marketplaces` with a placeholder service `dashboard-salfh` (to be replaced, not duplicated); Mercado Livre DevCenter app already created with Authorization Code + Refresh Token flow, redirect URI `https://salfhcosmeticos.tech/auth/mercadolivre/callback`, PKCE and Client Credentials disabled.
- **Scope:** Mercado Livre only, "Vendas" module only. Shopee/Amazon/TikTok and the other modules (estoque, faturamento, anúncios, financeiro, margem de contribuição) are explicitly out of scope for this plan.
- **12 months of historical backfill** on first connection; real-time updates via Mercado Livre webhooks (topic `orders_v2`); reconciliation every 15 minutes as a safety net.

---

## File Structure

```
dashboard-marketplaces/
├── Dockerfile
├── .dockerignore
├── .env.example
├── next.config.mjs
├── package.json
├── vitest.config.ts
├── supabase/
│   └── migrations/
│       └── 0001_init.sql
└── src/
    ├── instrumentation.ts
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx
    │   ├── login/page.tsx
    │   ├── auth/mercadolivre/callback/route.ts
    │   └── api/
    │       ├── mercadolivre/connect/route.ts
    │       └── webhooks/mercadolivre/route.ts
    ├── components/
    │   ├── ConnectMercadoLivreButton.tsx
    │   ├── SummaryCards.tsx
    │   ├── OrdersTable.tsx
    │   └── SalesChart.tsx
    └── lib/
        ├── format.ts
        ├── auth/session.ts
        ├── supabase/server.ts
        ├── supabase/browser.ts
        ├── mercadolivre/oauth.ts
        ├── mercadolivre/client.ts
        ├── mercadolivre/sync.ts
        ├── mercadolivre/cron.ts
        └── sales/aggregate.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`
- Create: `Dockerfile`, `.dockerignore`, `.env.example`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `src/lib/sanity.test.ts`

**Interfaces:**
- Produces: a runnable Next.js app (`npm run dev`, `npm run build`), a working Vitest setup (`npm test`), and a Docker image that starts on port 3000.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dashboard-marketplaces",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "@supabase/ssr": "^0.5.2",
    "@supabase/supabase-js": "^2.45.4",
    "date-fns": "^3.6.0",
    "next": "^15.0.0",
    "node-cron": "^3.0.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.1",
    "@types/node": "^20.14.0",
    "@types/node-cron": "^3.0.11",
    "@types/react": "^18.3.3",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.5.4",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
}

export default nextConfig
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
```

- [ ] **Step 5: Create `src/lib/sanity.test.ts`**

```ts
import { describe, it, expect } from 'vitest'

describe('project scaffold', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 6: Run `npm install` then `npm test`**

Run: `npm install && npm test`
Expected: PASS (1 test)

- [ ] **Step 7: Create minimal app shell**

`src/app/layout.tsx`:

```tsx
export const metadata = { title: 'Dashboard Marketplaces' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
```

`src/app/page.tsx`:

```tsx
export default function HomePage() {
  return <main>Dashboard Marketplaces</main>
}
```

- [ ] **Step 8: Verify production build**

Run: `npm run build`
Expected: Build succeeds, no type errors.

- [ ] **Step 9: Create `.env.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=https://salfhcosmeticos.tech/auth/mercadolivre/callback
```

- [ ] **Step 10: Create `Dockerfile` and `.dockerignore`**

`Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```

`.dockerignore`:

```
node_modules
.next
.git
docs
```

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json next.config.mjs vitest.config.ts Dockerfile .dockerignore .env.example src/
git commit -m "chore: scaffold Next.js app with Vitest and Docker build"
```

---

### Task 2: Supabase schema and RLS

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: tables `marketplace_accounts`, `orders`, `order_items`, `sync_runs`, all with RLS enabled and a `select`-only policy for the `authenticated` role (all writes happen server-side via the service-role key, which bypasses RLS by design).

**Prerequisite (manual, one-time):** create a Supabase project at supabase.com if one doesn't exist yet for this app, and copy its Project URL, anon key, and service_role key into a local `.env` (copied from `.env.example`) — these are never committed to git.

- [ ] **Step 1: Write the migration SQL**

`supabase/migrations/0001_init.sql`:

```sql
create table public.marketplace_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  marketplace text not null check (marketplace in ('mercado_livre')),
  ml_user_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, marketplace, ml_user_id)
);

create index marketplace_accounts_user_id_idx on public.marketplace_accounts (user_id);

alter table public.marketplace_accounts enable row level security;
alter table public.marketplace_accounts force row level security;

create policy marketplace_accounts_owner_select on public.marketplace_accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.marketplace_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_order_id bigint not null,
  status text not null,
  total_amount numeric(12,2) not null,
  currency_id text not null,
  order_date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, ml_order_id)
);

create index orders_user_id_idx on public.orders (user_id);
create index orders_order_date_idx on public.orders (order_date);

alter table public.orders enable row level security;
alter table public.orders force row level security;

create policy orders_owner_select on public.orders
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_item_id text not null,
  title text not null,
  quantity integer not null,
  unit_price numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (order_id, ml_item_id)
);

create index order_items_user_id_idx on public.order_items (user_id);
create index order_items_order_id_idx on public.order_items (order_id);

alter table public.order_items enable row level security;
alter table public.order_items force row level security;

create policy order_items_owner_select on public.order_items
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.marketplace_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_type text not null check (run_type in ('backfill', 'reconciliation', 'webhook')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  orders_processed integer not null default 0,
  error_count integer not null default 0,
  last_error text
);

create index sync_runs_user_id_idx on public.sync_runs (user_id);

alter table public.sync_runs enable row level security;
alter table public.sync_runs force row level security;

create policy sync_runs_owner_select on public.sync_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);
```

- [ ] **Step 2: Apply the migration**

Run this SQL in the Supabase project's SQL Editor (Dashboard → SQL Editor → paste contents of `0001_init.sql` → Run).
Expected: all four tables created with no errors.

- [ ] **Step 3: Verify RLS is enabled on every table**

Run in the SQL Editor:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public';
```

Expected: `rowsecurity = true` for all four tables.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "feat: add Supabase schema and RLS policies for sales data"
```

---

### Task 3: Supabase clients and authentication

**Files:**
- Create: `src/lib/supabase/server.ts`, `src/lib/supabase/browser.ts`
- Create: `src/lib/auth/session.ts`
- Create: `src/app/login/page.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/lib/auth/session.test.ts`

**Interfaces:**
- Produces: `createServerSupabaseClient(): Promise<SupabaseClient>`, `createServiceClient(): SupabaseClient`, `createBrowserSupabaseClient(): SupabaseClient`, `getRedirectPathForSession(hasSession: boolean, pathname: string): string | null`.

- [ ] **Step 1: Write the failing test for the redirect helper**

`src/lib/auth/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getRedirectPathForSession } from './session'

describe('getRedirectPathForSession', () => {
  it('sends unauthenticated users to /login', () => {
    expect(getRedirectPathForSession(false, '/')).toBe('/login')
  })

  it('does not redirect unauthenticated users already on /login', () => {
    expect(getRedirectPathForSession(false, '/login')).toBeNull()
  })

  it('sends authenticated users away from /login', () => {
    expect(getRedirectPathForSession(true, '/login')).toBe('/')
  })

  it('does not redirect authenticated users elsewhere', () => {
    expect(getRedirectPathForSession(true, '/')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: FAIL — `session.ts` does not exist yet.

- [ ] **Step 3: Implement the helper**

`src/lib/auth/session.ts`:

```ts
export function getRedirectPathForSession(hasSession: boolean, pathname: string): string | null {
  const isLoginPage = pathname === '/login'
  if (!hasSession && !isLoginPage) return '/login'
  if (hasSession && isLoginPage) return '/'
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Create the Supabase clients**

`src/lib/supabase/server.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createServerSupabaseClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )
}

export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
```

`src/lib/supabase/browser.ts`:

```ts
import { createBrowserClient } from '@supabase/ssr'

export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

- [ ] **Step 6: Create the login page**

`src/app/login/page.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signInWithOtp({ email })
    setSent(true)
  }

  if (sent) {
    return <main>Enviamos um link de acesso para {email}. Confira seu e-mail.</main>
  }

  return (
    <main>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">E-mail</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit">Entrar</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 7: Protect the home page**

`src/app/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRedirectPathForSession } from '@/lib/auth/session'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  const redirectPath = getRedirectPathForSession(Boolean(user), '/')
  if (redirectPath) {
    redirect(redirectPath)
  }

  return <main>Dashboard de Vendas</main>
}
```

- [ ] **Step 8: Run full test suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/lib/supabase src/lib/auth src/app/login src/app/page.tsx
git commit -m "feat: add Supabase auth with magic-link login and protected home page"
```

---

### Task 4: Mercado Livre OAuth token exchange

**Files:**
- Create: `src/lib/mercadolivre/oauth.ts`
- Test: `src/lib/mercadolivre/oauth.test.ts`

**Interfaces:**
- Produces: `interface MercadoLivreTokens { accessToken: string; refreshToken: string; expiresAt: string; mlUserId: number }`, `exchangeCodeForToken(code: string): Promise<MercadoLivreTokens>`, `refreshMercadoLivreToken(refreshToken: string): Promise<MercadoLivreTokens>`.

- [ ] **Step 1: Write the failing test**

`src/lib/mercadolivre/oauth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exchangeCodeForToken, refreshMercadoLivreToken } from './oauth'

const originalFetch = global.fetch

beforeEach(() => {
  process.env.ML_CLIENT_ID = 'test-client-id'
  process.env.ML_CLIENT_SECRET = 'test-secret'
  process.env.ML_REDIRECT_URI = 'https://salfhcosmeticos.tech/auth/mercadolivre/callback'
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('exchangeCodeForToken', () => {
  it('converts a ML token response into MercadoLivreTokens', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        expires_in: 21600,
        user_id: 999,
      }),
    }) as unknown as typeof fetch

    const tokens = await exchangeCodeForToken('some-code')

    expect(tokens.accessToken).toBe('access-123')
    expect(tokens.refreshToken).toBe('refresh-123')
    expect(tokens.mlUserId).toBe(999)
    expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('throws when the API responds with an error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch
    await expect(exchangeCodeForToken('bad-code')).rejects.toThrow()
  })
})

describe('refreshMercadoLivreToken', () => {
  it('returns fresh tokens', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-456',
        refresh_token: 'refresh-456',
        expires_in: 21600,
        user_id: 999,
      }),
    }) as unknown as typeof fetch

    const tokens = await refreshMercadoLivreToken('old-refresh-token')
    expect(tokens.accessToken).toBe('access-456')
  })
})
```

Add `import { afterEach } from 'vitest'` to the top import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mercadolivre/oauth.test.ts`
Expected: FAIL — `oauth.ts` does not exist.

- [ ] **Step 3: Implement `oauth.ts`**

`src/lib/mercadolivre/oauth.ts`:

```ts
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token'

export interface MercadoLivreTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string
  mlUserId: number
}

interface MercadoLivreTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user_id: number
}

function toTokens(response: MercadoLivreTokenResponse): MercadoLivreTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    mlUserId: response.user_id,
  }
}

async function requestToken(body: Record<string, string>): Promise<MercadoLivreTokens> {
  const response = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (!response.ok) {
    throw new Error(`Mercado Livre token request failed: ${response.status}`)
  }
  return toTokens(await response.json())
}

export async function exchangeCodeForToken(code: string): Promise<MercadoLivreTokens> {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID!,
    client_secret: process.env.ML_CLIENT_SECRET!,
    code,
    redirect_uri: process.env.ML_REDIRECT_URI!,
  })
}

export async function refreshMercadoLivreToken(refreshToken: string): Promise<MercadoLivreTokens> {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID!,
    client_secret: process.env.ML_CLIENT_SECRET!,
    refresh_token: refreshToken,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mercadolivre/oauth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/oauth.ts src/lib/mercadolivre/oauth.test.ts
git commit -m "feat: implement Mercado Livre OAuth token exchange and refresh"
```

---

### Task 5: Connect and OAuth callback routes

**Files:**
- Create: `src/app/api/mercadolivre/connect/route.ts`
- Create: `src/app/auth/mercadolivre/callback/route.ts`
- Modify: `src/components/ConnectMercadoLivreButton.tsx` (create)
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `exchangeCodeForToken` from Task 4; `createServerSupabaseClient`, `createServiceClient` from Task 3.
- Produces: a working end-to-end connect flow — after this task, clicking "Conectar Mercado Livre" and authorizing on Mercado Livre results in a row in `marketplace_accounts`.

- [ ] **Step 1: Create the connect route**

`src/app/api/mercadolivre/connect/route.ts`:

```ts
import { NextResponse } from 'next/server'

export async function GET() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID!,
    redirect_uri: process.env.ML_REDIRECT_URI!,
  })
  return NextResponse.redirect(`https://auth.mercadolivre.com.br/authorization?${params.toString()}`)
}
```

- [ ] **Step 2: Create the callback route**

`src/app/auth/mercadolivre/callback/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForToken } from '@/lib/mercadolivre/oauth'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/?ml_error=missing_code', request.url))
  }

  const supabaseAuth = await createServerSupabaseClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const tokens = await exchangeCodeForToken(code)
  const supabase = createServiceClient()

  await supabase.from('marketplace_accounts').upsert(
    {
      user_id: user.id,
      marketplace: 'mercado_livre',
      ml_user_id: tokens.mlUserId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
    },
    { onConflict: 'user_id,marketplace,ml_user_id' }
  )

  return NextResponse.redirect(new URL('/?ml_connected=true', request.url))
}
```

- [ ] **Step 3: Create the connect button component**

`src/components/ConnectMercadoLivreButton.tsx`:

```tsx
export function ConnectMercadoLivreButton() {
  return <a href="/api/mercadolivre/connect">Conectar Mercado Livre</a>
}
```

- [ ] **Step 4: Wire the button into the home page**

Modify `src/app/page.tsx` to render `<ConnectMercadoLivreButton />` below the `<main>` heading text (import it from `@/components/ConnectMercadoLivreButton`).

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Manual verification**

Deploy is not live yet (that's Task 12), so this step is deferred — mark it to re-verify manually once Task 12 is complete: log in, click "Conectar Mercado Livre", authorize on Mercado Livre, and confirm a row appears in `marketplace_accounts` in the Supabase table editor.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/mercadolivre/connect src/app/auth/mercadolivre/callback src/components/ConnectMercadoLivreButton.tsx src/app/page.tsx
git commit -m "feat: add Mercado Livre connect flow and OAuth callback"
```

---

### Task 6: Mercado Livre read-only API client

**Files:**
- Create: `src/lib/mercadolivre/client.ts`
- Test: `src/lib/mercadolivre/client.test.ts`

**Interfaces:**
- Consumes: `refreshMercadoLivreToken`, `MercadoLivreTokens` from Task 4.
- Produces: `interface MercadoLivreAccount { id: string; accessToken: string; refreshToken: string; tokenExpiresAt: string }`, `getValidAccessToken(account, onRefresh): Promise<string>`, `interface MercadoLivreOrderItem { mlItemId: string; title: string; quantity: number; unitPrice: number }`, `interface MercadoLivreOrder { id: number; status: string; totalAmount: number; currencyId: string; dateCreated: string; items: MercadoLivreOrderItem[] }`, `getOrder(accessToken, orderId): Promise<MercadoLivreOrder>`, `searchOrders(accessToken, sellerId, fromDate, toDate, offset): Promise<{ orders: MercadoLivreOrder[]; total: number }>`.
- **Only `GET` requests exist in this module — no function that performs a write against the Mercado Livre API may ever be added here.**

- [ ] **Step 1: Write the failing tests**

`src/lib/mercadolivre/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getValidAccessToken, getOrder, searchOrders } from './client'
import * as oauth from './oauth'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('getValidAccessToken', () => {
  it('returns the current token when it is not expiring soon', async () => {
    const account = {
      id: 'acc-1',
      accessToken: 'valid-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    const onRefresh = vi.fn()
    const token = await getValidAccessToken(account, onRefresh)
    expect(token).toBe('valid-token')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes the token when it is expiring soon', async () => {
    const account = {
      id: 'acc-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    }
    vi.spyOn(oauth, 'refreshMercadoLivreToken').mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 21600 * 1000).toISOString(),
      mlUserId: 999,
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const token = await getValidAccessToken(account, onRefresh)
    expect(token).toBe('new-token')
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new-token' }))
  })
})

describe('getOrder', () => {
  it('maps the Mercado Livre order response to MercadoLivreOrder', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        status: 'paid',
        total_amount: 199.9,
        currency_id: 'BRL',
        date_created: '2026-08-01T10:00:00.000-04:00',
        order_items: [
          { item: { id: 'MLB1', title: 'Produto Teste' }, quantity: 2, unit_price: 99.95 },
        ],
      }),
    }) as unknown as typeof fetch

    const order = await getOrder('token-123', 123)
    expect(order).toEqual({
      id: 123,
      status: 'paid',
      totalAmount: 199.9,
      currencyId: 'BRL',
      dateCreated: '2026-08-01T10:00:00.000-04:00',
      items: [{ mlItemId: 'MLB1', title: 'Produto Teste', quantity: 2, unitPrice: 99.95 }],
    })
  })
})

describe('searchOrders', () => {
  it('maps a search response into orders and total', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: 1,
            status: 'paid',
            total_amount: 50,
            currency_id: 'BRL',
            date_created: '2026-08-01T10:00:00.000-04:00',
            order_items: [],
          },
        ],
        paging: { total: 1 },
      }),
    }) as unknown as typeof fetch

    const result = await searchOrders('token-123', 999, '2026-07-01', '2026-08-01', 0)
    expect(result.total).toBe(1)
    expect(result.orders).toHaveLength(1)
    expect(result.orders[0].id).toBe(1)
  })
})

describe('getOrder rate limiting', () => {
  it('retries after an HTTP 429 and eventually succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          status: 'paid',
          total_amount: 100,
          currency_id: 'BRL',
          date_created: '2026-08-01T10:00:00.000-04:00',
          order_items: [],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const orderPromise = getOrder('token-123', 123)
    await vi.advanceTimersByTimeAsync(1000)
    const order = await orderPromise

    expect(order.id).toBe(123)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/mercadolivre/client.test.ts`
Expected: FAIL — `client.ts` does not exist.

- [ ] **Step 3: Implement `client.ts`**

`src/lib/mercadolivre/client.ts`:

```ts
import { refreshMercadoLivreToken, type MercadoLivreTokens } from './oauth'

const ML_API_BASE = 'https://api.mercadolibre.com'

export interface MercadoLivreAccount {
  id: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string
}

const RATE_LIMIT_MAX_RETRIES = 3

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mlGet<T>(path: string, accessToken: string, attempt = 0): Promise<T> {
  const response = await fetch(`${ML_API_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
    await wait(2 ** attempt * 1000)
    return mlGet<T>(path, accessToken, attempt + 1)
  }

  if (!response.ok) {
    throw new Error(`Mercado Livre API error on ${path}: ${response.status}`)
  }
  return response.json()
}

export async function getValidAccessToken(
  account: MercadoLivreAccount,
  onRefresh: (tokens: MercadoLivreTokens) => Promise<void>
): Promise<string> {
  const expiresAt = new Date(account.tokenExpiresAt).getTime()
  const isExpiringSoon = expiresAt - Date.now() < 5 * 60 * 1000
  if (!isExpiringSoon) {
    return account.accessToken
  }
  const tokens = await refreshMercadoLivreToken(account.refreshToken)
  await onRefresh(tokens)
  return tokens.accessToken
}

export interface MercadoLivreOrderItem {
  mlItemId: string
  title: string
  quantity: number
  unitPrice: number
}

export interface MercadoLivreOrder {
  id: number
  status: string
  totalAmount: number
  currencyId: string
  dateCreated: string
  items: MercadoLivreOrderItem[]
}

interface MercadoLivreOrderResponse {
  id: number
  status: string
  total_amount: number
  currency_id: string
  date_created: string
  order_items: { item: { id: string; title: string }; quantity: number; unit_price: number }[]
}

function toOrder(response: MercadoLivreOrderResponse): MercadoLivreOrder {
  return {
    id: response.id,
    status: response.status,
    totalAmount: response.total_amount,
    currencyId: response.currency_id,
    dateCreated: response.date_created,
    items: response.order_items.map((entry) => ({
      mlItemId: entry.item.id,
      title: entry.item.title,
      quantity: entry.quantity,
      unitPrice: entry.unit_price,
    })),
  }
}

export async function getOrder(accessToken: string, orderId: number): Promise<MercadoLivreOrder> {
  return toOrder(await mlGet<MercadoLivreOrderResponse>(`/orders/${orderId}`, accessToken))
}

export interface SearchOrdersResult {
  orders: MercadoLivreOrder[]
  total: number
}

export async function searchOrders(
  accessToken: string,
  sellerId: number,
  fromDate: string,
  toDate: string,
  offset: number
): Promise<SearchOrdersResult> {
  const params = new URLSearchParams({
    seller: String(sellerId),
    'order.date_created.from': fromDate,
    'order.date_created.to': toDate,
    offset: String(offset),
    limit: '50',
  })
  const response = await mlGet<{ results: MercadoLivreOrderResponse[]; paging: { total: number } }>(
    `/orders/search?${params.toString()}`,
    accessToken
  )
  return { orders: response.results.map(toOrder), total: response.paging.total }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/mercadolivre/client.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/client.ts src/lib/mercadolivre/client.test.ts
git commit -m "feat: add read-only Mercado Livre API client for orders"
```

---

### Task 7: Order upsert and sync-run logging

**Files:**
- Create: `src/lib/mercadolivre/sync.ts`
- Test: `src/lib/mercadolivre/sync.test.ts`

**Interfaces:**
- Consumes: `MercadoLivreOrder` from Task 6.
- Produces: `interface StoredMercadoLivreAccount { id: string; userId: string; mlUserId: number; accessToken: string; refreshToken: string; tokenExpiresAt: string }`, `upsertOrder(supabase, accountId: string, userId: string, order: MercadoLivreOrder): Promise<void>` — idempotent by `(account_id, ml_order_id)`.

- [ ] **Step 1: Write the failing test**

`src/lib/mercadolivre/sync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertOrder } from './sync'
import type { MercadoLivreOrder } from './client'

function createFakeSupabase() {
  const orderUpsertCalls: unknown[] = []
  const itemsUpsertCalls: unknown[] = []

  const client = {
    from(table: string) {
      if (table === 'orders') {
        return {
          upsert: (data: unknown, opts: unknown) => {
            orderUpsertCalls.push({ data, opts })
            return { select: () => ({ single: async () => ({ data: { id: 'order-row-1' }, error: null }) }) }
          },
        }
      }
      if (table === 'order_items') {
        return {
          upsert: async (data: unknown, opts: unknown) => {
            itemsUpsertCalls.push({ data, opts })
            return { error: null }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client: client as unknown as SupabaseClient, orderUpsertCalls, itemsUpsertCalls }
}

const sampleOrder: MercadoLivreOrder = {
  id: 555,
  status: 'paid',
  totalAmount: 150,
  currencyId: 'BRL',
  dateCreated: '2026-08-01T10:00:00.000-04:00',
  items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150 }],
}

describe('upsertOrder', () => {
  it('upserts the order row keyed by account_id + ml_order_id', async () => {
    const { client, orderUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'account-1', 'user-1', sampleOrder)
    expect(orderUpsertCalls).toHaveLength(1)
    expect(orderUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'account_id,ml_order_id' },
      data: expect.objectContaining({ account_id: 'account-1', user_id: 'user-1', ml_order_id: 555 }),
    })
  })

  it('upserts order items keyed by order_id + ml_item_id', async () => {
    const { client, itemsUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'account-1', 'user-1', sampleOrder)
    expect(itemsUpsertCalls).toHaveLength(1)
    expect(itemsUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'order_id,ml_item_id' },
      data: [expect.objectContaining({ order_id: 'order-row-1', ml_item_id: 'MLB1' })],
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: FAIL — `sync.ts` does not exist.

- [ ] **Step 3: Implement `upsertOrder` in `sync.ts`**

`src/lib/mercadolivre/sync.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MercadoLivreOrder } from './client'

export interface StoredMercadoLivreAccount {
  id: string
  userId: string
  mlUserId: number
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string
}

export async function upsertOrder(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  order: MercadoLivreOrder
): Promise<void> {
  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .upsert(
      {
        account_id: accountId,
        user_id: userId,
        ml_order_id: order.id,
        status: order.status,
        total_amount: order.totalAmount,
        currency_id: order.currencyId,
        order_date: order.dateCreated,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,ml_order_id' }
    )
    .select('id')
    .single()

  if (orderError) {
    throw new Error(`Falha ao gravar pedido ${order.id}: ${orderError.message}`)
  }

  if (order.items.length === 0) {
    return
  }

  const itemRows = order.items.map((item) => ({
    order_id: orderRow.id,
    user_id: userId,
    ml_item_id: item.mlItemId,
    title: item.title,
    quantity: item.quantity,
    unit_price: item.unitPrice,
  }))

  const { error: itemsError } = await supabase
    .from('order_items')
    .upsert(itemRows, { onConflict: 'order_id,ml_item_id' })

  if (itemsError) {
    throw new Error(`Falha ao gravar itens do pedido ${order.id}: ${itemsError.message}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts
git commit -m "feat: add idempotent order upsert logic"
```

---

### Task 8: Historical backfill (12 months)

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Modify: `src/app/auth/mercadolivre/callback/route.ts`
- Test: `src/lib/mercadolivre/sync.test.ts` (extend)

**Interfaces:**
- Consumes: `searchOrders`, `getValidAccessToken` from Task 6; `upsertOrder` from Task 7.
- Produces: `backfillOrders(supabase, account: StoredMercadoLivreAccount, monthsBack: number): Promise<{ processed: number; errors: number }>`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/mercadolivre/sync.test.ts`:

```ts
import { backfillOrders } from './sync'
import * as client from './client'

describe('backfillOrders', () => {
  it('pages through search results and upserts every order', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 2 })
    searchOrdersMock.mockResolvedValueOnce({ orders: [{ ...sampleOrder, id: 556 }], total: 2 })

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }

    const result = await backfillOrders(supabase, account, 12)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(orderUpsertCalls).toHaveLength(2)
  })
})
```

Also add to `createFakeSupabase`'s `from` switch a case for `'sync_runs'` returning `{ insert: async () => ({ error: null }) }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: FAIL — `backfillOrders` is not exported.

- [ ] **Step 3: Implement `backfillOrders` and the shared sync-run logger**

Add to `src/lib/mercadolivre/sync.ts`:

```ts
import { getValidAccessToken, searchOrders } from './client'

async function recordSyncRun(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  runType: 'backfill' | 'reconciliation' | 'webhook',
  result: { processed: number; errors: number; lastError?: string }
): Promise<void> {
  await supabase.from('sync_runs').insert({
    account_id: accountId,
    user_id: userId,
    run_type: runType,
    finished_at: new Date().toISOString(),
    orders_processed: result.processed,
    error_count: result.errors,
    last_error: result.lastError ?? null,
  })
}

async function persistRefreshedTokens(
  supabase: SupabaseClient,
  accountId: string
) {
  return async (tokens: { accessToken: string; refreshToken: string; expiresAt: string }) => {
    await supabase
      .from('marketplace_accounts')
      .update({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
      })
      .eq('id', accountId)
  }
}

async function syncOrdersInRange(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  fromDate: string,
  toDate: string,
  runType: 'backfill' | 'reconciliation'
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined
  let offset = 0
  let total = Infinity

  const accessToken = await getValidAccessToken(account, await persistRefreshedTokens(supabase, account.id))

  while (offset < total) {
    const page = await searchOrders(accessToken, account.mlUserId, fromDate, toDate, offset)
    total = page.total
    for (const order of page.orders) {
      try {
        await upsertOrder(supabase, account.id, account.userId, order)
        processed += 1
      } catch (error) {
        errors += 1
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (page.orders.length === 0) break
    offset += page.orders.length
  }

  await recordSyncRun(supabase, account.id, account.userId, runType, { processed, errors, lastError })
  return { processed, errors }
}

export async function backfillOrders(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  monthsBack: number
): Promise<{ processed: number; errors: number }> {
  const toDate = new Date().toISOString()
  const fromDate = new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000).toISOString()
  return syncOrdersInRange(supabase, account, fromDate, toDate, 'backfill')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Trigger backfill from the OAuth callback**

Modify `src/app/auth/mercadolivre/callback/route.ts`: after the `upsert` into `marketplace_accounts`, add:

```ts
import { backfillOrders } from '@/lib/mercadolivre/sync'
```

and, after saving the account, before the final redirect:

```ts
  await backfillOrders(
    supabase,
    {
      id: user.id, // placeholder, replaced below
      userId: user.id,
      mlUserId: tokens.mlUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    },
    12
  )
```

Since the account's real database `id` is needed (not `user.id`), change the `upsert` call to `.select('id').single()` and use the returned row's `id` as `StoredMercadoLivreAccount.id`:

```ts
  const { data: accountRow, error: accountError } = await supabase
    .from('marketplace_accounts')
    .upsert(
      {
        user_id: user.id,
        marketplace: 'mercado_livre',
        ml_user_id: tokens.mlUserId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
      },
      { onConflict: 'user_id,marketplace,ml_user_id' }
    )
    .select('id')
    .single()

  if (accountError || !accountRow) {
    return NextResponse.redirect(new URL('/?ml_error=save_failed', request.url))
  }

  await backfillOrders(
    supabase,
    {
      id: accountRow.id,
      userId: user.id,
      mlUserId: tokens.mlUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    },
    12
  )
```

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts src/app/auth/mercadolivre/callback/route.ts
git commit -m "feat: backfill 12 months of orders after connecting Mercado Livre"
```

---

### Task 9: Webhook receiver and periodic reconciliation

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Create: `src/app/api/webhooks/mercadolivre/route.ts`
- Create: `src/lib/mercadolivre/cron.ts`
- Create: `src/instrumentation.ts`
- Test: `src/lib/mercadolivre/sync.test.ts` (extend)

**Interfaces:**
- Consumes: `getOrder`, `getValidAccessToken` from Task 6; `upsertOrder` from Task 7.
- Produces: `handleMercadoLivreWebhook(supabase, payload: { topic: string; resource: string; user_id: number }): Promise<void>`, `reconcileRecentOrders(supabase, account: StoredMercadoLivreAccount, hoursBack: number): Promise<{ processed: number; errors: number }>`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/mercadolivre/sync.test.ts`:

```ts
import { handleMercadoLivreWebhook, reconcileRecentOrders } from './sync'

describe('handleMercadoLivreWebhook', () => {
  it('ignores topics other than orders_v2', async () => {
    const { client: supabase } = createFakeSupabase()
    await expect(
      handleMercadoLivreWebhook(supabase, { topic: 'messages', resource: '/orders/1', user_id: 999 })
    ).resolves.toBeUndefined()
  })

  it('fetches and upserts the order for orders_v2 events', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabaseWithAccount()
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(client, 'getOrder').mockResolvedValue(sampleOrder)

    await handleMercadoLivreWebhook(supabase, {
      topic: 'orders_v2',
      resource: '/orders/555',
      user_id: 999,
    })

    expect(orderUpsertCalls).toHaveLength(1)
  })
})

describe('reconcileRecentOrders', () => {
  it('searches only the recent time window and upserts results', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 1 })

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }

    const result = await reconcileRecentOrders(supabase, account, 2)
    expect(result.processed).toBe(1)
    expect(orderUpsertCalls).toHaveLength(1)
  })
})
```

Add a second fake-builder for the webhook test that also serves a `marketplace_accounts` lookup, right below `createFakeSupabase`:

```ts
function createFakeSupabaseWithAccount() {
  const base = createFakeSupabase()
  const originalFrom = base.client.from.bind(base.client)
  base.client.from = ((table: string) => {
    if (table === 'marketplace_accounts') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'account-1',
                  user_id: 'user-1',
                  ml_user_id: 999,
                  access_token: 'token-abc',
                  refresh_token: 'refresh-abc',
                  token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      }
    }
    return originalFrom(table)
  }) as typeof base.client.from
  return base
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: FAIL — `handleMercadoLivreWebhook` and `reconcileRecentOrders` are not exported.

- [ ] **Step 3: Implement both functions in `sync.ts`**

Add to `src/lib/mercadolivre/sync.ts`:

```ts
import { getOrder } from './client'

export async function reconcileRecentOrders(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  hoursBack: number
): Promise<{ processed: number; errors: number }> {
  const toDate = new Date().toISOString()
  const fromDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()
  return syncOrdersInRange(supabase, account, fromDate, toDate, 'reconciliation')
}

export interface MercadoLivreWebhookPayload {
  topic: string
  resource: string
  user_id: number
}

export async function handleMercadoLivreWebhook(
  supabase: SupabaseClient,
  payload: MercadoLivreWebhookPayload
): Promise<void> {
  if (payload.topic !== 'orders_v2') {
    return
  }

  const orderId = Number(payload.resource.split('/').pop())

  const { data: account, error } = await supabase
    .from('marketplace_accounts')
    .select('*')
    .eq('ml_user_id', payload.user_id)
    .eq('marketplace', 'mercado_livre')
    .maybeSingle()

  if (error || !account) {
    return
  }

  const storedAccount: StoredMercadoLivreAccount = {
    id: account.id,
    userId: account.user_id,
    mlUserId: account.ml_user_id,
    accessToken: account.access_token,
    refreshToken: account.refresh_token,
    tokenExpiresAt: account.token_expires_at,
  }

  const accessToken = await getValidAccessToken(
    storedAccount,
    await persistRefreshedTokens(supabase, storedAccount.id)
  )
  const order = await getOrder(accessToken, orderId)
  await upsertOrder(supabase, storedAccount.id, storedAccount.userId, order)
  await recordSyncRun(supabase, storedAccount.id, storedAccount.userId, 'webhook', { processed: 1, errors: 0 })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/mercadolivre/sync.test.ts`
Expected: PASS (all tests, 6 total in this file)

- [ ] **Step 5: Create the webhook route**

`src/app/api/webhooks/mercadolivre/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { handleMercadoLivreWebhook } from '@/lib/mercadolivre/sync'

export async function POST(request: NextRequest) {
  const payload = await request.json()
  const supabase = createServiceClient()
  await handleMercadoLivreWebhook(supabase, payload)
  return NextResponse.json({ received: true })
}
```

- [ ] **Step 6: Create the reconciliation cron job**

`src/lib/mercadolivre/cron.ts`:

```ts
import cron from 'node-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { reconcileRecentOrders, type StoredMercadoLivreAccount } from './sync'

export function startReconciliationCron() {
  cron.schedule('*/15 * * * *', async () => {
    const supabase = createServiceClient()
    const { data: accounts } = await supabase
      .from('marketplace_accounts')
      .select('*')
      .eq('marketplace', 'mercado_livre')

    for (const row of accounts ?? []) {
      const account: StoredMercadoLivreAccount = {
        id: row.id,
        userId: row.user_id,
        mlUserId: row.ml_user_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
      }
      await reconcileRecentOrders(supabase, account, 2)
    }
  })
}
```

`src/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startReconciliationCron } = await import('@/lib/mercadolivre/cron')
    startReconciliationCron()
  }
}
```

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts src/app/api/webhooks src/lib/mercadolivre/cron.ts src/instrumentation.ts
git commit -m "feat: add Mercado Livre webhook receiver and reconciliation cron"
```

---

### Task 10: Sales aggregation logic

**Files:**
- Create: `src/lib/sales/aggregate.ts`
- Test: `src/lib/sales/aggregate.test.ts`

**Interfaces:**
- Produces: `type SalesGranularity = 'day' | 'week' | 'month' | 'year'`, `interface SalesPoint { period: string; revenue: number; orderCount: number }`, `interface OrderForAggregation { orderDate: string; totalAmount: number }`, `aggregateSales(orders: OrderForAggregation[], granularity: SalesGranularity): SalesPoint[]` (sorted ascending by `period`).

- [ ] **Step 1: Write the failing tests**

`src/lib/sales/aggregate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateSales } from './aggregate'

const orders = [
  { orderDate: '2026-08-01T10:00:00.000Z', totalAmount: 100 },
  { orderDate: '2026-08-01T15:00:00.000Z', totalAmount: 50 },
  { orderDate: '2026-08-02T09:00:00.000Z', totalAmount: 75 },
  { orderDate: '2025-08-05T09:00:00.000Z', totalAmount: 200 },
]

describe('aggregateSales', () => {
  it('groups by day', () => {
    const result = aggregateSales(orders, 'day')
    expect(result).toEqual([
      { period: '2025-08-05', revenue: 200, orderCount: 1 },
      { period: '2026-08-01', revenue: 150, orderCount: 2 },
      { period: '2026-08-02', revenue: 75, orderCount: 1 },
    ])
  })

  it('groups by month', () => {
    const result = aggregateSales(orders, 'month')
    expect(result).toEqual([
      { period: '2025-08', revenue: 200, orderCount: 1 },
      { period: '2026-08', revenue: 225, orderCount: 3 },
    ])
  })

  it('groups by year', () => {
    const result = aggregateSales(orders, 'year')
    expect(result).toEqual([
      { period: '2025', revenue: 200, orderCount: 1 },
      { period: '2026', revenue: 225, orderCount: 3 },
    ])
  })

  it('groups by week', () => {
    const result = aggregateSales(
      [
        { orderDate: '2026-08-03T10:00:00.000Z', totalAmount: 10 },
        { orderDate: '2026-08-04T10:00:00.000Z', totalAmount: 20 },
      ],
      'week'
    )
    expect(result).toHaveLength(1)
    expect(result[0].revenue).toBe(30)
    expect(result[0].orderCount).toBe(2)
  })

  it('returns an empty array for no orders', () => {
    expect(aggregateSales([], 'day')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sales/aggregate.test.ts`
Expected: FAIL — `aggregate.ts` does not exist.

- [ ] **Step 3: Implement `aggregate.ts`**

`src/lib/sales/aggregate.ts`:

```ts
import { format, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns'

export type SalesGranularity = 'day' | 'week' | 'month' | 'year'

export interface SalesPoint {
  period: string
  revenue: number
  orderCount: number
}

export interface OrderForAggregation {
  orderDate: string
  totalAmount: number
}

const PERIOD_FORMATTERS: Record<SalesGranularity, (date: Date) => string> = {
  day: (date) => format(startOfDay(date), 'yyyy-MM-dd'),
  week: (date) => format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  month: (date) => format(startOfMonth(date), 'yyyy-MM'),
  year: (date) => format(startOfYear(date), 'yyyy'),
}

export function aggregateSales(orders: OrderForAggregation[], granularity: SalesGranularity): SalesPoint[] {
  const formatPeriod = PERIOD_FORMATTERS[granularity]
  const buckets = new Map<string, SalesPoint>()

  for (const order of orders) {
    const period = formatPeriod(new Date(order.orderDate))
    const bucket = buckets.get(period) ?? { period, revenue: 0, orderCount: 0 }
    bucket.revenue += order.totalAmount
    bucket.orderCount += 1
    buckets.set(period, bucket)
  }

  return Array.from(buckets.values()).sort((a, b) => a.period.localeCompare(b.period))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sales/aggregate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales/aggregate.ts src/lib/sales/aggregate.test.ts
git commit -m "feat: add sales aggregation by day/week/month/year"
```

---

### Task 11: Dashboard UI (summary, orders table, chart)

**Files:**
- Create: `src/lib/format.ts`
- Create: `src/components/SummaryCards.tsx`
- Create: `src/components/OrdersTable.tsx`
- Create: `src/components/SalesChart.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `aggregateSales`, `SalesPoint`, `SalesGranularity` from Task 10.
- Produces: `formatCurrencyBRL(value: number): string`; `<SummaryCards revenueTotal orderCount averageTicket />`; `<OrdersTable orders={{ id, status, totalAmount, orderDate, itemsSummary }[]} />`; `<SalesChart orders={{ orderDate, totalAmount }[]} />` (client component, owns its own granularity toggle state).

**Note:** Before writing `SalesChart.tsx`, load the `dataviz` skill for chart color/labeling guidance — do not hand-pick chart colors without it.

- [ ] **Step 1: Write the failing test for the currency formatter**

`src/lib/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatCurrencyBRL } from './format'

describe('formatCurrencyBRL', () => {
  it('formats a positive value as BRL', () => {
    expect(formatCurrencyBRL(1234.5)).toBe('R$ 1.234,50')
  })

  it('formats zero', () => {
    expect(formatCurrencyBRL(0)).toBe('R$ 0,00')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL — `format.ts` does not exist.

- [ ] **Step 3: Implement `format.ts`**

`src/lib/format.ts`:

```ts
export function formatCurrencyBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/format.test.ts`
Expected: PASS (2 tests) — if the exact spacing character differs on your machine, run once, read the actual output, and adjust the expected string to match (Node's `Intl` output for the space between `R$` and the number is a non-breaking space, ` `).

- [ ] **Step 5: Implement `SummaryCards.tsx`**

```tsx
import { formatCurrencyBRL } from '@/lib/format'

interface SummaryCardsProps {
  revenueTotal: number
  orderCount: number
  averageTicket: number
}

export function SummaryCards({ revenueTotal, orderCount, averageTicket }: SummaryCardsProps) {
  return (
    <section>
      <div>
        <h3>Faturamento</h3>
        <p>{formatCurrencyBRL(revenueTotal)}</p>
      </div>
      <div>
        <h3>Pedidos</h3>
        <p>{orderCount}</p>
      </div>
      <div>
        <h3>Ticket médio</h3>
        <p>{formatCurrencyBRL(averageTicket)}</p>
      </div>
    </section>
  )
}
```

- [ ] **Step 6: Implement `OrdersTable.tsx`**

```tsx
import { formatCurrencyBRL } from '@/lib/format'

interface OrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Produto</th>
          <th>Status</th>
          <th>Valor</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td>{new Date(order.orderDate).toLocaleDateString('pt-BR')}</td>
            <td>{order.itemsSummary}</td>
            <td>{order.status}</td>
            <td>{formatCurrencyBRL(order.totalAmount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 7: Implement `SalesChart.tsx`**

(Load the `dataviz` skill first, per the note above, and apply its guidance to the color/legend/tooltip choices below.)

```tsx
'use client'

import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, Tooltip, XAxis, YAxis } from 'recharts'
import { aggregateSales, type SalesGranularity } from '@/lib/sales/aggregate'
import { formatCurrencyBRL } from '@/lib/format'

interface SalesChartProps {
  orders: { orderDate: string; totalAmount: number }[]
}

const GRANULARITY_LABELS: Record<SalesGranularity, string> = {
  day: 'Dia',
  week: 'Semana',
  month: 'Mês',
  year: 'Ano',
}

export function SalesChart({ orders }: SalesChartProps) {
  const [granularity, setGranularity] = useState<SalesGranularity>('day')
  const data = useMemo(() => aggregateSales(orders, granularity), [orders, granularity])

  return (
    <section>
      <div role="group" aria-label="Granularidade do gráfico">
        {(Object.keys(GRANULARITY_LABELS) as SalesGranularity[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={granularity === option}
            onClick={() => setGranularity(option)}
          >
            {GRANULARITY_LABELS[option]}
          </button>
        ))}
      </div>
      <ComposedChart width={720} height={360} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="period" />
        <YAxis yAxisId="revenue" tickFormatter={(value) => formatCurrencyBRL(value)} />
        <YAxis yAxisId="orders" orientation="right" allowDecimals={false} />
        <Tooltip formatter={(value: number, name: string) => (name === 'revenue' ? formatCurrencyBRL(value) : value)} />
        <Legend />
        <Bar yAxisId="revenue" dataKey="revenue" name="Faturamento" />
        <Line yAxisId="orders" dataKey="orderCount" name="Pedidos" type="monotone" />
      </ComposedChart>
    </section>
  )
}
```

- [ ] **Step 8: Wire everything into the home page**

Modify `src/app/page.tsx` to query the current user's orders from Supabase (server-side) and render the components:

```tsx
import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRedirectPathForSession } from '@/lib/auth/session'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'
import { SummaryCards } from '@/components/SummaryCards'
import { OrdersTable } from '@/components/OrdersTable'
import { SalesChart } from '@/components/SalesChart'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  const redirectPath = getRedirectPathForSession(Boolean(user), '/')
  if (redirectPath) {
    redirect(redirectPath)
  }

  const { data: orders } = await supabase
    .from('orders')
    .select('id, status, total_amount, order_date, order_items(title)')
    .order('order_date', { ascending: false })

  const rows = (orders ?? []).map((order) => ({
    id: order.id,
    status: order.status,
    totalAmount: order.total_amount,
    orderDate: order.order_date,
    itemsSummary: (order.order_items ?? []).map((item: { title: string }) => item.title).join(', '),
  }))

  const revenueTotal = rows.reduce((sum, row) => sum + row.totalAmount, 0)
  const orderCount = rows.length
  const averageTicket = orderCount > 0 ? revenueTotal / orderCount : 0

  return (
    <main>
      <ConnectMercadoLivreButton />
      <SummaryCards revenueTotal={revenueTotal} orderCount={orderCount} averageTicket={averageTicket} />
      <SalesChart orders={rows.map((row) => ({ orderDate: row.orderDate, totalAmount: row.totalAmount }))} />
      <OrdersTable orders={rows} />
    </main>
  )
}
```

- [ ] **Step 9: Run the full test suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/components src/app/page.tsx
git commit -m "feat: build sales dashboard UI with summary, table and chart"
```

---

### Task 12: Deploy to EasyPanel and end-to-end verification

**Files:** none (infrastructure/deployment task)

**Interfaces:**
- Consumes: everything from Tasks 1–11.
- Produces: the real application live at `https://salfhcosmeticos.tech`, replacing the `dashboard-salfh` placeholder.

- [ ] **Step 1: Push the repository to GitHub**

Create a new (private) GitHub repository, then:

```bash
git remote add origin <URL_DO_SEU_REPOSITORIO>
git push -u origin master
```

- [ ] **Step 2: Point the EasyPanel service at the repository**

In EasyPanel → project `dashboard-marketplaces` → service `dashboard-salfh` → **Fonte**, switch from "Imagem Docker" to **Github**, connect the repository created above, and set the build to use the `Dockerfile` at the repo root.

- [ ] **Step 3: Set environment variables in EasyPanel**

In the service's **Ambiente** tab, add every variable from `.env.example` with real values: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI`.

- [ ] **Step 4: Deploy**

Click **Implantar**. Watch the logs until the Next.js server starts (`Ready on port 3000` or similar).

- [ ] **Step 5: Verify the app is live**

Run: `curl -sS -o /dev/null -w "%{http_code}\n" https://salfhcosmeticos.tech/login`
Expected: `200`

- [ ] **Step 6: Register the webhook notification URL in the Mercado Livre DevCenter**

Now that the endpoint is live, go back to the app's DevCenter page → **Configuração de notificações** → set the callback URL to `https://salfhcosmeticos.tech/api/webhooks/mercadolivre` → enable the **Orders** topic (this was intentionally left disabled earlier, before the endpoint existed).

- [ ] **Step 7: End-to-end manual verification**

1. Log in with your e-mail (magic link).
2. Click "Conectar Mercado Livre", authorize (read-only), confirm redirect back to the dashboard.
3. In Supabase's table editor, confirm a row exists in `marketplace_accounts`, and that `orders`/`order_items` are populating (backfill running/finished).
4. Confirm the chart and orders table render with real data, and the day/week/month/year toggle works.
5. Trigger a real or test order status change on Mercado Livre and confirm it appears in the dashboard without a page reload within a reasonable time.

Only after all five checks pass should this task — and the "Vendas" module — be considered done.

- [ ] **Step 8: Commit any deployment-related fixes**

```bash
git add -A
git commit -m "chore: deployment fixes for EasyPanel"
```
