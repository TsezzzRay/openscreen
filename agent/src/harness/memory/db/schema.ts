export const MEMORY_SCHEMA_VERSION = 5;

export const MEMORY_SCHEMA_V4 = `
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

export const MEMORY_RETRIEVAL_SCHEMA = `
CREATE TABLE retrieval_long_term_memories (
  memory_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN (
    'global', 'application', 'web_domain', 'document', 'project',
    'workflow', 'person', 'organization', 'topic'
  )),
  scope_key TEXT,
  content TEXT NOT NULL,
  memory_source_ids_json TEXT NOT NULL CHECK (json_valid(memory_source_ids_json)),
  published_at INTEGER NOT NULL,
  CHECK (scope_type = 'global' OR scope_key IS NOT NULL)
) STRICT;

CREATE TABLE retrieval_index_state (
  name TEXT PRIMARY KEY CHECK (name = 'long_term_memory'),
  content_sha256 TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE retrieval_documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'screen_observation', 'chronicle_activity', 'chronicle_summary',
    'turn_summary', 'long_term_memory'
  )),
  document_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ended_at INTEGER,
  generated_at INTEGER NOT NULL,
  application TEXT,
  window_title TEXT,
  title TEXT,
  content TEXT NOT NULL,
  details TEXT,
  UNIQUE (kind, document_id)
) STRICT;

CREATE INDEX retrieval_documents_recent
ON retrieval_documents(occurred_at DESC, kind, document_id);

CREATE INDEX retrieval_documents_application
ON retrieval_documents(application, occurred_at DESC);

