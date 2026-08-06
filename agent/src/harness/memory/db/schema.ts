export const MEMORY_SCHEMA_VERSION = 4;

export const MEMORY_SCHEMA = `
CREATE TABLE chronicle_sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  structured_path TEXT,
  structured_sha256 TEXT,
  screenshot_path TEXT,
  screenshot_sha256 TEXT,
  structured_delete_after INTEGER,
  screenshot_delete_after INTEGER,
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
  source_id TEXT NOT NULL REFERENCES chronicle_sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (window_id, source_id),
  UNIQUE (window_id, ordinal)
) STRICT;

CREATE TABLE turn_memory_sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  ingested_at INTEGER NOT NULL,
  UNIQUE (session_id, turn_id)
) STRICT;

CREATE TABLE turn_memory_session_scans (
  session_id TEXT PRIMARY KEY,
  file_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  includes_interrupted INTEGER NOT NULL CHECK (includes_interrupted IN (0, 1)),
  last_error TEXT,
  scanned_at INTEGER NOT NULL
) STRICT;

CREATE TABLE turn_memory_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  first_pending_at INTEGER NOT NULL,
  last_terminal_at INTEGER NOT NULL,
  eligible_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'sealed')),
  close_reason TEXT CHECK (
    close_reason IS NULL OR close_reason IN ('idle', 'hard_cap', 'budget', 'recovery')
  ),
  projected_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (projected_input_tokens >= 0),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_open_turn_memory_batch_per_session
ON turn_memory_batches(session_id) WHERE status = 'open';

CREATE TABLE turn_memory_batch_sources (
  batch_id TEXT NOT NULL REFERENCES turn_memory_batches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES turn_memory_sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (batch_id, source_id),
  UNIQUE (batch_id, ordinal)
) STRICT;

CREATE TABLE memory_jobs (
  job_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chronicle_summarization', 'turn_memory_extraction')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'error')),
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

CREATE TABLE chronicle_summaries (
  job_key TEXT PRIMARY KEY REFERENCES memory_jobs(job_key) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
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

CREATE TABLE turn_memory_extractions (
  job_key TEXT PRIMARY KEY REFERENCES memory_jobs(job_key) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  raw_memory TEXT NOT NULL,
  turn_summary TEXT NOT NULL,
  turn_slug TEXT NOT NULL,
  generated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE turn_memory_extraction_sources (
  job_key TEXT NOT NULL REFERENCES turn_memory_extractions(job_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES turn_memory_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_key, source_id)
) STRICT;

CREATE TABLE consolidation_jobs (
  job_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'error')),
  worker_id TEXT,
  ownership_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_remaining INTEGER NOT NULL CHECK (retry_remaining >= 0),
  last_error TEXT,
  input_watermark INTEGER NOT NULL DEFAULT 0,
  last_success_watermark INTEGER NOT NULL DEFAULT 0,
  abandonment_count INTEGER NOT NULL DEFAULT 0 CHECK (abandonment_count >= 0),
  CHECK (job_key = 'global')
) STRICT;

CREATE TABLE consolidation_inputs (
  ownership_token TEXT NOT NULL,
  job_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('chronicle', 'turn_memory')),
  source_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('passive_screen', 'user_turn')),
  selection_state TEXT NOT NULL CHECK (selection_state IN ('added', 'retained', 'removed')),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (ownership_token, job_key)
) STRICT;

CREATE TABLE consolidation_source_baseline (
  job_key TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('chronicle', 'turn_memory')),
  source_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('passive_screen', 'user_turn')),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  generated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE model_attempts (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN (
    'chronicle_summarization',
    'turn_memory_extraction',
    'global_memory_consolidation'
  )),
  job_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_characters INTEGER NOT NULL CHECK (request_characters >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  output_characters INTEGER CHECK (output_characters IS NULL OR output_characters >= 0),
  duration_milliseconds INTEGER CHECK (
    duration_milliseconds IS NULL OR duration_milliseconds >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  response_status TEXT,
  incomplete_reason TEXT,
  error_code TEXT,
  error_path TEXT,
  error_message TEXT
) STRICT;

CREATE INDEX model_attempts_by_job ON model_attempts(operation, job_key, attempted_at);

CREATE TABLE memory_evidence (
  memory_key TEXT NOT NULL,
  memory_source_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (memory_key, memory_source_id, source_id)
) STRICT;

CREATE TABLE consolidation_publications (
  job_key TEXT PRIMARY KEY,
  ownership_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'publishing')),
  staging_name TEXT NOT NULL,
  memory_sha256 TEXT NOT NULL,
  summary_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  CHECK (job_key = 'global')
) STRICT;
`;
