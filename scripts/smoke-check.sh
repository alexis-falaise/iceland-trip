#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-4173}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Chrome binary not found at: $CHROME_BIN" >&2
  echo "Set CHROME_BIN to your Chrome executable path." >&2
  exit 1
fi

"$ROOT_DIR/scripts/build-runtime-globals.sh" >/dev/null

cd "$ROOT_DIR"
python3 -m http.server "$PORT" >/tmp/iceland-smoke-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID >/dev/null 2>&1 || true' EXIT

sleep 1

run_case() {
  local tab="$1"
  local url="http://127.0.0.1:${PORT}/index.html?__smoke=1&tab=${tab}"
  local dom_file
  local dom_tmp
  dom_tmp="$(mktemp /tmp/iceland-smoke-dom-XXXXXX)"
  dom_file="${dom_tmp}.html"
  mv "$dom_tmp" "$dom_file"

  python3 - "$CHROME_BIN" "$url" "$dom_file" <<'PY'
import subprocess
import sys

chrome_bin, url, dom_file = sys.argv[1:4]
cmd = [
    chrome_bin,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--virtual-time-budget=9000",
    "--dump-dom",
    "--timeout=15000",
    url,
]
result = subprocess.run(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    timeout=45,
)
with open(dom_file, "w", encoding="utf-8") as output:
    output.write(result.stdout)
if result.returncode != 0:
    raise SystemExit(result.returncode)
PY

  local report_json
  report_json="$(
    python3 - "$dom_file" <<'PY'
import html
import re
import sys

dom_path = sys.argv[1]
content = open(dom_path, "r", encoding="utf-8").read()
match = re.search(r'<pre id="__smoke-report"[^>]*>(.*?)</pre>', content, re.S)
if not match:
    print("")
    sys.exit(2)
print(html.unescape(match.group(1)))
PY
  )"

  if [[ -z "$report_json" ]]; then
    echo "Missing smoke report for tab '${tab}'" >&2
    rm -f "$dom_file"
    exit 1
  fi

  python3 - "$tab" "$report_json" <<'PY'
import json
import sys

expected_tab = sys.argv[1]
report = json.loads(sys.argv[2])
errors = []

if report.get("activeTab") != expected_tab:
    errors.append(f"activeTab={report.get('activeTab')} expected {expected_tab}")

if report.get("tabButtonCount") != 3:
    errors.append(f"tabButtonCount={report.get('tabButtonCount')} expected 3")

if report.get("activeTabButtonCount") != 1:
    errors.append(f"activeTabButtonCount={report.get('activeTabButtonCount')} expected 1")

if report.get("packItemCount", 0) <= 0:
    errors.append(f"packItemCount={report.get('packItemCount')} expected > 0")

countdown_text = str(report.get("countdownDaysText", "")).strip().lower()
if not countdown_text:
    errors.append("countdownDaysText is empty")
if countdown_text in {"0 day", "0 days"}:
    errors.append(f"countdownDaysText={countdown_text} expected non-zero")

if not report.get("todayOverviewExists"):
    errors.append("todayOverview block missing")

if expected_tab == "home" and not report.get("todayOverviewVisible"):
    errors.append("todayOverview should be visible on home")

if expected_tab == "itinerary":
    if not report.get("itineraryOverviewVisible"):
        errors.append("itinerary overview should be visible on itinerary tab")
    if not report.get("daysContainerVisible"):
        errors.append("days container should be visible on itinerary tab")

if expected_tab == "tools":
    if not report.get("packingVisible"):
        errors.append("packing should be visible on tools tab")
    if not report.get("budgetVisible"):
        errors.append("budget should be visible on tools tab")

if errors:
    print("\n".join(errors))
    sys.exit(1)

print(
    f"OK {expected_tab}: pack={report.get('packItemCount')} "
    f"countdown='{report.get('countdownDaysText')}'"
)
PY

  rm -f "$dom_file"
}

run_case "home"
run_case "itinerary"
run_case "tools"

echo "Smoke check passed."
