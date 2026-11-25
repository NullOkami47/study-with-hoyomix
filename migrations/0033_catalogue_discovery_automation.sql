-- Unattended discovery round-trip state. The published catalogue schema is unchanged:
-- these tables only record which sheet rows an automated cycle has already handled and
-- what each cycle did. Review authority still lives in catalogue_import_batches, and an
-- automated publication is recorded in admin_audit_log with a NULL actor so it can never
-- be mistaken for a human approval.

-- Exactly-once ledger for the sheet round trip. The composite primary key makes a claim
-- atomic, so a retried, concurrent or overlapping cycle cannot export the same candidate
-- twice or apply the same classification row twice. `tab` is the automation tab name and
-- `row_key` is a content-derived key, so an agent editing a row yields a new key and the
-- corrected row is reprocessed while an untouched row is never reapplied.
CREATE TABLE catalogue_discovery_automation_rows (
 tab TEXT NOT NULL CHECK(tab IN ('Discoveries','Suggestions')),
 row_key TEXT NOT NULL CHECK(length(row_key) BETWEEN 1 AND 200),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
 PRIMARY KEY(tab,row_key)
) STRICT;
CREATE INDEX idx_catalogue_discovery_automation_rows_created
 ON catalogue_discovery_automation_rows(created_at);

-- Cycle history for the Admin view and for making a silent external agent visible.
-- `published_revision` is non-NULL only when that cycle actually advanced the catalogue.
CREATE TABLE catalogue_discovery_automation_cycles (
 cycle_id TEXT PRIMARY KEY,
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 finished_at INTEGER NOT NULL CHECK(finished_at>=0),
 outcome TEXT NOT NULL CHECK(outcome IN ('completed','skipped','failed','stale')),
 phases_json TEXT NOT NULL CHECK(json_valid(phases_json)),
 published_revision INTEGER CHECK(published_revision IS NULL OR published_revision>=1)
) STRICT;
CREATE INDEX idx_catalogue_discovery_automation_cycles_started
 ON catalogue_discovery_automation_cycles(started_at);

-- Exact server-created staging authority, reserved BEFORE the external append.
-- A lifecycle revision reservation is not a human approval. Only staged candidates
-- with unchanged evidence may consume a plan. Terminal rows are never rearmed.
CREATE TABLE catalogue_discovery_automation_stages (
 candidate_id TEXT PRIMARY KEY REFERENCES catalogue_discovery_candidates(candidate_id),
 candidate_revision INTEGER NOT NULL CHECK(candidate_revision>=1),
 candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 base_revision INTEGER NOT NULL CHECK(base_revision>=1),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','published','superseded')),
 published_batch_id TEXT REFERENCES catalogue_import_batches(batch_id),
 published_revision INTEGER CHECK(published_revision IS NULL OR published_revision>=1),
 published_at INTEGER CHECK(published_at IS NULL OR published_at>=0),
 CHECK((status='published' AND published_batch_id IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL)
   OR (status IN ('recorded','superseded') AND published_batch_id IS NULL AND published_revision IS NULL AND published_at IS NULL))
) STRICT;
CREATE INDEX idx_catalogue_discovery_automation_stages_status
 ON catalogue_discovery_automation_stages(status,created_at,candidate_id);