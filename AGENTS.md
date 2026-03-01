# AGENTS Instructions for `iceland-trip`

## Mandatory pre-delivery checks
For every code change in this project, run these commands before saying work is complete:

1. `./scripts/build-runtime-globals.sh`
2. `./scripts/smoke-check.sh`

Do not skip these checks unless the user explicitly asks to skip them.

## Why
- `build-runtime-globals.sh` regenerates `src/runtime-globals.js` from module sources.
- `smoke-check.sh` validates critical app flows (`home`, `itinerary`, `tools`) including:
  - tabs
  - countdown
  - packing visibility/items
  - budget visibility
  - today overview presence
  - itinerary/global overview visibility

## Reporting format
When finishing a task, include:
1. Whether both commands passed.
2. If a check failed, exact failure output and what was changed to fix it.
