# Chat retention: pause, diagnosis and controlled recovery

This procedure describes the feature runtime. It does not authorise a push,
workflow run, migration, deployment or recovery request. Production remains
NO-GO until exact-source hosted checks, real staging acceptance and separate
Owner release approval. The dormant bootstrap runtime has no recovery API.

## State and access

An existing, live **Owner** Session can issue same-origin
`GET /api/chat/moderation/retention`. No additional account, role change, OAuth
configuration or secret is required. Ordinary users, moderators and admins are
refused. The response is `Cache-Control: no-store`:

```json
{"paused":true,"durablePaused":true,"token":"opaque-generation","lastAttempt":{"at":1792195200000,"outcome":"in_progress"}}
```

`token` is a concurrency guard, not an authentication credential. It is null
only before an attempt record exists (including legacy paused rooms).
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

Before entering actual prune SQL, including its selections, the coordinator
atomically stores the pause and a new generation. Only successful completion
atomically records its result and clears the pause. Failure or interruption
therefore leaves a durable stop; reconstruction cannot silently resume it.
If acknowledging the final storage write fails, the handler reasserts pause
without repeating SQL. If storage also refuses that write, its state is unknown:
stop and reconcile actual status before acting. A 503 alone never proves rollback
or durable pause. Successful D1 cleanup is not reversed by a storage failure.
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
   `{"expectedToken":"the-exact-current-token"}` (or JSON null for a legacy
   null token), the normal content type, Origin and existing Owner Session.
   No HTTP client, proxy or operator script may automatically retry it.
4. The request serially revalidates the live Owner Session, checks paused state
   and the exact token, durably consumes that token, then invokes exactly one
   existing bounded prune. Each batch selects at most 10 parents, drains at most
   100 children per dependant table, plus at most 100 standalone expired versions.
   A parent remains pending and hidden until all dependants are drained.
5. On 200, save the sanitised result and read status again. Normal retention
   scheduling is now enabled: it may continue backlog cleanup in later alarms.
   Approval of recovery therefore includes restarting normal retention, not a
   promise that all later alarms stop after this one batch. Verify backlog
   convergence, counter integrity, visibility and actual usage within budget.
6. A 409 means stale token or no longer paused; no recovery prune executes.
   A 503 means STOP; read status and inspect metrics before considering any new
   approval. A consumed token cannot execute another batch, including after
   reconstruction. Interrupted or storage-unknown attempts may have completed
   part or all of their atomic D1 batch: do not infer rollback from HTTP alone.
   A fresh token is not permission to try again; each new attempt needs approval.

Never clear flags with ad-hoc SQL, delete namespaces/storage, rerun migrations,
reset counters, or add a retry loop to recover. D1 SQL cannot clear DO storage.
Do not use private recovery metadata as public distribution configuration.

## Real staging acceptance (separately authorised)

- Capture the exact deployed SHA, fresh identity, immutable migration SQL hashes,
  complete ledger and reviewed schema/index/FK definitions. Require a verified
  backup/recovery point and sufficient measured quota. Apply only the exact
  reviewed pending 0029/0030 set once, with its ledger; ambiguous/partial states
  stop. Historical 0029 success does not prove 0030 acceptance.
- Check physical message count against `chat_retention_state`, floor ordering,
  pending visibility and `foreign_key_check`. Exercise expiry, cap reservation,
  multi-batch parent/child draining and reconstruction using approved staging
  fixtures and existing accounts. Do not create additional test accounts.
- Exercise failure, durable pause, status/log observability and absence of
  repeated cleanup writes on normal traffic and alarm redelivery. Prove an
  earlier token cannot recover a later pause, same-token concurrent/reconstructed
  replay cannot run twice, one approved recovery batch is bounded, a repeated
  failure stays paused, and a successful recovery reschedules normal cleanup.
- Fault injection and recovery are themselves separate authorised staging
  mutations. Do not inject failures into Production. Local reconstructed
  fixtures do not prove actual remote eviction/hibernation behaviour.
- Validate two existing authenticated sessions, revocation/moderation, real
  HTTP/WebSockets, history resynchronisation, playback/timer/presence and normal
  headers. Record device/runtime and exact source. Measure actual D1 reads and
  writes, DO storage, CPU, backlog, 429 and reconnect rates; SQLite opcode counts
  and application API calls are not billing measurements.

## Guard cost and limits

Cloudflare's [SQLite DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
counts KV `put()` keys as rows written and each `setAlarm()` as one row written;
multi-key puts and cached operations are not exempt. Deletes also count as
rows written. DO usage is distinct from D1 usage, but consumes DO storage limits.
The Free limit is 100,000 rows written/day, shared with other DO activity; the
Paid allowance is 50 million/month, then USD 1 per million rows written.

Local API instrumentation (not Cloudflare billing telemetry) measured:

| Scenario | Old put calls / keys | New put calls / keys | setAlarm old / new |
|---|---:|---:|---:|
| Two active heartbeats without cleanup, reconstructed between events | 4 / 8 | 0 / 0 | 2 / 2 |
| One expired-version cleanup, active socket | 2 / 4 | 2 / 4 | 1 / 1 |

At 2,880 active heartbeats/day, with no cleanup due throughout that day, the old
path projects 5,760 put calls / 11,520 key writes plus 2,880 alarm writes:
**14,400 estimated DO rows written/day** for these operations. The new path
projects zero cleanup puts plus 2,880 alarm writes: **2,880 estimated DO rows
written/day**, an 80% reduction for this model. An active room is not necessarily
a room requiring cleanup. If every heartbeat actually cleans, the new path still
projects 14,400/day. Each successful automatic cleanup/reserve attempt adds
2 put calls / 4 key writes; manual recovery adds 2 calls / 3 keys. Failure
reassertion adds 1 call / 2 keys, excluding ambiguous commits and platform retries.

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
