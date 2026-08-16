export const MEMORY_SCHEMA_VERSION = 4;

export const MEMORY_SCHEMA_V1 = `
CREATE TABLE turn_memory_sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  projection_hash TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1 CHECK (source_generation > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  ingested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX turn_memory_sources_by_session
ON turn_memory_sources(session_id, active, occurred_at, id);

CREATE TABLE turn_memory_session_scans (
  session_id TEXT PRIMARY KEY,
  file_version TEXT NOT NULL,
  last_terminal_entry_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  last_error TEXT,
  scanned_at INTEGER NOT NULL
) STRICT;

CREATE TABLE turn_memory_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provenance_hash TEXT NOT NULL,
  first_pending_at INTEGER NOT NULL,
  last_terminal_at INTEGER NOT NULL,
  eligible_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'sealed')),
  close_reason TEXT CHECK (
    close_reason IS NULL OR close_reason IN (
      'idle', 'hard_cap', 'budget', 'recovery'
    )
  ),
  projected_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (projected_input_tokens >= 0),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (first_pending_at <= last_terminal_at)
) STRICT;

CREATE UNIQUE INDEX one_open_turn_memory_batch_per_session
ON turn_memory_batches(session_id) WHERE status = 'open';

CREATE TABLE turn_memory_batch_sources (
  batch_id TEXT NOT NULL REFERENCES turn_memory_batches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES turn_memory_sources(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (batch_id, source_id),
  UNIQUE (batch_id, ordinal)
) STRICT;

CREATE TABLE memory_jobs (
  job_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('chronicle_summarization', 'turn_memory_extraction')
  ),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'error')
  ),
  eligible_at INTEGER NOT NULL,
  worker_id TEXT,
  ownership_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_remaining INTEGER NOT NULL CHECK (retry_remaining >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  abandonment_count INTEGER NOT NULL DEFAULT 0 CHECK (abandonment_count >= 0),
  UNIQUE (kind, source_id)
) STRICT;

CREATE INDEX memory_jobs_due
ON memory_jobs(kind, status, eligible_at, retry_at, lease_until);

CREATE TABLE turn_memory_extractions (
  job_key TEXT PRIMARY KEY REFERENCES memory_jobs(job_key) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  raw_memory TEXT NOT NULL,
  turn_summary TEXT NOT NULL,
  turn_slug TEXT NOT NULL,
  tasks_json TEXT NOT NULL CHECK (json_valid(tasks_json)),
  generated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE turn_memory_extraction_sources (
  job_key TEXT NOT NULL
    REFERENCES turn_memory_extractions(job_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL
    REFERENCES turn_memory_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_key, source_id)
) STRICT;

CREATE TABLE memory_artifacts (
  artifact_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('turn_rollout', 'chronicle_rollout', 'raw_memories')
  ),
  relative_path TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  projected_at INTEGER
) STRICT;
`;

