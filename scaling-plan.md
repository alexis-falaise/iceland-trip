# Iceland Trip PWA - Scaling Plan (3 Structural Upgrades)

## Goal
Make the app easier to scale for upcoming features (readiness checks, progression, receipts, reminders) without destabilizing current behavior.

---

## 1) Introduce a Central State Layer

### Why
- Current state is spread across many local variables and direct DOM updates.
- New features will add more cross-cutting state (date-aware UI, sync state, checklist state, receipt metadata).

### Target
- Single app state object with controlled updates.
- Predictable render/update flow.

### Implementation
1. Create a lightweight store module (`app-state.js`):
   - `getState()`
   - `setState(partialOrUpdater)`
   - `subscribe(listener)`
2. Move core domains into state:
   - `packItems`
   - `budget`
   - `syncSettings`
   - `moduleCollapse`
   - `todayOverview`
3. Replace direct writes with domain actions:
   - `togglePackItem(id)`
   - `addExpense(payload)`
   - `setActiveTab(tab)`
4. Keep render functions pure(ish):
   - render from `state`
   - avoid hidden side effects in UI handlers.

### Deliverables
- `src/state/app-state.js`
- `src/state/actions.js`
- initial migration of packing + budget + tab state.

### Acceptance Criteria
- Existing behavior remains unchanged for packing/budget/tab interactions.
- State changes are traceable through action functions.

---

## 2) Split Monolith Into ES Modules

### Why
- `index.html` currently mixes markup, styles, network, storage, and rendering.
- Hard to reason about, test, and safely extend.

### Target Structure
- `src/ui/` for DOM rendering and event binding
- `src/features/` for feature logic
- `src/services/` for external APIs (maps, weather, road, images)
- `src/state/` for store/actions
- `src/utils/` for shared helpers

### Suggested Module Breakdown
1. `src/features/itinerary/*`
   - day modal rendering
   - driving summaries
2. `src/features/packing/*`
   - list CRUD, progress
3. `src/features/budget/*`
   - expenses, totals, FX
4. `src/features/sync/*`
   - Supabase push/realtime wiring
5. `src/services/*`
   - weather, road status, images, map helpers

### Migration Strategy
1. Introduce `type="module"` script entry (`src/main.js`) while keeping existing HTML/CSS.
2. Move one feature at a time (packing -> budget -> itinerary -> sync).
3. After each move, run a smoke pass before moving the next feature.

### Deliverables
- `src/main.js`
- first feature extracted end-to-end (packing) with no behavior regression.

### Acceptance Criteria
- App boots from module entrypoint.
- No feature regressions in Home / Itinerary / Tools flows.

---

## 3) Add Persistence Adapters (LocalStorage, IndexedDB, Supabase)

### Why
- Different data types require different storage:
  - simple preferences/state -> localStorage
  - binary/large payloads (receipts/images) -> IndexedDB or Supabase Storage
  - shared state between devices -> Supabase table

### Target
- Unified persistence interface with swappable adapters by data domain.

### Adapter Design
- `storage/local-storage-adapter.js`
- `storage/indexeddb-adapter.js`
- `storage/supabase-adapter.js`
- Shared interface:
  - `load(key)`
  - `save(key, value)`
  - `remove(key)`
  - optional `watch(key, handler)` for realtime sources

### Domain Mapping
- localStorage:
  - UI preferences (collapsed modules, active tab hints)
  - lightweight caches (rates, small metadata)
- IndexedDB:
  - receipts/photos blobs + local references
- Supabase:
  - shared trip state (packing, budget, progression, readiness)
  - receipt metadata and storage URLs

### Migration and Versioning
1. Add `schemaVersion` in shared payload.
2. Add migration function:
   - `migrateState(oldState) -> newState`
3. Fallback safely if a device opens with an older payload.

### Deliverables
- adapter modules + domain wiring
- receipt-ready storage path (metadata + binary strategy)

### Acceptance Criteria
- Local and synced state remain consistent across reloads/devices.
- No localStorage quota failures from large media payloads.

---

## Execution Order
1. State layer foundation (small surface: packing + budget first)
2. Module split (incremental extraction)
3. Persistence adapters (then enable receipt-heavy flows)

---

## Risk Controls
- Keep feature flags per migrated domain during transition.
- Preserve existing IDs and DOM contracts until each migration stabilizes.
- Add minimal smoke checklist after each step:
  - tab switching
  - day modal open/close
  - packing add/check/edit/delete
  - budget add/edit/delete
  - couple sync push/receive

