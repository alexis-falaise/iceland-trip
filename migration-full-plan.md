# Iceland Trip PWA → Next.js 15 — Full Migration Plan

> **Staff Engineer perspective** — March 2026 (rev. 2 — post-architecture review)
> Current codebase: ~21K LOC vanilla JS PWA
> Target: Next.js 15 (App Router) · React 19 · TypeScript 5.8 · TailwindCSS 4 · Supabase · Zustand · Vitest · Playwright
>
> **This revision integrates multi-tenant architecture for the AI-powered itinerary generator target, resolves all blockers and comments raised in the Staff Engineer review, and fully details Phase 2.**

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Assessment](#2-current-state-assessment)
3. [Target Architecture](#3-target-architecture)
4. [Migration Phases — High-Level Overview](#4-migration-phases--high-level-overview)
5. [Phase Details](#5-phase-details)
   - [Phase 0 — Foundation & Tooling](#phase-0--foundation--tooling)
   - [Phase 1 — Domain-Driven Decomposition](#phase-1--domain-driven-decomposition)
   - [Phase 2 — Next.js Scaffolding (Multi-tenant)](#phase-2--nextjs-scaffolding-multi-tenant)
   - [Phase 3 — TypeScript Domain Models](#phase-3--typescript-domain-models)
   - [Phase 4 — State & Storage Layer](#phase-4--state--storage-layer)
   - [Phase 5 — Feature Migration](#phase-5--feature-migration)
   - [Phase 6 — API Routes & AI Generation](#phase-6--api-routes--ai-generation)
   - [Phase 7 — PWA & Performance](#phase-7--pwa--performance)
   - [Phase 8 — Testing](#phase-8--testing)
   - [Phase 9 — Deployment & CI/CD](#phase-9--deployment--cicd)
6. [Phased Task List](#6-phased-task-list)
7. [Risk Register](#7-risk-register)
8. [Decision Log](#8-decision-log)

---

## 1. Executive Summary

The Iceland Trip PWA is a production-ready, local-first travel companion app with solid fundamentals: clean state management, swappable storage adapters, real-time Supabase sync, and automated smoke tests. However, its delivery mechanism — a 13,700-line monolithic HTML file served statically — limits maintainability, testability, collaboration, and feature velocity.

**The migration goal is not a rewrite. It is a structured lift-and-shift** with incremental colouring from vanilla JS into typed React components, preserving every working behaviour and adding framework-grade tooling around it.

Critically, this migration is designed with the **final target product** in mind: an AI-powered itinerary generator platform where each client receives a personalized, fully isolated trip app — shareable with their travel party but invisible to everyone else. Every architectural decision in this document is evaluated against that target.

The existing Iceland trip continues to run on the static app while the migration proceeds. The new app replaces it at DNS cutover (Phase 9).

### Strategic Objectives

| Objective | Outcome |
|-----------|---------|
| Eliminate the 13K-line HTML monolith | Atomic domain-scoped files, co-located styles and tests |
| Framework-grade DX | TypeScript strict, hot reload, component isolation |
| Server-side capability | API Routes for secrets; ISR for itinerary data |
| Type-safe data layer | Zod schemas as single source of truth for state, DB, and API shapes |
| Multi-tenant architecture | One deployment serves all trips; each trip isolated by RLS and trip membership |
| AI-generation readiness | Itinerary data lives in Supabase from day one — AI writes to DB, app reads from DB |
| Scalable feature delivery | Planned features ship as isolated Next.js route segments |
| Seamless deployment | Zero-downtime: old static site stays live until the new app passes all smoke tests |

### Non-Goals

- No OCR / AI receipt parsing in this migration cycle
- No redesign — pixel-faithful migration of existing UI patterns
- No full backend rewrite — Supabase schema is **extended** (not replaced); Next.js API Routes added as a thin proxy
- No `progression` domain scaffolding — out of scope for this cycle (listed as future feature in `development-plan.md`)
- ~~No auth system overhaul~~ **Auth IS redesigned** (D10): anonymous sessions are replaced by Supabase Auth magic link, the prerequisite for per-trip isolation and sharing

---

## 2. Current State Assessment

### Code Inventory

| File / Layer | Lines | Role |
|---|---|---|
| `index.html` | 13,726 | Markup + CSS + all render logic bundled |
| `src/state/app-state.js` | 48 | Reactive store (getState/setState/subscribe) |
| `src/state/actions.js` | 330 | Domain mutations + sanitizers |
| `src/storage/local-storage-adapter.js` | 86 | localStorage wrapper |
| `src/storage/indexeddb-adapter.js` | 110 | IndexedDB for binary blobs |
| `src/storage/supabase-adapter.js` | 114 | Supabase realtime sync |
| `src/features/packing/index.js` | 252 | Only extracted feature |
| `src/gas-supermarket-points.js` | 3,942 | Static POI data (inline JSON) |
| `src/main.js` | 249 | App factory / bootstrap |
| `src/runtime-globals.js` | 977 | esbuild IIFE bundle (auto-generated) |
| Supabase Edge Functions | 343 | Google Maps expander + Umferdin road proxy |

### Strengths to Preserve

- Observer-based state store (maps 1:1 to Zustand)
- Adapter pattern for storage backends (maps 1:1 to repository pattern)
- Sanitization logic in `actions.js` (becomes Zod schemas)
- Schema versioning / `migrateState()` (becomes Zustand migration middleware)
- Smoke test suite (becomes Playwright spec)
- Supabase realtime subscription (kept, wrapped in a React hook)

### Technical Debt to Retire

| Debt | Impact | Resolution |
|---|---|---|
| 13K-line HTML monolith | Cannot diff, test, or review | Split into atomic components |
| No TypeScript | Runtime bugs caught only in smoke tests | TypeScript strict on all new files |
| 3,942-line static POI file | Slow parse at boot, no filtering | `/api/poi` with bbox filter + `Cache-Control` |
| Hard-coded API base URLs in HTML | Secret leakage risk | Moved behind Next.js API Routes |
| Manual DOM rendering | Cannot compose or test in isolation | React components with co-located tests |
| esbuild IIFE bundle | No tree-shaking, no code splitting | Next.js built-in bundler (Turbopack) |
| Anonymous Supabase sessions | Cannot scope data to a trip party | Supabase Auth magic link + trip membership |
| Hardcoded itinerary data in source | Cannot generate trips dynamically | Itinerary data moved to Supabase tables |
| Single-trip schema | Cannot serve multiple clients | `trips` + `trip_members` tables with RLS |

---

## 3. Target Architecture

### Folder Structure (Domain-Driven, Multi-tenant)

```
iceland-trip/
├── app/
│   ├── layout.tsx                       ← Root: SupabaseAuthProvider, ThemeProvider, PWA meta
│   ├── page.tsx                         ← Landing: "Plan your trip" CTA → /trips/new
│   ├── auth/
│   │   ├── callback/route.ts            ← Supabase PKCE code exchange
│   │   └── verify/page.tsx              ← Magic link request form + "check your email"
│   ├── trips/
│   │   ├── new/page.tsx                 ← AI generation form (stub Phase 2, full Phase 6)
│   │   └── [tripId]/
│   │       ├── layout.tsx               ← TripProvider: fetch trip, verify RLS, notFound on fail
│   │       ├── not-found.tsx            ← "Trip not found or access denied"
│   │       └── (tabs)/
│   │           ├── layout.tsx           ← TabBar + ErrorBoundary + Suspense
│   │           ├── home/page.tsx
│   │           ├── itinerary/
│   │           │   ├── page.tsx
│   │           │   └── [day]/page.tsx   ← Day detail, deep-linkable
│   │           └── tools/page.tsx
│   └── api/
│       ├── trips/
│       │   ├── route.ts                 ← POST: AI-generate trip
│       │   └── [tripId]/
│       │       └── members/route.ts     ← POST: invite member (magic link)
│       ├── road-status/route.ts
│       ├── maps-expand/route.ts
│       ├── poi/route.ts
│       └── weather/route.ts
│
├── src/
│   ├── domains/
│   │   ├── trip/                        ← NEW: trip identity and membership
│   │   │   ├── types.ts                 ← Trip, TripMember, TripRole
│   │   │   ├── queries.ts               ← getTrip, listMembers
│   │   │   ├── hooks.ts                 ← useTrip() consumer of TripContext
│   │   │   ├── context.tsx              ← TripContextProvider (server → client boundary)
│   │   │   └── components/
│   │   │       ├── TripHeader.tsx
│   │   │       └── InviteMember.tsx
│   │   ├── itinerary/
│   │   │   ├── types.ts                 ← Day, Stop, DrivingLeg (mapped to DB columns)
│   │   │   ├── queries.ts               ← getDays(tripId), getDay(tripId, dayNum)
│   │   │   ├── hooks.ts                 ← useDayRoute, useItinerarySummary
│   │   │   └── components/
│   │   │       ├── DayCard.tsx
│   │   │       ├── DayModal.tsx
│   │   │       ├── ItineraryMap.tsx
│   │   │       └── DrivingStats.tsx
│   │   ├── packing/
│   │   │   ├── types.ts
│   │   │   ├── schema.ts
│   │   │   ├── hooks.ts
│   │   │   ├── store-slice.ts
│   │   │   └── components/
│   │   ├── budget/
│   │   │   ├── types.ts
│   │   │   ├── schema.ts
│   │   │   ├── hooks.ts
│   │   │   ├── store-slice.ts
│   │   │   └── components/
│   │   ├── conditions/
│   │   │   ├── types.ts
│   │   │   ├── providers/
│   │   │   │   ├── types.ts             ← ConditionsProvider interface
│   │   │   │   └── iceland.ts           ← Iceland-specific implementation
│   │   │   ├── hooks.ts
│   │   │   └── components/
│   │   ├── poi/
│   │   │   ├── types.ts
│   │   │   ├── hooks.ts
│   │   │   └── components/
│   │   └── sync/
│   │       ├── types.ts
│   │       ├── hooks.ts
│   │       ├── store-slice.ts
│   │       └── components/
│   ├── store/
│   │   ├── index.ts                     ← createTripStore(tripId) — one instance per trip
│   │   ├── middleware/
│   │   │   ├── persistence.ts           ← key: `tripState:{tripId}`
│   │   │   └── migration.ts             ← migrateState() + legacy key migration
│   │   └── types.ts                     ← AppState (no activeTab, no progression)
│   ├── storage/
│   │   ├── local-storage.ts
│   │   ├── indexeddb.ts
│   │   └── supabase.ts
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts                ← Browser singleton
│   │   │   ├── server.ts                ← RSC/Server Actions
│   │   │   └── middleware.ts            ← Middleware client
│   │   ├── maps.ts
│   │   ├── fuel.ts
│   │   ├── formatting.ts
│   │   └── rate-limit.ts                ← In-memory token bucket
│   └── components/
│       ├── layout/
│       │   ├── TabBar.tsx
│       │   ├── Header.tsx
│       │   └── PageShell.tsx
│       └── ui/
│           ├── Button.tsx
│           ├── Card.tsx
│           ├── Badge.tsx
│           ├── Spinner.tsx
│           ├── Skeleton.tsx
│           └── ErrorBoundary.tsx
│
├── supabase/
│   ├── migrations/
│   │   ├── 20260301_000001_create_trip_state.sql   ← Existing (kept)
│   │   └── 20260307_000001_multi_tenant_schema.sql ← NEW (applied in Phase 0)
│   ├── seed.sql                                     ← Iceland trip seed (local dev)
│   └── functions/                                   ← Deprecated post-migration
│
├── tests/
│   ├── unit/
│   └── e2e/
│
├── middleware.ts                        ← Auth guard: /trips/* → /auth/verify
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

### Supabase Schema (Multi-tenant)

```sql
-- Core trip identity
create table trips (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid references auth.users(id) not null,
  title          text not null,
  destination    text not null,
  departure_date date not null,
  return_date    date,
  currency       text not null default 'ISK',
  created_at     timestamptz default now()
);

-- Trip membership: the sharing model
create table trip_members (
  trip_id   uuid references trips(id) on delete cascade,
  user_id   uuid references auth.users(id) on delete cascade,
  role      text check (role in ('owner', 'member')) not null default 'member',
  joined_at timestamptz default now(),
  primary key (trip_id, user_id)
);

-- Dynamic itinerary (replaces static data.ts)
create table itinerary_days (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references trips(id) on delete cascade,
  day_number  int not null,
  date        date not null,
  title       text not null,
  description text,
  unique (trip_id, day_number)
);

create table itinerary_stops (
  id         uuid primary key default gen_random_uuid(),
  day_id     uuid references itinerary_days(id) on delete cascade,
  stop_order int not null,
  name       text not null,
  lat        double precision,
  lon        double precision,
  type       text,
  notes      text,
  unique (day_id, stop_order)
);

-- Existing trip_state scoped to trip_id
alter table trip_state add column trip_id uuid references trips(id);

-- RLS: all trip data scoped to membership
alter table trips enable row level security;
alter table trip_members enable row level security;
alter table itinerary_days enable row level security;
alter table itinerary_stops enable row level security;

create policy "trip_member_access" on trips
  for all using (
    id in (select trip_id from trip_members where user_id = auth.uid())
  );

create policy "trip_member_access" on itinerary_days
  for all using (
    trip_id in (select trip_id from trip_members where user_id = auth.uid())
  );

create policy "trip_member_access" on itinerary_stops
  for all using (
    day_id in (
      select id from itinerary_days
      where trip_id in (select trip_id from trip_members where user_id = auth.uid())
    )
  );
```

### Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server Components, ISR, API Routes, Turbopack |
| React | React 19 | Concurrent features, `use()` hook, Server Actions |
| Language | TypeScript 5.8 strict | Type safety, Zod codegen from DB types |
| Styling | TailwindCSS 4 | Zero-runtime, same version as Affluent monorepo |
| State | Zustand 5 | Minimal API, sliced stores, `tripId`-scoped persistence |
| Server state | TanStack Query v5 | Road conditions + weather with stale-while-revalidate |
| Forms | React Hook Form + Zod | Consistent with Affluent stack |
| Maps | react-leaflet 4 | Thin React wrapper over existing Leaflet usage |
| Auth | Supabase Auth (magic link) | Zero-friction, no passwords, enables trip membership |
| Database | Supabase (extended schema) | RLS enforces trip-scoped isolation |
| Testing (unit) | Vitest + Testing Library | Jest-compatible, faster, ESM native |
| Testing (E2E) | Playwright | Port existing smoke tests directly |
| PWA | **Serwist** (`@serwist/next`) | Maintained successor to next-pwa; drop-in API |
| Linting | Biome + ESLint | Fast, consistent with Affluent monorepo |
| CI/CD | GitHub Actions + Vercel | Zero-config Next.js hosting |

---

## 4. Migration Phases — High-Level Overview

```
Phase 0  ──►  Phase 1  ──►  Phase 2       ──►  Phase 3
Foundation    Domain        Next.js             TypeScript
& Tooling     Decomp        Scaffold            Models
(Schema +                   (Auth + RLS +
Auth setup)                 Multi-tenant)
                                  │
                                  ▼
Phase 4  ──►  Phase 5  ──►  Phase 6       ──►  Phase 7
State &       Feature        API Routes         PWA &
Storage       Migration      & AI Gen           Perf
                                  │
                                  ▼
                     Phase 8  ──►  Phase 9
                     Testing       Deploy
```

| Phase | Name | Key Output | Duration |
|---|---|---|---|
| 0 | Foundation & Tooling | Repo, CI, schema migrations, Supabase Auth configured | 2–3 days |
| 1 | Domain-Driven Decomposition | Monolith split into ~40 atomic files | 3–5 days |
| 2 | Next.js Scaffolding (Multi-tenant) | Auth flow, `[tripId]` routing, TripProvider, test infra | 9–12 days |
| 3 | TypeScript Domain Models | Zod schemas, TS types, Supabase generated types | 2–3 days |
| 4 | State & Storage Layer | Zustand scoped to `tripId`, persistence, legacy migration | 3–4 days |
| 5 | Feature Migration | All features ported; DB-driven itinerary | 9–12 days |
| 6 | API Routes & AI Generation | All proxies + AI trip generation endpoint | 3–5 days |
| 7 | PWA & Performance | Serwist Service Worker, offline mode, Web Vitals | 2–3 days |
| 8 | Testing | Unit + E2E coverage, CI gates | 3–4 days |
| 9 | Deployment | Vercel deploy, DNS cutover, decommission static | 1–2 days |
| **Total** | | | **37–53 days** |

---

## 5. Phase Details

---

### Phase 0 — Foundation & Tooling

**Goal**: Empty repo to green CI with all tooling configured, multi-tenant schema migrations applied locally, and Supabase Auth working end-to-end in dev.

**Outputs**
- `package.json` with all deps (including `@supabase/ssr`, `@serwist/next`)
- `tsconfig.json` (strict) with path aliases
- `next.config.ts` (Turbopack, Serwist placeholder, security headers)
- `.env.local` template with all required vars
- GitHub Actions workflow (lint → typecheck → vitest → build → playwright)
- Vercel project linked (preview deploys on every PR)
- `supabase/migrations/20260307_000001_multi_tenant_schema.sql` applied locally
- Supabase Auth magic link configured in local dev (email templates, redirect URLs)

**Key Decisions**
- **Standalone Next.js repo** (not added to Affluent Turborepo). Internal architecture mirrors Affluent patterns, so merging as `apps/trip-companion` is low-cost later (D1).
- Multi-tenant schema applied in Phase 0 — not deferred. The TripProvider in Phase 2 depends on `trips` and `trip_members` existing.
- Old static `index.html` stays deployed and live throughout the migration.

---

### Phase 1 — Domain-Driven Decomposition

**Goal**: Atomize the 13,726-line `index.html` monolith into clean, single-responsibility files before any framework code is written. Output is still vanilla JS — no React yet.

**Decomposition Map**

```
src/
  domains/
    itinerary/
      data/
        trip-data.js        ← TEMPORARY: all hardcoded day/stop data
                               marked "// migrated to itinerary_days/stops in Phase 5"
        stops.js
      render/
        day-card.js
        day-modal.js
        itinerary-map.js
        driving-stats.js
    packing/                ← Already extracted
    budget/
      render/
        expense-list.js
        budget-summary.js
        fx-converter.js
    conditions/
      services/
        road-status.js
        weather.js
      render/
        road-badge.js
        weather-card.js
    poi/
      data/
        gas-stations.js
        supermarkets.js
      render/
        nearby-services.js
    home/
      render/
        countdown.js
        today-overview.js
        daily-limit.js
        flight-info.js
    sync/
      render/
        sync-settings.js
        sync-badge.js
```

**Acceptance Criteria**
- `./scripts/smoke-check.sh` still passes after every extraction step
- No file exceeds 300 lines
- Each file has exactly one exported function or class
- `trip-data.js` is marked `TEMPORARY` with a comment pointing to Phase 5

---

### Phase 2 — Next.js Scaffolding (Multi-tenant)

**Goal**: Build the full application shell — auth flow, trip-scoped routing, membership guard, and tab navigation — without any real feature logic. Every route and component here is designed for multi-tenancy from the start.

This phase is the structural foundation for the AI-generation target. Getting the routing and security model wrong here means pervasive rework in every subsequent phase. Getting it right means Phase 5 features slot in with no routing or auth changes.

> **Testing infrastructure is set up here** (Vitest + Playwright config) so Phase 5 acceptance criteria can reference them. No test specs are written in this phase — those are Phase 8.

---

#### 2.1 — Authentication Flow

Supabase Auth with magic link (email OTP). No passwords. Users receive a link, click it, and are authenticated. This is the minimum viable auth that enables trip ownership, RLS enforcement, and the invite/sharing flow.

**Auth Route Map**

```
/                         ← Landing: "Plan your trip" CTA
/auth/verify              ← Magic link request form + "check your email" state
/auth/callback            ← Supabase PKCE code exchange → redirect to /trips/[id]
/trips/new                ← AI generation form (stub Phase 2, full Phase 6)
/trips/[tripId]/home      ← Authenticated trip app
```

**Middleware (auth guard)**

All `/trips/*` routes are protected. Unauthenticated requests are redirected to `/auth/verify` with the original path preserved as a `next` param so the user lands back after sign-in.

```ts
// middleware.ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) =>
          cookies.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          ),
      },
    }
  )

  // getUser() does a server-side JWT validation — not trusting the cookie alone
  const { data: { user } } = await supabase.auth.getUser()

  if (request.nextUrl.pathname.startsWith('/trips') && !user) {
    const verifyUrl = new URL('/auth/verify', request.url)
    verifyUrl.searchParams.set('next', request.nextUrl.pathname)
    return NextResponse.redirect(verifyUrl)
  }

  return response
}

export const config = {
  matcher: ['/trips/:path*'],
}
```

**Auth Callback (PKCE code exchange)**

```ts
// app/auth/callback/route.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/trips/new'

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (c) =>
            c.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            ),
        },
      }
    )
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  }

  return NextResponse.redirect(new URL('/auth/verify?error=true', request.url))
}
```

**Verify Page (magic link request)**

```ts
// app/auth/verify/page.tsx
'use client'
import { createBrowserClient } from '@supabase/ssr'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'

export default function VerifyPage() {
  const searchParams = useSearchParams()
  const next = searchParams.get('next') ?? '/trips/new'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${next}` },
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  if (sent) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-center text-muted-foreground">
          Check your email — a magic link is on its way.
        </p>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <input
          type="email"
          required
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border px-4 py-2"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-primary-foreground">
          Send magic link
        </button>
      </form>
    </main>
  )
}
```

---

#### 2.2 — Trip Context (TripProvider)

The `[tripId]/layout.tsx` is the **single security boundary** for the entire trip. It fetches the trip and verifies membership in one RLS-protected query. If the trip doesn't exist or the user isn't a member, `notFound()` is called — Supabase RLS returns `null` for data the caller cannot access. No trip data reaches the client before this gate.

```ts
// app/trips/[tripId]/layout.tsx
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { TripContextProvider } from '@/domains/trip/context'
import type { Trip } from '@/domains/trip/types'

interface Props {
  children: React.ReactNode
  params: Promise<{ tripId: string }>
}

export default async function TripLayout({ children, params }: Props) {
  const { tripId } = await params
  const supabase = await createServerClient()

  // RLS enforces membership: if user is not in trip_members, this returns null
  const { data: trip } = await supabase
    .from('trips')
    .select(`
      id, title, destination, departure_date, return_date, currency,
      trip_members!inner ( user_id, role )
    `)
    .eq('id', tripId)
    .single()

  if (!trip) notFound()

  return (
    <TripContextProvider trip={trip as Trip}>
      {children}
    </TripContextProvider>
  )
}
```

```ts
// app/trips/[tripId]/not-found.tsx
export default function TripNotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">Trip not found</h1>
      <p className="text-muted-foreground">
        This trip doesn't exist or you don't have access to it.
      </p>
    </main>
  )
}
```

**TripContext — server-to-client boundary**

```ts
// src/domains/trip/context.tsx
'use client'
import { createContext, useContext } from 'react'
import type { Trip } from './types'

const TripContext = createContext<Trip | null>(null)

export function TripContextProvider({
  trip,
  children,
}: {
  trip: Trip
  children: React.ReactNode
}) {
  return <TripContext.Provider value={trip}>{children}</TripContext.Provider>
}

export function useTrip(): Trip {
  const trip = useContext(TripContext)
  if (!trip) throw new Error('useTrip must be used inside a TripContextProvider')
  return trip
}
```

---

#### 2.3 — Tab Routing (Multi-tenant)

The `(tabs)` route group sits inside `[tripId]/`, not at the root. This is the correct nesting order: trip identity is resolved first (TripProvider), then the tab shell renders. Active tab state is derived entirely from `usePathname()` — there is no Zustand state for tab selection (D11).

```
app/trips/[tripId]/
  layout.tsx               ← TripProvider (auth + membership)
  not-found.tsx
  (tabs)/
    layout.tsx             ← TabBar + ErrorBoundary
    home/page.tsx
    itinerary/
      page.tsx
      [day]/page.tsx
    tools/page.tsx
```

```ts
// app/trips/[tripId]/(tabs)/layout.tsx
import { Suspense } from 'react'
import { TabBar } from '@/components/layout/TabBar'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { PageSkeleton } from '@/components/ui/Skeleton'

export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-dvh">
      <main className="flex-1 overflow-y-auto">
        <ErrorBoundary>
          <Suspense fallback={<PageSkeleton />}>
            {children}
          </Suspense>
        </ErrorBoundary>
      </main>
      <TabBar />
    </div>
  )
}
```

```ts
// src/components/layout/TabBar.tsx
'use client'
import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { Home, Map, Wrench } from 'lucide-react'

const TABS = [
  { label: 'Home',      icon: Home,    segment: 'home'      },
  { label: 'Itinerary', icon: Map,     segment: 'itinerary' },
  { label: 'Tools',     icon: Wrench,  segment: 'tools'     },
] as const

export function TabBar() {
  const pathname = usePathname()
  const { tripId } = useParams<{ tripId: string }>()

  return (
    <nav
      role="tablist"
      aria-label="Main navigation"
      className="flex border-t border-border bg-background safe-area-pb"
    >
      {TABS.map(({ label, icon: Icon, segment }) => {
        const href = `/trips/${tripId}/${segment}`
        const isActive = pathname.startsWith(href)
        return (
          <Link
            key={segment}
            href={href}
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            className={`flex flex-1 flex-col items-center gap-1 py-3 min-h-[44px] text-xs transition-colors
              ${isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
```

---

#### 2.4 — Landing & Trip Creation Stub

```ts
// app/page.tsx
import Link from 'next/link'

export default function LandingPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-bold">Plan your perfect trip</h1>
      <p className="text-muted-foreground text-center max-w-sm">
        AI-powered itinerary generation. Everything you need, in one app.
      </p>
      <Link
        href="/trips/new"
        className="rounded-lg bg-primary px-6 py-3 text-primary-foreground font-medium"
      >
        Start planning
      </Link>
    </main>
  )
}
```

```ts
// app/trips/new/page.tsx — stub; full implementation in Phase 6
export default function NewTripPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Create your itinerary</h1>
      <p className="text-muted-foreground">AI generation — coming in Phase 6.</p>
    </main>
  )
}
```

---

#### 2.5 — API Route Stubs

Both trip management routes are scaffolded with full Zod input validation and 501 responses. This locks the API contract in Phase 2 so Phase 6 implements bodies without changing signatures.

```ts
// app/api/trips/route.ts
import { z } from 'zod'
import { NextResponse } from 'next/server'

export const CreateTripSchema = z.object({
  destination:   z.string().min(1),
  departureDate: z.string().date(),
  returnDate:    z.string().date().optional(),
  travelers:     z.number().int().min(1).max(20),
  budgetISK:     z.number().positive().optional(),
  interests:     z.array(z.string()).optional(),
})

export async function POST(req: Request) {
  const parsed = CreateTripSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  // Phase 6: call AI model, persist to Supabase, return tripId
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 })
}
```

```ts
// app/api/trips/[tripId]/members/route.ts
import { z } from 'zod'
import { NextResponse } from 'next/server'

const InviteMemberSchema = z.object({
  email: z.string().email(),
})

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params
  const parsed = InviteMemberSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  // Phase 6: verify caller is trip owner, send magic link with tripId context
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 })
}
```

---

#### 2.6 — Iceland Trip Seed

The existing Iceland trip is inserted as the first row in `trips` during local dev seeding. Both trip users authenticate with their emails and are added to `trip_members`. The existing `icelandAppStateV1` localStorage state is migrated on first authenticated load (Phase 4).

```sql
-- supabase/seed.sql (local dev only)
insert into trips (id, title, destination, departure_date, return_date, currency)
values (
  '00000000-0000-0000-0000-000000000001',
  'Iceland Road Trip 2026',
  'Iceland',
  '2026-03-15',
  '2026-03-26',
  'ISK'
);
-- trip_members rows are added after both users sign up with their emails
```

---

#### 2.7 — Error Boundaries

Error boundaries are established here, not retrofitted later. The app runs offline over unreliable connections — network errors mid-render are a first-class scenario.

```ts
// src/components/ui/ErrorBoundary.tsx
'use client'
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}
interface State { hasError: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="p-4 text-sm text-muted-foreground">
          Something went wrong. Pull to refresh.
        </div>
      )
    }
    return this.props.children
  }
}
```

All `(tabs)/layout.tsx` children are wrapped in `<ErrorBoundary>` + `<Suspense>` (implemented in 2.3). Per-feature boundaries are added in Phase 5 for conditions and POI widgets, which are the most likely to fail due to network unavailability.

---

**Acceptance Criteria — Phase 2**

- `pnpm dev` starts; navigating to `/trips/[iceland-seed-id]/home` works with an authenticated session
- Navigating to `/trips/any-id/home` **without** auth redirects to `/auth/verify?next=...`
- Navigating to `/trips/unknown-id/home` **while authenticated** renders `not-found.tsx`
- Accessing a valid tripId as a non-member renders `not-found.tsx` (RLS returns null)
- Tab navigation changes URL; active tab is highlighted; zero Zustand involvement
- `useTrip()` resolves trip data in all client components inside `[tripId]`
- Dark mode toggles correctly across all routes
- `POST /api/trips` returns 400 on invalid input, 501 on valid input
- `pnpm build` completes with zero TypeScript errors
- `pnpm test` runs (0 tests, no failures — infrastructure verified)
- `pnpm test:e2e` runs (auth.spec.ts passes: magic link → callback → trip redirect)

---

### Phase 3 — TypeScript Domain Models

**Goal**: Define every data shape once as a Zod schema. TypeScript types and runtime validators are derived from this single source.

**Schema Catalog**

```ts
// src/domains/trip/types.ts
const TripSchema = z.object({
  id:            z.string().uuid(),
  title:         z.string().min(1),
  destination:   z.string().min(1),
  departureDate: z.string().date(),
  returnDate:    z.string().date().optional(),
  currency:      z.string().length(3),
})
type Trip = z.infer<typeof TripSchema>

// src/domains/packing/schema.ts
const PackItemSchema = z.object({
  id:   z.number().int().positive(),
  text: z.string().min(1).max(100),
  done: z.boolean(),
})
type PackItem = z.infer<typeof PackItemSchema>

// src/domains/budget/schema.ts
const ExpenseSchema = z.object({
  id:         z.number().int().positive(),
  name:       z.string().min(1).max(200),
  amountISK:  z.number().int().nonnegative(),
  createdAt:  z.number().int().positive(),
  category:   z.string().optional(),
  note:       z.string().max(500).optional(),
  receiptUrl: z.string().url().optional(),
})

// src/store/types.ts
// schemaVersion uses z.number() — migration runs BEFORE schema validation
const AppStateSchema = z.object({
  schemaVersion:     z.number().int().nonnegative(),
  packItems:         z.array(PackItemSchema),
  budget:            BudgetStateSchema,
  disabledLocations: z.record(z.boolean()),
  syncSettings:      SyncSettingsSchema,
  moduleCollapse:    ModuleCollapseSchema,
  todayOverview:     TodayOverviewSchema,
  // progression is out of scope for this migration cycle
})
```

> **`schemaVersion` typing**: `z.literal(1)` would reject v2 state before migration runs. `z.number().int().nonnegative()` accepts any version; the migration function normalises it to the current version before the rest of the schema is validated.

**Supabase Type Generation**

```bash
pnpm supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

**Acceptance Criteria**
- All domain schemas defined with Zod
- `schemaVersion` typed as `z.number().int().nonnegative()` throughout — no `z.literal(n)` on version fields
- `database.types.ts` committed; includes `trips`, `trip_members`, `itinerary_days`, `itinerary_stops`
- Zero `any` types in domain files
- `pnpm check-types` passes

---

### Phase 4 — State & Storage Layer

**Goal**: Port the existing state store + storage adapters to TypeScript with Zustand, scoped to `tripId`, preserving all existing behaviour.

**Zustand Store Design (tripId-scoped)**

The store is instantiated per `tripId`. The localStorage key includes the `tripId` so multiple trips don't collide. `activeTab` is **not** in the store — the URL is the single source of truth (D11).

```ts
// src/store/index.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

// Called once per trip — instantiated inside TripStoreProvider
export function createTripStore(tripId: string) {
  return create<AppState>()(
    persist(
      immer((set, get) => ({
        ...packingSlice(set, get),
        ...budgetSlice(set, get),
        ...syncSlice(set, get),
        ...uiSlice(set, get),   // moduleCollapse only — no activeTab
      })),
      {
        name: `tripState:${tripId}`,   // scoped key: no collision between trips
        storage: createJSONStorage(() => localStorage),
        version: 1,
        migrate: migrateState,         // runs before schema validation
      }
    )
  )
}
```

> **Legacy key migration**: On first load for existing Iceland trip users, `icelandAppStateV1` is read, validated with Zod, and written to `tripState:{iceland-seed-id}`. The old key is deleted only after successful write. This one-time migration runs in `TripStoreProvider.useEffect` before any feature component accesses the store.

**Slices Map**

| Slice | Actions |
|---|---|
| `packingSlice` | addPackItem, togglePackItem, removePackItem, updatePackItemText |
| `budgetSlice` | addExpense, updateExpense, removeExpense, setBudgetMaxISK |
| `syncSlice` | setSyncSettings, triggerSync |
| `uiSlice` | setModuleCollapsed — **activeTab removed** |

**Supabase Realtime Hook (tripId-scoped)**

```ts
// src/domains/sync/hooks.ts
export function useRealtimeSync(tripId: string | null) {
  const store = useTripStore()

  useEffect(() => {
    if (!tripId) return  // no-op until tripId is resolved

    const channel = supabase
      .channel(`trip:${tripId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          table: 'trip_state',
          filter: `trip_id=eq.${tripId}`,
        },
        (payload) => store.mergeRemoteState(payload.new.payload)
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [tripId])
}
```

**Acceptance Criteria**
- `tripState:{tripId}` key read correctly — no data loss on first load
- One-time migration: `icelandAppStateV1` → `tripState:{iceland-seed-id}` — old key deleted after write
- All actions produce identical state mutations as the vanilla JS version
- Realtime sync works between two authenticated browser tabs on the same `tripId`
- Schema migration v0 → v1 covered by Vitest
- **No `activeTab` anywhere in the store**

---

### Phase 5 — Feature Migration

**Goal**: Port every rendered UI block from the monolith to a typed React component. Itinerary data is read from Supabase, not from `data.ts`.

#### 5.1 — Tab Layout & Navigation
`TabBar.tsx`, `PageShell.tsx`, `Header.tsx` — all implemented in Phase 2.

#### 5.2 — Home: Countdown & Flight Info
`departure_date` is read from `useTrip()`, not hardcoded.

```ts
// src/domains/home/components/CountdownBanner.tsx
'use client'
import { useTrip } from '@/domains/trip/hooks'

export function CountdownBanner() {
  const { departureDate } = useTrip()
  const days = Math.ceil(
    (new Date(departureDate).getTime() - Date.now()) / 86_400_000
  )
  // render countdown
}
```

#### 5.3 — Packing List
Client component. `PackingList.tsx`, `PackItem.tsx`, `PackProgress.tsx`. Reads/writes from `useTripStore()` packing slice.

#### 5.4 — Budget Tracker
`BudgetTracker.tsx`, `ExpenseList.tsx`, `ExpenseForm.tsx` (React Hook Form + Zod), `FxConverter.tsx` (TanStack Query → ECB), `DailyPaceGauge.tsx`.

#### 5.5 — Road Conditions & Weather
`useRoadStatus()` and `useWeather()` hooks via TanStack Query. Stale times: 15min for road, 30min for weather. Per-feature `<ErrorBoundary>` wraps both components — these are the most failure-prone features offline.

#### 5.6 — Itinerary Map & Day Cards (DB-driven)

**This is the critical change from the original plan.** `data.ts` is deleted at the start of this step.

```ts
// src/domains/itinerary/queries.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export async function getDays(supabase: SupabaseClient, tripId: string) {
  const { data, error } = await supabase
    .from('itinerary_days')
    .select(`
      id, day_number, date, title, description,
      itinerary_stops ( id, stop_order, name, lat, lon, type, notes )
    `)
    .eq('trip_id', tripId)
    .order('day_number')
  if (error) throw error
  return data
}

export async function getDay(
  supabase: SupabaseClient,
  tripId: string,
  dayNumber: number
) {
  const { data, error } = await supabase
    .from('itinerary_days')
    .select(`
      id, day_number, date, title, description,
      itinerary_stops ( id, stop_order, name, lat, lon, type, notes )
    `)
    .eq('trip_id', tripId)
    .eq('day_number', dayNumber)
    .single()
  if (error) throw error
  return data
}
```

```ts
// app/trips/[tripId]/(tabs)/itinerary/page.tsx
import { createServerClient } from '@/lib/supabase/server'
import { getDays } from '@/domains/itinerary/queries'
import { DayCard } from '@/domains/itinerary/components/DayCard'

export default async function ItineraryPage({
  params,
}: {
  params: Promise<{ tripId: string }>
}) {
  const { tripId } = await params
  const supabase = await createServerClient()
  const days = await getDays(supabase, tripId)

  return (
    <div className="space-y-4 p-4">
      {days.map((day) => (
        <DayCard key={day.id} day={day} tripId={tripId} />
      ))}
    </div>
  )
}
```

`ItineraryMap.tsx` is loaded with `dynamic(() => import(...), { ssr: false })` — Leaflet requires `window`.

**Milestone**: `src/domains/itinerary/data/trip-data.js` is **deleted** once all itinerary renders are confirmed to pull from Supabase.

#### 5.7 — Day Modal (DB-driven)
`[day]/page.tsx` fetches the day's stops via `getDay(supabase, tripId, dayNum)`. Deep-linkable: `/trips/[tripId]/itinerary/3` opens Day 3. Back navigation via `router.back()`.

#### 5.8 — Nearby POI
`useNearbyPoi()` with geolocation + distance sort. POI data from `/api/poi` (bbox-filtered, cached). Per-feature `<ErrorBoundary>`.

#### 5.9 — Sync / Members
`SyncSettings.tsx` shows trip members list + email invite form → `POST /api/trips/[tripId]/members`. `SyncStatusBadge.tsx`. `useRealtimeSync(tripId)` wired in `TripStoreProvider`.

**Acceptance Criteria (per feature)**
- Visual parity with existing HTML implementation
- All interactive states work (loading, error, empty)
- Mobile touch targets ≥ 44px
- Itinerary renders from Supabase — `data.ts` deleted
- Countdown reads `departureDate` from TripContext — `DEPARTURE_DATE` env var removed

---

### Phase 6 — API Routes & AI Generation

**Goal**: Move all external API calls behind Next.js API Routes; implement the AI trip generation endpoint.

**Routes**

```
app/api/
  trips/
    route.ts                ← POST: AI-generate trip (full implementation)
    [tripId]/
      members/route.ts      ← POST: send magic link invite to new member
  road-status/route.ts      ← Proxy → Umferdin GraphQL, edge runtime, 15min cache
  maps-expand/route.ts      ← Google Maps short URL expander
  poi/route.ts              ← Structured POI, bbox filter, Cache-Control: max-age=604800
  weather/route.ts          ← Proxy → Vedur.is with cache headers
```

**AI Generation Endpoint**

```ts
// app/api/trips/route.ts (Phase 6 — full implementation)
import { CreateTripSchema } from './schema'  // defined in Phase 2 stub
import { generateItinerary } from '@/lib/ai/generate'
import { persistTrip } from '@/lib/supabase/trips'

export const runtime = 'edge'

export async function POST(req: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = CreateTripSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // 1. Generate structured itinerary via AI
  const itinerary = await generateItinerary(parsed.data)  // Zod-validated output

  // 2. Persist: trips + trip_members + itinerary_days + itinerary_stops
  const tripId = await persistTrip(user.id, parsed.data, itinerary)

  // 3. Return tripId — client redirects to /trips/[tripId]/home
  return NextResponse.json({ tripId }, { status: 201 })
}
```

**POI API Route — cache configuration**

```ts
// app/api/poi/route.ts
export const runtime = 'edge'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const bbox = searchParams.get('bbox')
  const data = filterPoi(POI_DATA, bbox)
  return NextResponse.json(data, {
    headers: {
      // 7-day cache: POI data is static for the lifetime of any single trip
      'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
    },
  })
}
```

**Rate Limiting (in-memory)**

```ts
// src/lib/rate-limit.ts
const store = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now()
  const record = store.get(key)
  if (!record || now > record.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (record.count >= limit) return false
  record.count++
  return true
}
```

> In-memory is sufficient for the current user count (D13). Applied to `/api/road-status` and `/api/weather` to protect third-party API quotas.

**Conditions Provider Interface**

```ts
// src/domains/conditions/providers/types.ts
export interface ConditionsProvider {
  getRoadStatus(params: { region?: string }): Promise<RoadStatus[]>
  getWeather(params: { lat: number; lon: number }): Promise<WeatherForecast>
}

// Route factory — trip destination selects the provider
export function getConditionsProvider(destination: string): ConditionsProvider {
  if (destination.toLowerCase().includes('iceland')) return icelandProvider
  return genericProvider  // fallback: OpenWeatherMap + generic road alerts
}
```

**Supabase Edge Functions**: The existing `google-maps-expand-link` and `umferdin-road-status` Edge Functions are replaced by Next.js API Routes. Kept as fallback during transition, decommissioned at Week +1.

**Acceptance Criteria**
- No API key visible in browser network tab
- `POST /api/trips` with valid body: creates trip in Supabase, returns `{ tripId }`
- `POST /api/trips/[tripId]/members`: sends magic link invite (verified via Inbucket in dev)
- `/api/poi` response includes `Cache-Control: public, max-age=604800`
- Rate limit: > 10 requests/minute to road-status returns 429
- All routes return 401 for unauthenticated requests

---

### Phase 7 — PWA & Performance

**Goal**: Restore PWA capabilities and achieve Core Web Vitals green across all pages.

**PWA Setup (Serwist — replaces unmaintained next-pwa)**

```ts
// next.config.ts
import withSerwist from '@serwist/next'

export default withSerwist({
  swSrc: 'src/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
})(nextConfig)
```

```ts
// src/sw.ts
import { defaultCache } from '@serwist/next/worker'
import { installSerwist } from '@serwist/sw'

installSerwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: defaultCache,
})
```

**Offline Strategy**

| Resource | Strategy | TTL |
|---|---|---|
| App shell (HTML, JS, CSS) | Cache-first | Build hash |
| Itinerary data | StaleWhileRevalidate | 24h |
| Road status | NetworkFirst | 15min |
| POI data | CacheFirst | 7 days |
| Map tiles (Leaflet) | CacheFirst | 30 days |

**Performance Targets**

| Metric | Target | Method |
|---|---|---|
| LCP | < 2.5s | Server Components for initial content |
| INP | < 200ms | Zustand selector memoization |
| CLS | < 0.1 | Skeleton loaders for async data |
| TTI | < 3.5s | Dynamic imports for Leaflet |
| Bundle size | < 150KB gzipped | Leaflet only on itinerary route |

**Acceptance Criteria**
- Lighthouse PWA score ≥ 90
- App works offline for itinerary + packing + budget
- Install prompt appears on mobile after 30s engagement
- Web Vitals all green in Vercel Analytics

---

### Phase 8 — Testing

**Goal**: Comprehensive test coverage for deployment confidence.

> Vitest and Playwright are already configured (Phase 2). This phase writes all specs.

**Unit Tests (Vitest)**

```
tests/unit/
  store/
    packing-slice.test.ts
    budget-slice.test.ts
    migration.test.ts         ← migrateState v0→v1 + icelandAppStateV1 → tripState:{id}
  schemas/
    packing.schema.test.ts
    budget.schema.test.ts
    trip.schema.test.ts
  lib/
    fuel.test.ts
    formatting.test.ts
    rate-limit.test.ts
```

**E2E Tests (Playwright)**

```
tests/e2e/
  auth.spec.ts              ← Magic link flow, redirect to /trips/new (from Phase 2)
  trip-access.spec.ts       ← Auth guard, 404 on unknown tripId, member vs non-member
  navigation.spec.ts        ← Tab switching, URL updates
  packing.spec.ts
  budget.spec.ts
  itinerary.spec.ts         ← Day cards, modal open, back nav
  sync.spec.ts              ← Realtime between two authenticated tabs
  offline.spec.ts           ← Network disabled via CDP
  pwa.spec.ts               ← Service worker registers, manifest valid
```

**Coverage Targets**

| Layer | Target |
|---|---|
| Store slices | 90% |
| Zod schemas | 100% |
| Utility functions | 85% |
| API Routes | 80% (mocked) |
| E2E critical paths | 100% of smoke tests ported |

**Acceptance Criteria**
- `pnpm test` exits 0 in CI
- No flaky E2E tests (3 consecutive green runs)
- Playwright report uploaded as CI artifact

---

### Phase 9 — Deployment & CI/CD

**Goal**: Zero-downtime cutover from static hosting to Vercel Next.js.

**Deployment Strategy**

```
Week -2  Static site stays live (old URL)
Week -1  Next.js app deployed to staging.iceland-trip.vercel.app
         Full Playwright suite runs against staging
Week 0   DNS cutover: iceland-trip.vercel.app → production
         Old static site kept for 1 week as rollback
Week +1  Old static site decommissioned
         Supabase Edge Functions decommissioned
```

**GitHub Actions CI Pipeline**

```yaml
on: [push, pull_request]

jobs:
  quality:
    steps:
      - biome check
      - tsc --noEmit
      - vitest run --coverage

  build:
    needs: quality
    steps:
      - pnpm build
      - Upload build artifact

  e2e:
    needs: build
    steps:
      - Start Next.js app
      - playwright test
      - Upload report

  deploy:
    needs: e2e
    if: branch == 'main'
    steps:
      - vercel deploy --prod
```

**Environment Variables**

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # Server-side only (AI generation + member invites)
GOOGLE_MAPS_API_KEY=            # Server-side only
UMFERDIN_API_URL=               # Server-side only
VEDUR_API_BASE_URL=             # Server-side only
ANTHROPIC_API_KEY=              # Server-side only (AI generation — Phase 6)
# DEPARTURE_DATE removed — stored in trips table, read from TripContext
```

**Rollback Plan**
- Vercel instant rollback to previous deployment (1-click)
- DNS TTL set to 60s for cutover day
- Old static site kept warm for 7 days post-cutover

**AGENTS.md — Updated commands (defined now, not ad-hoc at Phase 9)**

```md
## Mandatory pre-delivery checks

For every code change:
1. `pnpm check-types`
2. `pnpm lint`
3. `pnpm test` (Vitest unit tests)
4. `pnpm build`

For changes touching Supabase schema:
5. `supabase db reset && supabase start`
6. `pnpm update-types`  ← regenerates src/lib/supabase/database.types.ts

For E2E changes:
7. `pnpm test:e2e`  ← requires `pnpm dev` running in a separate terminal

## Reporting format
1. Whether all commands passed.
2. If a check failed: exact failure output and what was changed to fix it.
```

---

## 6. Phased Task List

> **Legend**
> `J` = Junior developer task (well-defined, isolated)
> `S` = Senior developer task (requires architectural judgment)
> `AI` = Well-suited for AI-assisted generation (repetitive/structured)
> Estimate = ideal working days for a focused developer

---

### Phase 0 — Foundation & Tooling

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P0-01 | Initialize Next.js 15 with `create-next-app@latest` (TypeScript, TailwindCSS 4, App Router, Turbopack) | J | 0.5d | |
| P0-02 | Configure `tsconfig.json` strict + path aliases (`@/domains/*`, `@/lib/*`, `@/store/*`) | J | 0.5d | |
| P0-03 | Configure `next.config.ts`: security headers, Serwist placeholder, env var validation | S | 0.5d | Use Serwist — not next-pwa |
| P0-04 | Set up Biome + ESLint (align with Affluent monorepo config) | J | 0.5d | |
| P0-05 | Create `.env.local.example` with all required vars documented | J | 0.25d | Include `ANTHROPIC_API_KEY` |
| P0-06 | Wire Vercel project, enable preview deploys on every PR | S | 0.5d | |
| P0-07 | Create GitHub Actions CI pipeline (lint → typecheck → vitest → build → playwright) | S | 1d | |
| P0-08 | Copy `supabase/` directory, verify `supabase start` works | J | 0.5d | |
| P0-09 | Write and apply `20260307_000001_multi_tenant_schema.sql` (trips, trip_members, itinerary_days, itinerary_stops + RLS) | S | 1d | Must exist before Phase 2 |
| P0-10 | Configure Supabase Auth magic link in local dev (email templates, redirect URLs) | S | 0.5d | Test via Inbucket at :54324 |
| P0-11 | Write project README with setup instructions | J | 0.5d | |

**Phase 0 Total**: ~6.25 days

---

### Phase 1 — Domain-Driven Decomposition

> Operates on the **existing vanilla JS codebase**. Each step must pass `./scripts/smoke-check.sh`.

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P1-01 | Extract itinerary data into `src/domains/itinerary/data/trip-data.js` — mark TEMPORARY | J | 0.5d | Comment references Phase 5 |
| P1-02 | Extract `renderDayCard()` into `src/domains/itinerary/render/day-card.js` | J | 0.5d | Smoke test after |
| P1-03 | Extract `renderDayModal()` into `src/domains/itinerary/render/day-modal.js` | J | 0.5d | Smoke test after |
| P1-04 | Extract Leaflet map init into `src/domains/itinerary/render/itinerary-map.js` | S | 1d | Leaflet globals, event wiring |
| P1-05 | Extract driving stats into `src/domains/itinerary/render/driving-stats.js` | J | 0.25d | Smoke test after |
| P1-06 | Extract budget render functions (3 files: expense-list, budget-summary, fx-converter) | J | 0.5d | |
| P1-07 | Extract road status service into `src/domains/conditions/services/road-status.js` | J | 0.5d | |
| P1-08 | Extract weather service into `src/domains/conditions/services/weather.js` | J | 0.25d | |
| P1-09 | Extract road badge + weather card into `src/domains/conditions/render/` | J | 0.5d | Smoke test after |
| P1-10 | Split `gas-supermarket-points.js` into `poi/data/gas-stations.js` + `supermarkets.js` | AI | 0.5d | Mechanical JSON split |
| P1-11 | Extract nearby services render into `src/domains/poi/render/nearby-services.js` | J | 0.25d | |
| P1-12 | Extract home tab renders (4 files: countdown, today-overview, daily-limit, flight-info) | J | 0.5d | |
| P1-13 | Extract sync settings render + badge into `src/domains/sync/render/` | J | 0.25d | |
| P1-14 | Final smoke check pass — all 3 tabs, all flows | S | 0.5d | |
| P1-15 | Update `AGENTS.md` with commands defined in the Phase 9 section | J | 0.25d | Replaces smoke-check.sh references |

**Phase 1 Total**: ~6.25 days

---

### Phase 2 — Next.js Scaffolding (Multi-tenant)

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| **2.1 — Auth Flow** | | | | |
| P2-01 | Implement `middleware.ts`: guard `/trips/*`, redirect unauthenticated → `/auth/verify?next=` | S | 0.5d | `@supabase/ssr` createServerClient |
| P2-02 | Implement `app/auth/callback/route.ts`: PKCE code exchange, redirect to `next` param | S | 0.5d | |
| P2-03 | Implement `app/auth/verify/page.tsx`: email input, `signInWithOtp`, sent/error states | J | 0.5d | |
| P2-04 | Create `src/lib/supabase/client.ts` (browser), `server.ts` (RSC), `middleware.ts` (middleware) | S | 0.5d | Three distinct client types |
| **2.2 — Trip Context** | | | | |
| P2-05 | Implement `app/trips/[tripId]/layout.tsx`: fetch trip with `trip_members!inner`, `notFound()` on RLS null | S | 1d | Core security boundary |
| P2-06 | Implement `src/domains/trip/context.tsx`: TripContextProvider + `useTrip()` hook | J | 0.5d | |
| P2-07 | Implement `src/domains/trip/types.ts`: Trip, TripMember, TripRole Zod schemas | J | 0.25d | |
| P2-08 | Create `app/trips/[tripId]/not-found.tsx` | J | 0.25d | |
| **2.3 — Tab Routing** | | | | |
| P2-09 | Create `app/trips/[tripId]/(tabs)/layout.tsx`: TabBar + ErrorBoundary + Suspense + PageSkeleton | S | 0.5d | |
| P2-10 | Implement `TabBar.tsx`: lucide icons, `usePathname()` + `useParams()` active state, aria, 44px targets | J | 0.5d | No Zustand — URL is state |
| P2-11 | Create stub pages: `home/page.tsx`, `itinerary/page.tsx`, `tools/page.tsx` | J | 0.25d | Placeholder content |
| P2-12 | Create `itinerary/[day]/page.tsx` stub with `router.back()` | J | 0.25d | |
| **2.4 — Landing & Stubs** | | | | |
| P2-13 | Create root `app/layout.tsx`: SupabaseAuthProvider, `next-themes` ThemeProvider, PWA manifest link | S | 0.5d | |
| P2-14 | Create `app/page.tsx`: landing with "Start planning" CTA | J | 0.25d | |
| P2-15 | Create `app/trips/new/page.tsx`: stub page | J | 0.25d | |
| P2-16 | Implement dark mode via `next-themes` (`class` strategy, TailwindCSS `dark:`) | J | 0.5d | |
| **2.5 — API Stubs** | | | | |
| P2-17 | Scaffold `POST /api/trips/route.ts`: `CreateTripSchema` (Zod), 400 on bad input, 501 stub | S | 0.5d | Locks contract for Phase 6 |
| P2-18 | Scaffold `POST /api/trips/[tripId]/members/route.ts`: `InviteMemberSchema` (Zod), 501 stub | S | 0.25d | |
| **2.6 — Seed & Migration** | | | | |
| P2-19 | Write `supabase/seed.sql`: Iceland trip row in `trips` | J | 0.5d | Local dev only |
| P2-20 | Add both trip owner emails to `trip_members` via seed | J | 0.25d | |
| **2.7 — Shared Components** | | | | |
| P2-21 | Create `PageShell.tsx`, `Header.tsx` (trip title from `useTrip()`, sync placeholder) | J | 0.5d | |
| P2-22 | Implement `ErrorBoundary.tsx` + `Skeleton.tsx` (page and section variants) | J | 0.5d | Used in tabs layout |
| P2-23 | Create UI primitives: `Button.tsx`, `Card.tsx`, `Badge.tsx`, `Spinner.tsx` | AI | 0.5d | Use shadcn/ui CLI as base |
| **2.8 — Test Infrastructure** | | | | |
| P2-24 | Set up Vitest + `@testing-library/react` + jsdom (`vitest.config.ts`, setup file) | J | 0.5d | Moved from Phase 8 |
| P2-25 | Set up Playwright (`playwright.config.ts`, install browsers in CI) | J | 0.25d | Moved from Phase 8; no specs |
| P2-26 | Write Playwright auth spec: email → callback → trip redirect (verifies auth flow end-to-end) | S | 1d | Requires Inbucket email intercept |
| P2-27 | Verify `pnpm build`, `pnpm dev`, `pnpm check-types`: zero errors | S | 0.25d | |

**Phase 2 Total**: ~11 days

---

### Phase 3 — TypeScript Domain Models

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P3-01 | Expand `src/domains/trip/types.ts`: full Trip, TripMember, TripRole schemas | S | 0.5d | Extends P2-07 |
| P3-02 | Create `src/domains/packing/schema.ts`: PackItem, PackItems | J | 0.25d | |
| P3-03 | Create `src/domains/budget/schema.ts`: Expense, BudgetState | J | 0.5d | Include optional receipt fields |
| P3-04 | Create `src/domains/itinerary/types.ts`: Day, Stop, DrivingLeg — column names match DB schema | S | 1d | Cross-reference itinerary_days + itinerary_stops |
| P3-05 | Create `src/domains/conditions/types.ts`: RoadStatus, WeatherForecast | J | 0.25d | |
| P3-06 | Create `src/domains/poi/types.ts`: GasStation, Supermarket, Poi union | J | 0.25d | |
| P3-07 | Create `src/domains/sync/types.ts`: SyncSettings, SyncStatus | J | 0.25d | |
| P3-08 | Create `src/store/types.ts`: root AppState (no activeTab, no progression) | S | 0.5d | |
| P3-09 | Run `supabase gen types typescript --local`, commit `src/lib/supabase/database.types.ts` | J | 0.25d | |
| P3-10 | Seed itinerary from `trip-data.js` into `itinerary_days` + `itinerary_stops` tables | S | 1d | Ensures DB matches typed schema |
| P3-11 | Run `pnpm check-types`, resolve all errors | S | 0.5d | |

**Phase 3 Total**: ~5.25 days

---

### Phase 4 — State & Storage Layer

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P4-01 | Install Zustand 5, immer, TanStack Query v5 | J | 0.25d | |
| P4-02 | Implement `packingSlice.ts`: 4 packing actions | J | 0.5d | |
| P4-03 | Implement `budgetSlice.ts`: 4 budget actions, ISK validation | J | 0.5d | |
| P4-04 | Implement `uiSlice.ts`: moduleCollapse **only** — no activeTab | J | 0.25d | Explicit omission |
| P4-05 | Implement `syncSlice.ts`: tripId, autoSync, syncStatus | S | 0.5d | |
| P4-06 | Implement `createTripStore(tripId)` in `store/index.ts`: slices + persist, key = `tripState:${tripId}` | S | 0.5d | |
| P4-07 | Implement `store/middleware/migration.ts`: `migrateState()` + one-time `icelandAppStateV1` → `tripState:{id}` | S | 1d | Data continuity for existing users |
| P4-08 | Create `TripStoreProvider.tsx`: instantiates store per tripId, runs legacy migration on mount | S | 0.5d | |
| P4-09 | Port `local-storage-adapter.js` → `src/storage/local-storage.ts` | J | 0.25d | |
| P4-10 | Port `indexeddb-adapter.js` → `src/storage/indexeddb.ts` (promisified) | J | 0.5d | |
| P4-11 | Port `supabase-adapter.js` → `src/storage/supabase.ts` + `useRealtimeSync(tripId)` with null guard | S | 1d | Filter by `trip_id` column |
| P4-12 | Verify `tripState:{tripId}` key continuity; test legacy migration with real `icelandAppStateV1` fixture | S | 0.5d | |
| P4-13 | Write Vitest unit tests for all slices + legacy key migration | J | 1d | |

**Phase 4 Total**: ~6.75 days

---

### Phase 5 — Feature Migration

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| **5.2 — Home** | | | | |
| P5-01 | Implement `CountdownBanner.tsx`: days from `useTrip().departureDate` | J | 0.5d | Not hardcoded |
| P5-02 | Implement `FlightInfo.tsx`: reads departure/return from TripContext (server component) | J | 0.25d | |
| P5-03 | Implement `HomeTab` page: compose all home widgets | S | 0.5d | |
| **5.3 — Packing** | | | | |
| P5-04 | Implement `PackingList.tsx` + `PackItem.tsx` + `PackProgress.tsx` | J | 1d | |
| P5-05 | Wire `usePackItems()` selector to Zustand packing slice | J | 0.25d | |
| P5-06 | Implement inline item edit (tap-to-edit, matching existing UX) | J | 0.5d | |
| **5.4 — Budget** | | | | |
| P5-07 | Implement `ExpenseList.tsx` + `ExpenseForm.tsx` (React Hook Form + Zod) | J | 1d | |
| P5-08 | Implement `FxConverter.tsx` with `useExchangeRate()` (TanStack Query → ECB) | S | 0.5d | |
| P5-09 | Implement `DailyPaceGauge.tsx` | J | 0.5d | |
| P5-10 | Implement `BudgetTracker.tsx` composition | J | 0.25d | |
| **5.5 — Conditions** | | | | |
| P5-11 | Implement `useRoadStatus()` + `useWeather()` (TanStack Query, stale times) | S | 0.5d | |
| P5-12 | Implement `RoadStatusBadge.tsx` + `WeatherCard.tsx` with per-feature ErrorBoundary | J | 0.5d | |
| **5.6 — Itinerary (DB-driven)** | | | | |
| P5-13 | Implement `src/domains/itinerary/queries.ts`: `getDays` + `getDay` | S | 0.5d | |
| P5-14 | Implement `ItineraryTab` page: Server Component → `getDays(supabase, tripId)` | S | 0.5d | |
| P5-15 | Implement `DayCard.tsx`: reads from Supabase row | J | 1d | |
| P5-16 | Implement `ItineraryMap.tsx` with react-leaflet (dynamic import, ssr: false) | S | 1.5d | Most complex component |
| P5-17 | Implement `DrivingStats.tsx` | J | 0.5d | |
| P5-18 | **Delete `trip-data.js`** — verify all itinerary renders from Supabase | S | 0.5d | Milestone: static data retired |
| **5.7 — Day Modal (DB-driven)** | | | | |
| P5-19 | Implement `[day]/page.tsx`: `getDay(supabase, tripId, dayNumber)` | S | 0.5d | |
| P5-20 | Implement `StopList.tsx` with enable/disable toggle | J | 0.5d | |
| P5-21 | Implement day fuel projection display | J | 0.25d | |
| P5-22 | Implement day map (miniature route, second Leaflet instance) | S | 1d | |
| **5.8 — POI** | | | | |
| P5-23 | Implement `useNearbyPoi()`: geolocation + distance sort | S | 0.5d | |
| P5-24 | Implement `NearbyServices.tsx` + `PoiCard.tsx` with ErrorBoundary | J | 0.5d | |
| **5.9 — Sync / Members** | | | | |
| P5-25 | Implement `SyncSettings.tsx`: trip members list + invite form → `POST /api/trips/[tripId]/members` | J | 0.5d | Replaces raw trip code input |
| P5-26 | Implement `SyncStatusBadge.tsx` | J | 0.25d | |
| P5-27 | Wire `useRealtimeSync(tripId)` in `TripStoreProvider` | S | 0.5d | |

**Phase 5 Total**: ~14.25 days

---

### Phase 6 — API Routes & AI Generation

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P6-01 | Implement `POST /api/trips`: AI generation → Supabase write → return tripId | S | 2d | Claude API + Zod output validation |
| P6-02 | Implement `POST /api/trips/[tripId]/members`: verify owner, send magic link invite | S | 1d | Service role key required |
| P6-03 | Implement `app/trips/new/page.tsx`: AI generation form (full, replaces Phase 2 stub) | S | 1d | React Hook Form + Zod |
| P6-04 | Implement `app/api/road-status/route.ts`: edge runtime, 15min cache | S | 1d | Port of Supabase Edge Function |
| P6-05 | Implement `app/api/maps-expand/route.ts`: hop limit, hop logging | S | 0.5d | |
| P6-06 | Implement `app/api/poi/route.ts`: bbox filter, `Cache-Control: max-age=604800` | S | 0.5d | |
| P6-07 | Implement `app/api/weather/route.ts`: proxy Vedur.is with cache headers | J | 0.5d | |
| P6-08 | Add Zod input validation to all API Route handlers | J | 0.5d | |
| P6-09 | Add in-memory rate limiting (`rateLimit()`) to road-status and weather | J | 0.25d | |
| P6-10 | Implement `ConditionsProvider` interface + Iceland + generic implementations | S | 0.5d | |
| P6-11 | Test all API routes with curl + write Vitest unit tests (mocked fetch) | J | 0.5d | |
| P6-12 | Decommission Supabase Edge Functions (mark deprecated, schedule Week +1 removal) | S | 0.25d | |

**Phase 6 Total**: ~7.5 days

---

### Phase 7 — PWA & Performance

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P7-01 | Configure Serwist (`@serwist/next`): `swSrc`, runtime caching strategies per resource type | S | 1d | Not next-pwa |
| P7-02 | Create `public/manifest.json` with icons, theme color, display mode | J | 0.5d | |
| P7-03 | Generate PWA icons (192×192, 512×512, maskable) | J | 0.25d | |
| P7-04 | Implement offline fallback page (`app/offline/page.tsx`) | J | 0.5d | |
| P7-05 | Verify `dynamic(() => import(...), { ssr: false })` on all Leaflet components | J | 0.25d | |
| P7-06 | Audit all `<ErrorBoundary>` + `<Suspense>` coverage across async components | J | 0.5d | |
| P7-07 | Audit all images: use Next.js `<Image>` with correct `sizes` + AVIF | J | 0.5d | |
| P7-08 | Run Lighthouse audit, address all PWA and performance findings | S | 1d | |
| P7-09 | Enable Vercel Web Analytics + Speed Insights | J | 0.25d | |

**Phase 7 Total**: ~4.75 days

---

### Phase 8 — Testing

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P8-01 | Write Vitest: packing slice (4 actions, edge cases) | J | 0.5d | |
| P8-02 | Write Vitest: budget slice (4 actions, ISK bounds) | J | 0.5d | |
| P8-03 | Write Vitest: `migrateState()` + `icelandAppStateV1` → `tripState:{id}` | S | 0.5d | |
| P8-04 | Write Vitest: all Zod schemas (valid + invalid edge cases) | AI | 0.5d | |
| P8-05 | Write Vitest: `fuel.ts`, `formatting.ts`, `rate-limit.ts` | J | 0.25d | |
| P8-06 | Write Playwright: trip access (auth guard, 404 on unknown tripId, member vs non-member) | S | 0.5d | |
| P8-07 | Port `smoke-check.sh` to `tests/e2e/navigation.spec.ts` | J | 0.5d | |
| P8-08 | Write Playwright: packing list full flow | J | 0.5d | |
| P8-09 | Write Playwright: budget full flow | J | 0.5d | |
| P8-10 | Write Playwright: itinerary tab (day card expand, modal, back nav) | S | 0.5d | |
| P8-11 | Write Playwright: realtime sync between two authenticated tabs | S | 0.5d | Requires local Supabase |
| P8-12 | Write Playwright: offline mode (disable network via CDP, verify cached content) | S | 1d | |
| P8-13 | Write Playwright: PWA (service worker registers, manifest valid) | J | 0.25d | |
| P8-14 | Achieve ≥ 80% Vitest coverage, fix uncovered critical paths | S | 0.5d | |

**Phase 8 Total**: ~6.5 days

---

### Phase 9 — Deployment & CI/CD

| # | Task | Level | Est. | Notes |
|---|---|---|---|---|
| P9-01 | Configure all production env vars in Vercel (include `ANTHROPIC_API_KEY`) | J | 0.5d | |
| P9-02 | Deploy to Vercel staging (`staging.iceland-trip.vercel.app`) | J | 0.25d | |
| P9-03 | Run full Playwright suite against staging, fix environment-specific failures | S | 1d | |
| P9-04 | Run Lighthouse on staging, ensure PWA score ≥ 90 | J | 0.5d | |
| P9-05 | DNS cutover: set TTL to 60s 24h in advance, point domain to Vercel | S | 0.5d | |
| P9-06 | Monitor Vercel logs + Supabase for first 24h post-cutover | S | 0.5d | |
| P9-07 | Mark Supabase Edge Functions deprecated, schedule Week +1 removal | J | 0.25d | |
| P9-08 | Archive old static site, decommission static hosting (after 7 days stable) | J | 0.25d | |
| P9-09 | Update `AGENTS.md` — verify against template defined in Phase 9 section above | J | 0.25d | |

**Phase 9 Total**: ~4 days

---

### Summary Table — All Tasks

| Phase | Tasks | Days | Junior | Senior | AI-assisted |
|---|---|---|---|---|---|
| P0 — Foundation | 11 | 6.25 | 5 | 6 | 0 |
| P1 — Decomp | 15 | 6.25 | 11 | 3 | 1 |
| P2 — Scaffold (Multi-tenant) | 27 | 11.0 | 13 | 13 | 1 |
| P3 — Types | 11 | 5.25 | 5 | 6 | 0 |
| P4 — State | 13 | 6.75 | 5 | 8 | 0 |
| P5 — Features | 27 | 14.25 | 15 | 12 | 0 |
| P6 — API Routes + AI | 12 | 7.5 | 4 | 8 | 0 |
| P7 — PWA | 9 | 4.75 | 7 | 2 | 0 |
| P8 — Testing | 14 | 6.5 | 7 | 7 | 1 |
| P9 — Deploy | 9 | 4.0 | 6 | 3 | 0 |
| **Total** | **148** | **~72.5** | **~78 (53%)** | **~68 (46%)** | **~3 (2%)** |

> **With parallel work** (2 developers): estimated **36–44 calendar days**
> **Solo**: estimated **65–80 working days** (including review/debug cycles)

---

## 7. Risk Register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Leaflet SSR incompatibility | High | Medium | `dynamic(() => import(...), { ssr: false })` on all map components |
| Supabase realtime breaks during migration | Medium | High | Keep old static app live; roll back DNS immediately |
| Legacy `icelandAppStateV1` migration fails | Medium | High | Read key, Zod-validate, write `tripState:{id}`, delete old key **only after** successful write |
| Auth magic link fails on iOS Safari (redirect blocked) | Medium | High | Test on real iOS during Phase 2; callback URL must be in Supabase allowed list |
| RLS misconfiguration leaks trip data across users | Low | Critical | E2E test in Phase 8: user B cannot read user A's trip — added to `trip-access.spec.ts` |
| Phase 1 extraction breaks smoke tests | High | Medium | Smoke test after every single extraction step — never batch |
| AI generation produces invalid itinerary schema | Medium | Medium | Zod-validate AI output before Supabase write; retry with corrected prompt on failure |
| 3,942-line POI parse time on mobile | Medium | Low | `/api/poi` with bbox filter + `Cache-Control: max-age=604800` |
| Umferdin API rate limits | Low | Medium | 15min server-side cache at API Route layer |
| Playwright flakiness in CI | Medium | Low | `--repeat-each=3`, require 3 consecutive green runs before merge |
| ~~next-pwa incompatibility with Next.js 15~~ | — | — | Resolved: using Serwist (`@serwist/next`) |

---

## 8. Decision Log

| # | Decision | Rationale | Alternatives Considered |
|---|---|---|---|
| D1 | Standalone Next.js repo (not in Affluent Turborepo) | Trip-specific domain, independent deployment. Internal architecture mirrors Affluent patterns → low-cost merge as `apps/trip-companion` later | Add to monorepo now — premature before the product is validated |
| D2 | Zustand 5 over Jotai or Redux | Maps 1:1 to existing store pattern; `tripId`-scoped persistence key handles multi-tenant without extra config | Jotai (too atomic), Redux (overkill) |
| D3 | Keep Supabase schema (extended, not replaced) | Existing `trip_state` table kept; new tables added alongside. Zero risk of data loss | Full schema rewrite — unnecessary risk |
| D4 | Port Supabase Edge Functions to Next.js API Routes | One deployment platform; Next.js caching replaces manual TTL management | Keep Edge Functions — two-backend complexity |
| D5 | POI served from `/api/poi` (static JSON + bbox filter + `Cache-Control: max-age=604800`) | No DB migration for static data; server-side caching eliminates mobile parse cost. Provider interface ready for dynamic POI | `data.ts` import — no caching, no filtering; Supabase table — unnecessary for static data |
| D6 | Day modal as URL segment (`/trips/[tripId]/itinerary/[day]`) | Deep-linkable, browser back works, shareable link | Client-side modal state — loses deep-link |
| D7 | TanStack Query for road/weather | Consistent with Affluent stack; per-`tripId` query key scoping | SWR — fewer features |
| D8 | `next-themes` for dark mode | Zero-flash, SSR-compatible, class-based (TailwindCSS 4 compatible) | Manual `prefers-color-scheme` — more bugs |
| D9 | Day modal as full page, not parallel route | Simpler; parallel routes add per-slot `loading.tsx` + `error.tsx` complexity not justified for a 2-user app | Parallel routes (`@modal`) — better mobile UX at higher implementation cost; revisit when scaling |
| D10 | Supabase Auth magic link (email OTP) | Zero-friction, no password management, native Supabase integration; enables `trip_members` invite flow via the same mechanism | Passwords — overhead; OAuth — requires provider setup; Anonymous sessions — cannot scope to trip membership |
| D11 | `trips/[tripId]/(tabs)/...` routing model | All routes parameterised by `tripId` from Phase 2; no retrofit needed when multi-trip ships. TripProvider at `[tripId]/layout.tsx` is the single RLS security boundary. **`activeTab` removed from Zustand entirely — URL is the source of truth** | Flat `(tabs)/` with tripId in context — loses URL-level trip identity; subdomain per trip — DNS management at scale |
| D12 | `ConditionsProvider` interface for road/weather | Iceland-specific services isolated behind an interface; generic implementation unblocks non-Iceland destinations. Zero breaking changes to consuming components | Hardcode Iceland services — blocks multi-destination support |
| D13 | In-memory rate limiting (not Upstash Redis) | At most 2 concurrent users; in-memory avoids third-party billing, cold-start latency, and dependency. Re-evaluate when platform reaches meaningful multi-tenant scale | Upstash Redis — correct for scale, premature for current scope |