export const MEMORY_SCHEMA_V2 = `
CREATE TABLE memory_source_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

INSERT INTO memory_source_clock (singleton, watermark) VALUES (1, 0);

CREATE TABLE memory_sources (
  source_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn_memory', 'chronicle')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_updated_at INTEGER NOT NULL UNIQUE CHECK (source_updated_at > 0),
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  artifact_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('user_turn', 'passive_screen')),
  supports_success INTEGER NOT NULL CHECK (supports_success IN (0, 1)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  garbage_collected_at INTEGER,
  generated_at INTEGER NOT NULL,
  CHECK (started_at <= ended_at)
) STRICT;

CREATE INDEX memory_sources_by_activity
ON memory_sources(active, source_updated_at, source_key);

CREATE TABLE consolidation_jobs (
  job_key TEXT PRIMARY KEY CHECK (job_key = 'global'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'error')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 0),
  last_success_watermark INTEGER NOT NULL CHECK (last_success_watermark >= 0),
  claimed_watermark INTEGER,
  processed_watermark INTEGER,
  worker_id TEXT,
  ownership_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_remaining INTEGER NOT NULL CHECK (retry_remaining >= 0),
  abandonment_count INTEGER NOT NULL DEFAULT 0 CHECK (abandonment_count >= 0),
  last_error TEXT
) STRICT;

INSERT INTO consolidation_jobs (
  job_key, status, input_watermark, last_success_watermark, retry_remaining
) VALUES ('global', 'done', 0, 0, 0);

CREATE TABLE consolidation_source_baseline (
  source_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn_memory', 'chronicle')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_updated_at INTEGER NOT NULL CHECK (source_updated_at > 0),
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  artifact_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('user_turn', 'passive_screen')),
  supports_success INTEGER NOT NULL CHECK (supports_success IN (0, 1)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  generated_at INTEGER NOT NULL,
  CHECK (started_at <= ended_at)
) STRICT;

CREATE TABLE consolidation_inputs (
  ownership_token TEXT NOT NULL,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn_memory', 'chronicle')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_updated_at INTEGER NOT NULL CHECK (source_updated_at > 0),
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('user_turn', 'passive_screen')),
  supports_success INTEGER NOT NULL CHECK (supports_success IN (0, 1)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  generated_at INTEGER NOT NULL,
  selection_state TEXT NOT NULL CHECK (
    selection_state IN ('added', 'retained', 'removed')
  ),
  PRIMARY KEY (ownership_token, source_key),
  CHECK (started_at <= ended_at)
) STRICT;

CREATE TABLE memory_evidence (
  memory_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  PRIMARY KEY (memory_key, source_key)
) STRICT;

CREATE INDEX memory_evidence_by_source
ON memory_evidence(source_key, memory_key);

CREATE TABLE consolidation_publications (
  job_key TEXT PRIMARY KEY CHECK (job_key = 'global'),
  ownership_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'publishing')),
  staging_name TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  memory_sha256 TEXT NOT NULL,
  summary_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  frozen_watermark INTEGER NOT NULL CHECK (frozen_watermark >= 0),
  processed_watermark INTEGER NOT NULL CHECK (processed_watermark >= 0),
  created_at INTEGER NOT NULL
) STRICT;
`;

export const MEMORY_SCHEMA_V3 = `
CREATE TABLE chronicle_sources (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  projection_hash TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chronicle_windows (
  id TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  eligible_at INTEGER NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (start_at, end_at),
  CHECK (start_at < end_at),
  CHECK (eligible_at >= end_at)
) STRICT;

CREATE TABLE chronicle_window_sources (
  window_id TEXT NOT NULL REFERENCES chronicle_windows(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES chronicle_sources(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (window_id, source_id),
  UNIQUE (window_id, ordinal)
) STRICT;

CREATE TABLE chronicle_summaries (
  job_key TEXT PRIMARY KEY REFERENCES memory_jobs(job_key) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL CHECK (source_updated_at > 0),
  source_summary TEXT NOT NULL,
  generated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chronicle_summary_sources (
  job_key TEXT NOT NULL REFERENCES chronicle_summaries(job_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES chronicle_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_key, source_id)
) STRICT;

CREATE TABLE chronicle_activities (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL REFERENCES chronicle_summaries(job_key) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  application TEXT,
  window_title TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chronicle_activity_sources (
  activity_id TEXT NOT NULL REFERENCES chronicle_activities(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES chronicle_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (activity_id, source_id)
) STRICT;

CREATE TABLE chronicle_ingest_cursors (
  generation_id TEXT PRIMARY KEY,
  last_frame_id INTEGER NOT NULL CHECK (last_frame_id >= 0),
  updated_at INTEGER NOT NULL
) STRICT;
`;

export const MEMORY_SCHEMA_V4 = `
ALTER TABLE chronicle_ingest_cursors
ADD COLUMN completed_at INTEGER;
`;

export const MEMORY_SCHEMA = `${MEMORY_SCHEMA_V1}\n${MEMORY_SCHEMA_V2}\n${MEMORY_SCHEMA_V3}\n${MEMORY_SCHEMA_V4}`;