CREATE VIRTUAL TABLE retrieval_documents_fts USING fts5(
  application,
  window_title,
  title,
  content,
  details,
  content = 'retrieval_documents',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER retrieval_documents_after_insert
AFTER INSERT ON retrieval_documents BEGIN
  INSERT INTO retrieval_documents_fts(
    rowid, application, window_title, title, content, details
  ) VALUES (
    new.id, new.application, new.window_title, new.title, new.content, new.details
  );
END;

CREATE TRIGGER retrieval_documents_after_delete
AFTER DELETE ON retrieval_documents BEGIN
  INSERT INTO retrieval_documents_fts(
    retrieval_documents_fts, rowid,
    application, window_title, title, content, details
  ) VALUES (
    'delete', old.id,
    old.application, old.window_title, old.title, old.content, old.details
  );
END;

CREATE TRIGGER retrieval_documents_after_update
AFTER UPDATE ON retrieval_documents BEGIN
  INSERT INTO retrieval_documents_fts(
    retrieval_documents_fts, rowid,
    application, window_title, title, content, details
  ) VALUES (
    'delete', old.id,
    old.application, old.window_title, old.title, old.content, old.details
  );
  INSERT INTO retrieval_documents_fts(
    rowid, application, window_title, title, content, details
  ) VALUES (
    new.id, new.application, new.window_title, new.title, new.content, new.details
  );
END;

CREATE TRIGGER chronicle_sources_retrieval_after_insert
AFTER INSERT ON chronicle_sources BEGIN
  INSERT INTO retrieval_documents (
    kind, document_id, occurred_at, generated_at,
    application, window_title, title, content, details
  ) VALUES (
    'screen_observation',
    new.id,
    new.occurred_at,
    new.captured_at,
    json_extract(new.projection_json, '$.application.name'),
    json_extract(new.projection_json, '$.windowTitle'),
    NULL,
    coalesce(json_extract(new.projection_json, '$.visibleText'), ''),
    trim(
      coalesce(json_extract(new.projection_json, '$.focusedElement.value'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.title'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.identifier'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.description'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.url'), ''),
      char(10)
    )
  );
END;

CREATE TRIGGER chronicle_sources_retrieval_after_update
AFTER UPDATE OF projection_json, occurred_at, captured_at ON chronicle_sources BEGIN
  UPDATE retrieval_documents SET
    occurred_at = new.occurred_at,
    generated_at = new.captured_at,
    application = json_extract(new.projection_json, '$.application.name'),
    window_title = json_extract(new.projection_json, '$.windowTitle'),
    content = coalesce(json_extract(new.projection_json, '$.visibleText'), ''),
    details = trim(
      coalesce(json_extract(new.projection_json, '$.focusedElement.value'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.title'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.identifier'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.focusedElement.description'), '') || char(10) ||
      coalesce(json_extract(new.projection_json, '$.url'), ''),
      char(10)
    )
  WHERE kind = 'screen_observation' AND document_id = new.id;
END;

CREATE TRIGGER chronicle_sources_retrieval_after_delete
AFTER DELETE ON chronicle_sources BEGIN
  DELETE FROM retrieval_documents
  WHERE kind = 'screen_observation' AND document_id = old.id;
END;

CREATE TRIGGER chronicle_activities_retrieval_after_insert
AFTER INSERT ON chronicle_activities BEGIN
  INSERT INTO retrieval_documents (
    kind, document_id, occurred_at, generated_at,
    application, window_title, title, content, details
  ) VALUES (
    'chronicle_activity', new.id, new.occurred_at, new.created_at,
    new.application, new.window_title, NULL, new.summary, NULL
  );
END;

CREATE TRIGGER chronicle_activities_retrieval_after_update
AFTER UPDATE ON chronicle_activities BEGIN
  UPDATE retrieval_documents SET
    occurred_at = new.occurred_at,
    generated_at = new.created_at,
    application = new.application,
    window_title = new.window_title,
    content = new.summary
  WHERE kind = 'chronicle_activity' AND document_id = new.id;
END;

CREATE TRIGGER chronicle_activities_retrieval_after_delete
AFTER DELETE ON chronicle_activities BEGIN
  DELETE FROM retrieval_documents
  WHERE kind = 'chronicle_activity' AND document_id = old.id;
END;

CREATE TRIGGER chronicle_summaries_retrieval_after_insert
AFTER INSERT ON chronicle_summaries BEGIN
  INSERT INTO retrieval_documents (
    kind, document_id, occurred_at, ended_at, generated_at,
    application, window_title, title, content, details
  ) SELECT
    'chronicle_summary', new.job_key, w.start_at, w.end_at, new.generated_at,
    NULL, NULL, NULL, new.source_summary, NULL
  FROM memory_jobs j
  JOIN chronicle_windows w ON w.id = j.source_id
  WHERE j.job_key = new.job_key;
END;

CREATE TRIGGER chronicle_summaries_retrieval_after_update
AFTER UPDATE ON chronicle_summaries BEGIN
  UPDATE retrieval_documents SET
    generated_at = new.generated_at,
    content = new.source_summary
  WHERE kind = 'chronicle_summary' AND document_id = new.job_key;
END;

CREATE TRIGGER chronicle_summaries_retrieval_after_delete
AFTER DELETE ON chronicle_summaries BEGIN
  DELETE FROM retrieval_documents
  WHERE kind = 'chronicle_summary' AND document_id = old.job_key;
END;

CREATE TRIGGER turn_memory_extractions_retrieval_after_insert
AFTER INSERT ON turn_memory_extractions BEGIN
  INSERT INTO retrieval_documents (
    kind, document_id, occurred_at, ended_at, generated_at,
    application, window_title, title, content, details
  ) SELECT
    'turn_summary', new.job_key, b.first_pending_at, b.last_terminal_at,
    new.generated_at, NULL, NULL, new.turn_slug, new.turn_summary, new.raw_memory
  FROM memory_jobs j
  JOIN turn_memory_batches b ON b.id = j.source_id
  WHERE j.job_key = new.job_key;
END;

CREATE TRIGGER turn_memory_extractions_retrieval_after_update
AFTER UPDATE ON turn_memory_extractions BEGIN
  UPDATE retrieval_documents SET
    generated_at = new.generated_at,
    title = new.turn_slug,
    content = new.turn_summary,
    details = new.raw_memory
  WHERE kind = 'turn_summary' AND document_id = new.job_key;
END;

CREATE TRIGGER turn_memory_extractions_retrieval_after_delete
AFTER DELETE ON turn_memory_extractions BEGIN
  DELETE FROM retrieval_documents
  WHERE kind = 'turn_summary' AND document_id = old.job_key;
END;

CREATE TRIGGER retrieval_long_term_memories_after_insert
AFTER INSERT ON retrieval_long_term_memories BEGIN
  INSERT INTO retrieval_documents (
    kind, document_id, occurred_at, generated_at,
    application, window_title, title, content, details
  ) VALUES (
    'long_term_memory', new.memory_key, new.published_at, new.published_at,
    CASE WHEN new.scope_type = 'application' THEN new.scope_key ELSE NULL END,
    NULL,
    new.title,
    new.content,
    new.scope_type || coalesce(':' || new.scope_key, '')
  );
END;

CREATE TRIGGER retrieval_long_term_memories_after_update
AFTER UPDATE ON retrieval_long_term_memories BEGIN
  UPDATE retrieval_documents SET
    occurred_at = new.published_at,
    generated_at = new.published_at,
    application = CASE
      WHEN new.scope_type = 'application' THEN new.scope_key ELSE NULL
    END,
    title = new.title,
    content = new.content,
    details = new.scope_type || coalesce(':' || new.scope_key, '')
  WHERE kind = 'long_term_memory' AND document_id = new.memory_key;
END;

CREATE TRIGGER retrieval_long_term_memories_after_delete
AFTER DELETE ON retrieval_long_term_memories BEGIN
  DELETE FROM retrieval_documents
  WHERE kind = 'long_term_memory' AND document_id = old.memory_key;
END;

INSERT INTO retrieval_documents (
  kind, document_id, occurred_at, generated_at,
  application, window_title, title, content, details
)
SELECT
  'screen_observation',
  id,
  occurred_at,
  captured_at,
  json_extract(projection_json, '$.application.name'),
  json_extract(projection_json, '$.windowTitle'),
  NULL,
  coalesce(json_extract(projection_json, '$.visibleText'), ''),
  trim(
    coalesce(json_extract(projection_json, '$.focusedElement.value'), '') || char(10) ||
    coalesce(json_extract(projection_json, '$.focusedElement.title'), '') || char(10) ||
    coalesce(json_extract(projection_json, '$.focusedElement.identifier'), '') || char(10) ||
    coalesce(json_extract(projection_json, '$.focusedElement.description'), '') || char(10) ||
    coalesce(json_extract(projection_json, '$.url'), ''),
    char(10)
  )
FROM chronicle_sources;

INSERT INTO retrieval_documents (
  kind, document_id, occurred_at, generated_at,
  application, window_title, title, content, details
)
SELECT
  'chronicle_activity', id, occurred_at, created_at,
  application, window_title, NULL, summary, NULL
FROM chronicle_activities;

INSERT INTO retrieval_documents (
  kind, document_id, occurred_at, ended_at, generated_at,
  application, window_title, title, content, details
)
SELECT
  'chronicle_summary', s.job_key, w.start_at, w.end_at, s.generated_at,
  NULL, NULL, NULL, s.source_summary, NULL
FROM chronicle_summaries s
JOIN memory_jobs j ON j.job_key = s.job_key
JOIN chronicle_windows w ON w.id = j.source_id;

INSERT INTO retrieval_documents (
  kind, document_id, occurred_at, ended_at, generated_at,
  application, window_title, title, content, details
)
SELECT
  'turn_summary', e.job_key, b.first_pending_at, b.last_terminal_at,
  e.generated_at, NULL, NULL, e.turn_slug, e.turn_summary, e.raw_memory
FROM turn_memory_extractions e
JOIN memory_jobs j ON j.job_key = e.job_key
JOIN turn_memory_batches b ON b.id = j.source_id;
`;

export const MEMORY_SCHEMA = `${MEMORY_SCHEMA_V4}${MEMORY_RETRIEVAL_SCHEMA}`;
