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

Before any automatic cleanup SQL, including selection, the coordinator
atomically stores the pause and a new generation. Only successful completion
atomically records its result and clears the pause. Failure or interruption
therefore leaves a durable stop; reconstruction cannot silently resume it.
If acknowledging the final storage write fails, the handler reasserts pause
without repeating SQL. If storage also refuses that write, its state is unknown:
stop and reconcile actual status before acting. A 503 alone never proves rollback
or durable pause. Successful D1 cleanup is not reversed by a storage failure.
If the initial storage write fails, no cleanup SQL executes. Platform alarm
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

The durable write-ahead guarantee adds DO storage writes even to a no-op alarm.
Normal cleanup uses two atomic multi-key put calls, writing four key values.
At one heartbeat per 30 seconds with continuously active sockets, that is about
2,880 cleanups/day, 5,760 put calls and 11,520 key-value writes, before reserve
cleanup and other activity. A successful manual recovery uses two put calls
writing three key values. These are application operation counts, **not** billed
rows or prices. Failure handling can add a further atomic stop write. These
counts exclude status reads, scheduling, Session checks and other DO activity.
History reads do not invoke cleanup; a no-op cleanup still
creates no D1 mutation batch. Monitor the actual storage engine and billing.

The guards use the atomic multi-key `put(entries)` API described in the
[Cloudflare storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
No automated remote retries, remote acceptance or cost clearance is implied.
