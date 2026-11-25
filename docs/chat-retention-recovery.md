# Chat retention: pause, diagnosis and controlled recovery

This document describes the durable chat retention runtime and controlled
operator recovery flow for self-hosted deployments.

## State and access

An existing, live **Owner** Session can issue same-origin
`GET /api/chat/moderation/retention`. No additional account, role change, OAuth
configuration or secret is required. Ordinary users, moderators and admins are
refused. The response is `Cache-Control: no-store`:

```json
{"paused":true,"durablePaused":false,"token":"opaque-generation","operationState":"finalisation_required","recoveryAction":"finalise","lastAttempt":{"at":1792195200000,"outcome":"cleaned"}}
```

`token` is a concurrency guard, not an authentication credential. It is null
before an attempt exists or when metadata cannot be validated. A new token
never authorises bypassing an unresolved operation. `paused` is the effective
durable protocol decision; `durablePaused` reports only the old boolean and
cannot by itself establish safety. `recoveryAction` is `none`, `prune`,
`finalise` or `blocked`. A legacy pause/token is not automatically adopted.
`lastAttempt` is null or contains `at`, `outcome` and, on successful completion,
`markedParents`. Outcomes are `in_progress`, `cleaned` (automatic batch),
`recovered` (operator batch), or `failed` (automatic or operator attempt failed).
`in_progress` with `paused=true` is an interrupted or failed guarded attempt;
do not infer that cleanup is healthy. `markedParents` counts selected parents,
not physically deleted messages or billed D1 rows. The API exposes no content,
user identities, cookies, Session hashes or raw exception strings.

Automatic alarms first check the durable pause and perform the existing indexed,
read-only due check for pending parents, overflow, message expiry and version
expiry. A confirmed no-op returns without writing cleanup state or changing the
generation. The check runs in the room mutation queue, is never cached across
events or reconstruction, and uses the same cutoff as prune. Probe failure
persists a fresh generation and pause without entering prune. Reserve admission
and manual recovery retain their original guarded paths.

Before actual prune SQL, including selections, one atomic put binds pause,
generation and `retention-operation` (`started`). After SQL is positively
acknowledged, a separate put records `sql_complete` and its bounded result.
Completion then atomically writes the outcome, completion ID and pause=false.
**Only after that completion put is positively acknowledged** may the runtime
write `retention-completion`, matching both operation and completion IDs.
An unmatched/missing receipt keeps the operation effectively paused across
reconstruction, even if the completion put committed pause=false and a later
compensating pause failed. Catch handlers never overwrite the operation journal.
A receipt committed with a lost response proves only that the preceding
completion put was acknowledged, not receipt/HTTP acknowledgement delivery.
Any subsequent read failure stops rather than returning a healthy default.

`started` means SQL may have executed but no acknowledged completion checkpoint
is available. Ordinary Owner recovery is blocked, including with a fresh token.
Do not infer D1 outcome from pending/counts: a batch may have committed with a
lost response or made no distinguishable data change. Without an atomic D1
operation journal, general recovery of this state requires separately reviewed
reconciliation; this version deliberately provides no flag-clearing bypass.
Known `not_started` probe failures alone allow one authorised new prune.
Known `sql_complete`/unconfirmed completion allows finalisation only, without
rerunning SQL. Unknown protocol versions, malformed/mismatched records and
pre-protocol attempts are quarantined. Even legacy `cleaned` plus pause=false
is not sufficient evidence to synthesise a receipt. Empty legacy storage
is compatible; no D1 migration or namespace replacement is required.
If the initial storage write fails, no prune SQL executes (the read-only due
check may already have executed). Platform alarm
redelivery can still occur, but cannot enter cleanup while paused; failure to
persist the initial guard also prevents entering cleanup on each delivery.
This guarantee concerns cleanup, not normal Session, presence or history reads.

The fixed log events are `chat_retention_paused`,
`chat_retention_pause_write_failed`, `chat_retention_status_unavailable`,
`chat_retention_attempt_write_failed`, `chat_retention_recovery_failed` and
`chat_retention_recovered`. Alert on failure events and corroborate with status.
Storage-unknown status returns 503, never a healthy default. Ordinary HTTP or
heartbeat success does not prove retention health. At the physical cap,
sends may remain 429 until retention is recovered.

## Operator procedure: one approved attempt

1. Record the reviewed/deployed source and environment identity. Verify the
   account -> Worker -> DB binding -> immutable database UUID and CHAT namespace.
   Obtain fresh status through the existing Owner's same-origin Session without
   exporting their cookies. Keep only sanitised status and timestamps as evidence.
2. Diagnose the underlying storage/schema/quota failure first. Check actual D1/DO
   metrics, pending counts and available budget. On quota/10042, identity drift,
   unknown status or ambiguous outcome, STOP. Do not retry a failed write.
3. Obtain explicit Owner approval for **one** recovery POST on this target,
   deployed source and current status token. Use
   `POST /api/chat/moderation/retention` with JSON
   `{"expectedToken":"the-exact-current-token"}`, the normal content type,
   Origin and existing Owner Session. Legacy/null generations cannot clear
   unverified state. A `blocked` action is a hard stop, not another approval slot.
   No HTTP client, proxy or operator script may automatically retry it.
4. The request serially revalidates the live Owner Session and exact token.
   For `finalise`, it consumes the token, preserves the SQL checkpoint and
   completes only the durable confirmation protocol: **zero additional prune**.
   For `prune` (known never-entered-SQL failure), it atomically starts a fresh
   operation/generation and invokes one existing bounded prune.
   Each batch selects at most 10 parents, drains at most
   100 children per dependant table, plus at most 100 standalone expired versions.
   A parent remains pending and hidden until all dependants are drained.
