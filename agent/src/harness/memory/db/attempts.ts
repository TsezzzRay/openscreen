import type { DatabaseSync } from "node:sqlite";

export const MODEL_OPERATIONS = [
  "chronicle_summarization",
  "turn_memory_extraction",
  "global_memory_consolidation",
] as const;

export type ModelOperation = typeof MODEL_OPERATIONS[number];
export type AttemptStatus = "succeeded" | "failed" | "cancelled";

export type StartModelAttempt = {
  id: string;
  operation: ModelOperation;
  jobKey: string;
  model: string;
  requestHash: string;
  requestCharacters: number;
  attemptedAt: number;
  inputTokens: number;
};

export type FinishModelAttempt = {
  id: string;
  status: AttemptStatus;
  finishedAt: number;
  outputTokens?: number;
  outputCharacters?: number;
  responseStatus?: string;
  incompleteReason?: string;
  errorCode?: string;
  errorPath?: string;
  errorMessage?: string;
};

export function startModelAttempt(
  connection: DatabaseSync,
  attempt: StartModelAttempt,
) {
  connection.prepare(`
    INSERT INTO model_attempts (
      id, operation, job_key, attempted_at, model, request_hash,
      request_characters, input_tokens, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    attempt.id,
    attempt.operation,
    attempt.jobKey,
    attempt.attemptedAt,
    attempt.model,
    attempt.requestHash,
    attempt.requestCharacters,
    attempt.inputTokens,
  );
}

export function finishModelAttempt(
  connection: DatabaseSync,
  attempt: FinishModelAttempt,
) {
  connection.prepare(`
    UPDATE model_attempts SET
      finished_at = ?, output_tokens = ?, output_characters = ?,
      duration_milliseconds = max(? - attempted_at, 0),
      status = ?, response_status = ?, incomplete_reason = ?,
      error_code = ?, error_path = ?, error_message = ?
    WHERE id = ? AND status = 'running'
  `).run(
    attempt.finishedAt,
    attempt.outputTokens ?? null,
    attempt.outputCharacters ?? null,
    attempt.finishedAt,
    attempt.status,
    attempt.responseStatus ?? null,
    attempt.incompleteReason ?? null,
    attempt.errorCode ?? null,
    attempt.errorPath ?? null,
    attempt.errorMessage ?? null,
    attempt.id,
  );
}
