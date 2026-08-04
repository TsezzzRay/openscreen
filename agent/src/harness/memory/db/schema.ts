export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_SCHEMA = `
CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('observation', 'turn')),
  source_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  turn_id TEXT,
  occurred_at INTEGER NOT NULL,
  captured_at INTEGER,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  sidecar_path TEXT,
  sidecar_sha256 TEXT,
  sidecar_delete_after INTEGER,
  ingested_at INTEGER NOT NULL,
  CHECK (
    (source_type = 'observation' AND session_id IS NULL AND turn_id IS NULL) OR
    (source_type = 'turn' AND session_id IS NOT NULL AND turn_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE observation_windows (
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

CREATE TABLE observation_window_sources (
  window_id TEXT NOT NULL REFERENCES observation_windows(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (window_id, source_id),
  UNIQUE (window_id, ordinal)
) STRICT;

CREATE TABLE turn_batches (
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

CREATE UNIQUE INDEX one_open_turn_batch_per_session
ON turn_batches(session_id) WHERE status = 'open';

CREATE TABLE turn_batch_sources (
  batch_id TEXT NOT NULL REFERENCES turn_batches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (batch_id, source_id),
  UNIQUE (batch_id, ordinal)
) STRICT;

CREATE TABLE activity_jobs (
  job_key TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('observation_window', 'turn_batch')),
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
  UNIQUE (source_kind, source_id)
) STRICT;

CREATE INDEX activity_jobs_due
ON activity_jobs(status, eligible_at, retry_at, lease_until);

CREATE TABLE activity_summaries (
  job_key TEXT PRIMARY KEY REFERENCES activity_jobs(job_key) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  generated_at INTEGER NOT NULL,
  selected_for_consolidation INTEGER NOT NULL DEFAULT 0
    CHECK (selected_for_consolidation IN (0, 1)),
  selected_for_consolidation_source_updated_at INTEGER
) STRICT;

CREATE TABLE activity_summary_sources (
  job_key TEXT NOT NULL REFERENCES activity_summaries(job_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_key, source_id)
) STRICT;

CREATE TABLE activity_records (
  id TEXT PRIMARY KEY,
  activity_job_key TEXT NOT NULL REFERENCES activity_summaries(job_key) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('observed', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  summary TEXT NOT NULL,
  application TEXT,
  window_title TEXT,
  entities_json TEXT NOT NULL CHECK (json_valid(entities_json)),
  verbatim_evidence_json TEXT NOT NULL CHECK (json_valid(verbatim_evidence_json)),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json))
) STRICT;

CREATE TABLE activity_record_sources (
  activity_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
  PRIMARY KEY (activity_id, source_id)
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
  job_key TEXT NOT NULL REFERENCES activity_summaries(job_key) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('observation_window', 'turn_batch')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_updated_at INTEGER NOT NULL,
  source_summary TEXT NOT NULL,
  raw_memory TEXT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (ownership_token, job_key)
) STRICT;

CREATE TABLE model_attempts (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('activity', 'consolidation')),
  job_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  duration_milliseconds INTEGER CHECK (
    duration_milliseconds IS NULL OR duration_milliseconds >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  error TEXT
) STRICT;

CREATE INDEX model_attempts_by_job ON model_attempts(stage, job_key, attempted_at);

CREATE TABLE memory_evidence (
  memory_key TEXT NOT NULL,
  activity_job_key TEXT NOT NULL REFERENCES activity_summaries(job_key) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE RESTRICT,
  PRIMARY KEY (memory_key, activity_job_key, source_id)
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
