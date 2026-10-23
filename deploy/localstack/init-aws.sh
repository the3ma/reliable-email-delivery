#!/usr/bin/env bash
# LocalStack ready.d hook: everything the CDK stack creates in AWS, with the names from docs/CONTRACT.md.
set -euo pipefail
R=us-east-1
ACCT=000000000000

queue() { # name dlq-name
  awslocal sqs create-queue --queue-name "$2" --attributes MessageRetentionPeriod=1209600 >/dev/null
  local dlq_arn="arn:aws:sqs:$R:$ACCT:$2"
  awslocal sqs create-queue --queue-name "$1" --attributes "{
    \"VisibilityTimeout\": \"180\", \"MessageRetentionPeriod\": \"1209600\", \"MaximumMessageSize\": \"524288\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" >/dev/null
}
queue intake intake-dlq
queue email email-dlq

awslocal events create-event-bus --name app-events >/dev/null
awslocal events put-rule --name notification-requested --event-bus-name app-events \
  --event-pattern '{"detail-type":["notification.requested"]}' >/dev/null
awslocal events put-targets --rule notification-requested --event-bus-name app-events \
  --targets "Id=intake,Arn=arn:aws:sqs:$R:$ACCT:intake,InputPath=\$.detail" >/dev/null

table() { # name key-schema attribute-definitions [gsi-json] [ttl-attribute]
  local args=(--table-name "$1" --billing-mode PAY_PER_REQUEST --key-schema "$2" --attribute-definitions "$3")
  [ -n "${4:-}" ] && args+=(--global-secondary-indexes "$4")
  awslocal dynamodb create-table "${args[@]}" >/dev/null
  [ -n "${5:-}" ] && awslocal dynamodb update-time-to-live --table-name "$1" \
    --time-to-live-specification "Enabled=true,AttributeName=$5" >/dev/null
  return 0
}
BY_SEGMENT='[{"IndexName":"by-segment","KeySchema":[{"AttributeName":"segment","KeyType":"HASH"},{"AttributeName":"userId","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'
table subscriptions 'AttributeName=userId,KeyType=HASH' \
  'AttributeName=userId,AttributeType=S AttributeName=segment,AttributeType=N' "$BY_SEGMENT"
table pending-digest 'AttributeName=userId,KeyType=HASH AttributeName=sk,KeyType=RANGE' \
  'AttributeName=userId,AttributeType=S AttributeName=sk,AttributeType=S AttributeName=segment,AttributeType=N' "$BY_SEGMENT" expiresAt
table deliveries 'AttributeName=deliveryId,KeyType=HASH' 'AttributeName=deliveryId,AttributeType=S' '' expiresAt
table delivery-log 'AttributeName=deliveryId,KeyType=HASH AttributeName=sk,KeyType=RANGE' \
  'AttributeName=deliveryId,AttributeType=S AttributeName=sk,AttributeType=S' '' expiresAt
table suppressions 'AttributeName=emailHash,KeyType=HASH' 'AttributeName=emailHash,AttributeType=S'

awslocal ssm put-parameter --name /local/email/send-emails --type String --value enabled --overwrite >/dev/null
awslocal ssm put-parameter --name /local/email/record-deliveries --type String --value enabled --overwrite >/dev/null
echo "reliable-email-delivery: queues, bus, tables and toggles ready"