5. On 200, save the sanitised result and read status again. Normal retention
   scheduling is now enabled: it may continue backlog cleanup in later alarms.
   Approval of recovery therefore includes restarting normal retention, not a
   promise that all later alarms stop after this one batch. Verify backlog
   convergence, counter integrity, visibility and actual usage within budget.
6. A 409 means stale token, no longer paused, or unresolved/quarantined operation;
   no recovery prune executes. A newer token cannot change the operation phase.
   A 503 means STOP; read status and inspect metrics before considering any new
   approval. A consumed token cannot execute another batch, including after
   reconstruction. Interrupted or storage-unknown attempts may have completed
   part or all of their atomic D1 batch: do not infer rollback from HTTP alone.
   A fresh token is not permission to try again; each new attempt needs approval
   and a state whose `recoveryAction` permits it.

Never clear flags with ad-hoc SQL, delete namespaces/storage, rerun migrations,
reset counters, or add a retry loop to recover. D1 SQL cannot clear DO storage.
Do not use private recovery metadata as public distribution configuration.

## Staging acceptance checklist

- Capture the deployed commit SHA, fresh migration SQL hashes, complete ledger,
  and reviewed schema/index/FK definitions before running recovery tests against
  isolated staging resources.
- Check physical message count against `chat_retention_state`, floor ordering,
  pending visibility and `foreign_key_check`. Exercise expiry, cap reservation,
  multi-batch parent/child draining and reconstruction using isolated test
  fixtures.
- Exercise failure, durable pause, status/log observability and absence of
  repeated cleanup writes on normal traffic and alarm redelivery. Verify an
  earlier token cannot recover a later pause, same-token concurrent/reconstructed
  replay cannot run twice, one approved recovery batch is bounded, a repeated
  failure stays paused, and a successful recovery reschedules normal cleanup.
- Validate authenticated sessions, revocation/moderation, real HTTP/WebSockets,
  history resynchronisation, playback/timer/presence headers, and actual D1 / DO
  metrics against staging resources you control before production rollout.

## Guard cost and limits

Cloudflare's [SQLite DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
counts KV `put()` keys as rows written and each `setAlarm()` as one row written;
multi-key puts and cached operations are not exempt. Deletes also count as
rows written. DO usage is distinct from D1 usage, but consumes DO storage limits.
The Free limit is 100,000 rows written/day, shared with other DO activity; the
Paid allowance is 50 million/month, then USD 1 per million rows written.

Local API instrumentation (not Cloudflare billing telemetry) measures the causal
protocol as follows; the old column is the pre-causal feature runtime:

| Scenario | Old put calls / keys | New put calls / keys | setAlarm old / new |
|---|---:|---:|---:|
| Two active heartbeats without cleanup, reconstructed between events | 0 / 0 | 0 / 0 | 2 / 2 |
| One expired-version cleanup, active socket | 2 / 4 | 4 / 8 | 1 / 1 |
| Owner finalisation of acknowledged SQL | unsafe fresh-prune path | 3 / 6 | depends on backlog |

The earlier heartbeat optimisation remains intact. At 2,880 active heartbeats/day,
with no cleanup due throughout that day, the pre-optimisation
path projects 5,760 put calls / 11,520 key writes plus 2,880 alarm writes:
**14,400 estimated DO rows written/day** for these operations. The new path
projects zero cleanup puts plus 2,880 alarm writes: **2,880 estimated DO rows
written/day**, an 80% reduction for this model. An active room is not necessarily
a room requiring cleanup. If every heartbeat actually cleans, the causal path
projects 25,920/day (8 keys plus one alarm per round), versus 14,400/day for the
previous 4-key guard. Each successful automatic cleanup/reserve or safe new
Owner batch adds 4 put calls / 8 key writes. Finalisation-only recovery adds
3 calls / 6 keys and no prune. Failure
reassertion adds 1 call / 2 keys, excluding ambiguous commits and platform retries.
There are two extra bounded KV records (one current operation and one receipt),
not an append-only log. Every inspection reads four keys without a healthy cache;
multiple inspections can occur in one event. Normal D1 prune and its limits are
unchanged. These read calls and JSON storage bytes must also be measured remotely.

These are estimated logical API operations mapped to documented pricing, not
measured billed rows or a total bill. They exclude other DO keys, read rows,
deleteAlarm accounting, requests, duration, stored bytes, additional scheduling,
reconnects and D1 operations/index amplification. Empty idle rooms cancel their
alarm; they do not incur 2,880 daily alarms. Actual due cleanup adds read-only D1
probe queries (up to four) before guarded prune; no-op probes replace prune's
existing selection reads. History still invokes no cleanup. Preserve real
staging measurements of rows, retries and quota before cost clearance.

The guards use the atomic multi-key `put(entries)` API described in the
[Cloudflare storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
No automated remote retries, remote acceptance or cost clearance is implied.


## Expired request receipt and retention policy audit behaviour

A stored receipt whose message is no longer visible returns only HTTP 410 with
`request_id_expired`. No message/receipt/counter/send-state write occurs. The
client releases that pending requestId and reports the terminal error without
automatically sending a replacement message. A subsequent explicit send can use
a fresh requestId. Fully purged receipts retain the existing cleanup lifecycle.

Owner policy writes atomically save `updated_by` and append
`chat.retention.update` to `admin_audit_log`, including previous/next policy and
the common timestamp. The audit insert is conditional on the immediately
preceding successful CAS write. CAS conflicts create no audit; any failed audit
insert rolls back policy and actor changes in the same D1 transaction.
