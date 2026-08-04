import type { DatabaseSync } from "node:sqlite";

export type AttemptStatus = "succeeded" | "failed" | "cancelled";

export type StartModelAttempt = {
  id: string;
  jobKey: string;
  model: string;
  requestHash: string;
  attemptedAt: number;
  inputTokens: number;
};

export type FinishModelAttempt = {
  id: string;
  status: AttemptStatus;
  finishedAt: number;
  outputTokens?: number;
  error?: string;
};

export function startModelAttempt(
  connection: DatabaseSync,
  stage: "activity" | "consolidation",
  attempt: StartModelAttempt,
) {
  connection.prepare(`
    INSERT INTO model_attempts (
      id, stage, job_key, attempted_at, model, request_hash,
      input_tokens, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    attempt.id,
    stage,
    attempt.jobKey,
    attempt.attemptedAt,
    attempt.model,
    attempt.requestHash,
    attempt.inputTokens,
  );
}

export function finishModelAttempt(
  connection: DatabaseSync,
  attempt: FinishModelAttempt,
) {
  connection.prepare(`
    UPDATE model_attempts SET
      finished_at = ?, output_tokens = ?,
      duration_milliseconds = max(? - attempted_at, 0),
      status = ?, error = ?
    WHERE id = ? AND status = 'running'
  `).run(
    attempt.finishedAt,
    attempt.outputTokens ?? null,
    attempt.finishedAt,
    attempt.status,
    attempt.error ?? null,
    attempt.id,
  );
}
