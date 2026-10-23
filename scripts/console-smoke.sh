#!/usr/bin/env bash
# End-to-end check of the Delivery Console (run after `make demo`), through the web container's proxy:
#   web + api healthy -> security headers -> reset -> duplicate-storm -> exactly 10 e-mails -> mailbox
set -euo pipefail

WEB="${WEB:-http://localhost:8080}"
API="$WEB/api/v1"
ok()   { printf '\033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
get()  { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(typeof v==="object"&&v!==null?JSON.stringify(v):String(v))})' "$1"; }

step "web and api"
curl -sf "$WEB/healthz" >/dev/null || fail "web /healthz"
[ "$(curl -s "$API/health" | get status)" = ok ] || fail "api health through the proxy is not ok"
ok "web serves the console, /api reaches console-api, LocalStack and Mailpit are up"
headers=$(curl -sI "$WEB/")
for h in content-security-policy x-content-type-options referrer-policy; do
  grep -qi "^$h:" <<<"$headers" || fail "missing security header $h"
done
ok "security headers present"

step "duplicate-storm (the old system's 118x case)"
curl -sf -X POST -H 'Content-Type: application/json' -d '{}' "$API/reset" >/dev/null
run=$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' "$API/scenarios/duplicate-storm/run")
run_id=$(get runId <<<"$run")
[ -n "$run_id" ] && [ "$run_id" != undefined ] || fail "scenario did not start: $run"
last=-1; stable=0
for _ in $(seq 1 90); do
  ov=$(curl -s "$API/overview")
  mails=$(get mail.total <<<"$ov")
  busy=$(node -e 'const q=JSON.parse(process.argv[1]).queues;let n=0;for(const k in q)n+=q[k].visible+q[k].inFlight;console.log(n)' "$ov")
  if [ "$busy" -eq 0 ] && [ "$mails" -eq "$last" ]; then stable=$((stable + 1)); [ "$stable" -ge 3 ] && break; else stable=0; fi
  last=$mails; sleep 2
done
[ "$stable" -ge 3 ] || fail "the pipeline did not settle"
[ "$mails" -eq 10 ] || fail "duplicate-storm produced $mails e-mails, expected exactly 10"
[ "$(get counts.SENT <<<"$ov")" -eq 10 ] || fail "SENT deliveries != 10"
ok "120 published copies -> exactly 10 e-mails, 10 SENT"

step "mailbox"
first=$(curl -s "$API/mail?limit=1" | get items.0.id)
msg=$(curl -s "$API/mail/$first")
[ -n "$(get html <<<"$msg")" ] || fail "mail detail has no html"
[ "$(get deliveryId <<<"$msg")" != undefined ] || fail "mail detail has no deliveryId"
delivery=$(curl -s "$API/deliveries/$(get deliveryId <<<"$msg")")
[ "$(get status <<<"$delivery")" = SENT ] || fail "the mail's delivery is not SENT"
ok "mailbox message links back to its SENT delivery"

printf '\n\033[32mConsole smoke test passed.\033[0m\n'
