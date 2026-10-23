#!/usr/bin/env bash
# End-to-end check of the local stack (run after `make up && make seed`):
#   publish (incl. duplicates + invalid) -> immediate mail, one per delivery id, none to suppressed
#   -> publish the same batch again: no new mail -> digest twice: one digest per user
#   -> kill switch: nothing sent, SKIPPED(disabled) -> SES bounce feedback suppresses the address
set -euo pipefail

MAILPIT="${MAILPIT:-http://localhost:8025}"
ok()   { printf '\033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
job()  { docker compose run --rm --no-deps -T jobs "$@"; }
aws()  { docker compose exec -T localstack awslocal "$@"; }
mail_total() { curl -sf "$MAILPIT/api/v1/messages?limit=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))'; }
count_status() { # status [reason]
  local filter='#s = :s' values="{\":s\":{\"S\":\"$1\"}}"
  if [ -n "${2:-}" ]; then filter='#s = :s AND reason = :r'; values="{\":s\":{\"S\":\"$1\"},\":r\":{\"S\":\"$2\"}}"; fi
  aws dynamodb scan --table-name deliveries --select COUNT --filter-expression "$filter" \
    --expression-attribute-names '{"#s":"status"}' --expression-attribute-values "$values" --query Count --output text
}
queue_len() { # name -> visible + in flight
  local url; url=$(aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text)
  aws sqs get-queue-attributes --queue-url "$url" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text | awk '{print $1+$2}'
}
drain() { # wait until intake and email are empty and the mail count is stable
  local last=-1 stable=0
  for _ in $(seq 1 90); do
    local n; n=$(mail_total)
    if [ "$(queue_len intake)" -eq 0 ] && [ "$(queue_len email)" -eq 0 ] && [ "$n" -eq "$last" ]; then
      stable=$((stable + 1)); [ "$stable" -ge 3 ] && return 0
    else stable=0; fi
    last=$n; sleep 2
  done
  fail "queues did not drain"
}

step "1. publish 100 requests (duplicates and invalid ones included)"
curl -sf -X DELETE "$MAILPIT/api/v1/messages" >/dev/null
job publish -- --count 100 --users 40 --seed 42 >/dev/null
drain
sent=$(count_status SENT); mails=$(mail_total)
echo "   delivered mails=$mails, deliveries SENT=$sent"
[ "$mails" -gt 0 ] || fail "nothing was delivered"
[ "$mails" -eq "$sent" ] || fail "mail count ($mails) != SENT deliveries ($sent)"
dup=$(curl -sf "$MAILPIT/api/v1/messages?limit=1000" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const base=process.argv[1];const ids=new Map();
  for(const m of JSON.parse(s).messages){const h=await (await fetch(base+"/api/v1/message/"+m.ID+"/headers")).json();
    const id=(h["X-Tag-Deliveryid"]||h["X-Tag-deliveryId"]||[])[0];ids.set(id,(ids.get(id)||0)+1)}
  console.log([...ids.values()].filter(n=>n>1).length)})' "$MAILPIT")
[ "$dup" -eq 0 ] || fail "$dup delivery ids were mailed more than once"
ok "$mails e-mails, exactly one per delivery id"
supp=$(curl -sf "$MAILPIT/api/v1/messages?limit=1000" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).messages.filter(m=>m.To.some(t=>/user-0[0-9]0@/.test(t.Address))).length)})')
[ "$supp" -eq 0 ] || fail "$supp e-mails went to pre-suppressed addresses"
ok "no e-mail to a suppressed address ($(count_status SKIPPED suppressed) skipped as suppressed)"
for q in intake-dlq email-dlq; do [ "$(queue_len $q)" -eq 0 ] || fail "$q is not empty"; done
ok "invalid requests were dropped, not retried: both DLQs empty"
raw=$(curl -sf "$MAILPIT/api/v1/messages?limit=1000" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{let n=0;for(const m of JSON.parse(s).messages){
  const b=await (await fetch(process.argv[1]+"/api/v1/message/"+m.ID)).json();if(/<script/i.test(b.HTML||""))n++}console.log(n)})' "$MAILPIT")
[ "$raw" -eq 0 ] || fail "$raw HTML bodies contain an unescaped <script>"
ok "markup in request data arrived escaped"

step "2. publish the same 100 requests again"
job publish -- --count 100 --users 40 --seed 42 >/dev/null
drain
[ "$(mail_total)" -eq "$mails" ] || fail "re-publishing sent new mail"
ok "no new e-mail ($mails total) - every delivery id was already SENT"

step "3. digest, twice"
job digest -- --all --ignore-window >/dev/null
drain
after_digest=$(mail_total)
[ "$after_digest" -gt "$mails" ] || fail "the digest sent nothing"
job digest -- --all --ignore-window >/dev/null
drain
[ "$(mail_total)" -eq "$after_digest" ] || fail "a second digest run sent again"
ok "$((after_digest - mails)) digests, and a second run sent none"

step "4. kill switch"
aws ssm put-parameter --name /local/email/send-emails --value disabled --type String --overwrite >/dev/null
docker compose restart worker-processor >/dev/null # drop the 5-minute toggle cache
before=$(count_status SKIPPED disabled)
job publish -- --count 30 --users 40 --seed 7 >/dev/null
drain
[ "$(mail_total)" -eq "$after_digest" ] || fail "mail was sent while disabled"
[ "$(count_status SKIPPED disabled)" -gt "$before" ] || fail "nothing was recorded as SKIPPED(disabled)"
ok "nothing sent while disabled; $(( $(count_status SKIPPED disabled) - before )) recorded as SKIPPED(disabled)"
aws ssm put-parameter --name /local/email/send-emails --value enabled --type String --overwrite >/dev/null
docker compose restart worker-processor >/dev/null

step "5. SES bounce feedback"
supp_before=$(aws dynamodb scan --table-name suppressions --select COUNT --query Count --output text)
job feedback -- --type bounce --email user-003@example.test >/dev/null
supp_after=$(aws dynamodb scan --table-name suppressions --select COUNT --query Count --output text)
[ "$supp_after" -eq $((supp_before + 1)) ] || fail "the permanent bounce did not add a suppression"
aws dynamodb scan --table-name suppressions --output json | grep -q 'user-003' && fail "the suppression list stores a raw address"
ok "permanent bounce -> suppressed (stored as a hash, not the address)"

printf '\n\033[32mSmoke test passed.\033[0m\n'
