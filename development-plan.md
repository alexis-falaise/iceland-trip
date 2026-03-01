# Iceland Trip PWA - Development Plan (Features 3, 6, 7, 8)

## Scope
- `3` Morning readiness checks
- `6` Smart reminders
- `7` Daily progression (visited/done)
- `8` Receipt capture for budget

## Recommended Build Order
1. `7` Daily progression
2. `3` Morning readiness checks
3. `8` Receipt capture (MVP without OCR)
4. `6` Smart reminders (in-app first, push second)

## 7) Daily Progression (Visited / Done)
### MVP
- Add state: `visitedStopsByDay` (keyed by day number, values = stop IDs).
- Add `Done` toggle on location cards (day modal + day list if needed).
- Show progress in day modal header: `x / y visited`.
- Highlight next unvisited stop.
- Add actions: `Mark day complete`, `Reset day`.
- Include in Supabase sync payload.

### Technical Notes
- Stop IDs should be deterministic (`dayNumber + stopIndex + normalizedName`).
- Keep UI optimistic and sync debounced.

### Acceptance Criteria
- Marking a stop done updates UI immediately and syncs to partner device.
- Refresh keeps progression state.

## 3) Morning Readiness Checks
### MVP
- Add state: `readinessByDate` (local date key or trip day key).
- Checklist card on Home tab only:
  - Fuel checked
  - Weather checked
  - Road status checked
  - First stop route opened
- Display overall status (`Ready` when all checked).
- Auto-create fresh checklist per day.
- Include in Supabase sync payload.

### Acceptance Criteria
- New day starts unchecked.
- Changes sync in real time between both devices.

## 8) Receipt Capture for Budget
### MVP (no OCR)
- Extend expense model:
  - `category` (optional)
  - `note` (optional)
  - `receipt` metadata (url/path, filename, createdAt)
- Add capture flow:
  - Camera/file input (`accept="image/*" capture="environment"`)
  - Attach receipt when creating/editing expense
- Store receipts:
  - Preferred: Supabase Storage bucket + signed/public URL in expense.
  - Fallback: local-only IndexedDB for offline mode.
- Add receipt preview/open action in budget list.

### Acceptance Criteria
- User can add expense with receipt photo from mobile camera.
- Receipt survives reload and syncs to second device (if using Supabase Storage).

## 6) Smart Reminders
### Phase 1 (MVP): In-App Reminders
- In-app reminder engine while app is open.
- Reminder types:
  - Morning checklist reminder
  - Leave-for-next-leg reminder
  - Budget pace warning
- Settings in Tools:
  - Enable/disable reminders
  - Reminder times

### Phase 2: Push Notifications
- Service worker + web push subscription flow.
- Backend scheduler (Supabase Edge Functions + scheduled jobs).
- Per-device subscription storage.
- iOS constraint: requires installed PWA + notification permission.

### Acceptance Criteria
- Phase 1: reminders fire reliably when app is open.
- Phase 2: reminders arrive in background for subscribed devices.

## Data Model Updates
- Extend sync payload with:
  - `visitedStopsByDay`
  - `readinessByDate`
  - Budget expenses with optional receipt fields
- Add payload `schemaVersion` migration helper for backward compatibility.

## Risks / Constraints
- LocalStorage size limits are insufficient for photos; use Storage/IndexedDB.
- Concurrent edits require last-write strategy or field-level merge rules.
- Push notifications require additional infra and browser permission handling.

## Suggested Milestones
1. `M1` Progression + readiness + sync updates
2. `M2` Receipt capture + storage + synced budget item metadata
3. `M3` In-app reminders
4. `M4` Push reminders (optional second step)

