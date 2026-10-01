import { useState } from "react";

import type { ImportedAttachment } from "@shared/ipc.ts";

import { type ChatTurn, isTurnInFlight } from "../store/types.ts";
import { AttachmentStrip } from "./AttachmentStrip.tsx";
import { Markdown } from "./Markdown.tsx";
import { Spinner } from "./Spinner.tsx";
import { ToolStrip } from "./ToolStrip.tsx";

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const STATUS_LABEL: Record<string, string> = {
  capturing: "reading the screen",
  requesting: "thinking",
  generating: "answering",
  "awaiting-approval": "paused for approval",
};

/**
 * One question and everything that answered it, in the order the run produced
 * it: the question, what the agent did, what it was thinking, then the answer.
 *
 * The left amber rule marks the user's voice. Everything the machine recorded
 * about the run — tool names, token cost, image counts — stays in the mono
 * register so prose and record never blur together.
 *
 * `compact` is the overlay's density: there the answer is the payload and the
 * question is only context, so it recedes.
 */
export function TurnView({
  turn,
  compact = false,
  onRetry,
  onOpenAttachment,
}: {
  turn: ChatTurn;
  compact?: boolean;
  onRetry?: ((id: string) => void) | undefined;
  onOpenAttachment?: ((attachment: ImportedAttachment) => void) | undefined;
}): React.ReactNode {
  const [showReasoning, setShowReasoning] = useState(false);
  const inFlight = isTurnInFlight(turn.status);
  const imageCount = turn.attachments.length + turn.historicalImageCount;

  return (
    <article className={`flex flex-col ${compact ? "gap-2.5" : "gap-3.5"}`}>
      {turn.question.length === 0 ? null : (
        <div className="border-l-2 border-amber pl-3">
          <p
            className={
              compact
                ? "whitespace-pre-wrap text-[12px] leading-[1.5] text-ink-dim"
                : "whitespace-pre-wrap text-[13.5px] leading-[1.55] text-ink"
            }
          >
            {turn.question}
          </p>
          {imageCount === 0 ? null : (
            <p className="mt-1 font-mono text-[10px] text-ink-faint">
              {imageCount} {imageCount === 1 ? "image" : "images"} attached
            </p>
          )}
        </div>
      )}

      {turn.attachments.length === 0 || compact ? null : (
        <div className="pl-3">
          <AttachmentStrip attachments={turn.attachments} onOpen={onOpenAttachment} />
        </div>
      )}

      {turn.toolActivities.length === 0 ? null : (
        <div className="pl-3">
          <ToolStrip activities={turn.toolActivities} />
        </div>
      )}

      {turn.approvals.length === 0 ? null : (
        <ul aria-label="Tool approvals" className="flex flex-col gap-1 pl-3 font-mono text-[10.5px] leading-5 text-ink-dim">
          {turn.approvals.map(approval => (
            <li key={`${approval.id}:${approval.callId}`} className="min-w-0">
              <span className={approval.status === "denied" ? "text-alert" : "text-amber"}>
                {approval.status === "pending" ? inFlight ? "Waiting for approval" : "Approval outcome unknown after run ended"
                  : approval.status === "approved" ? approval.tool.startsWith("desktop_") ? "Application allowed for this chat; action not confirmed" : "Approved once; action not confirmed"
                  : approval.status === "denied" ? approval.tool.startsWith("desktop_") ? "Application denied for this chat; not executed" : "Denied; not executed"
                  : approval.tool === "bash" ? "Approved host command executed"
                  : approval.tool === "desktop_click" ? "Desktop click executed under app approval"
                  : approval.tool === "desktop_scroll" ? "Desktop scroll executed under app approval"
                  : approval.tool === "desktop_type" ? "Desktop text entered under app approval"
                  : "Approved file change committed"}
              </span>
              <span className="text-ink-faint"> · {approval.tool} · </span>
              <code className="break-all whitespace-pre-wrap text-ink-faint">{typeof approval.target === "string" ? approval.target : JSON.stringify(approval.target)}</code>
            </li>
          ))}
        </ul>
      )}

      {turn.reasoning.length === 0 ? null : (
        <div className="pl-3">
          <button
            type="button"
            onClick={() => setShowReasoning((value) => !value)}
            className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-faint hover:text-ink-dim"
            aria-expanded={showReasoning}
          >
            <span aria-hidden>{showReasoning ? "▾" : "▸"}</span>
            reasoning
          </button>
          {showReasoning ? (
            <p className="mt-1.5 max-w-[68ch] whitespace-pre-wrap border-l border-edge pl-3 font-mono text-[11px] leading-[1.6] text-ink-dim">
              {turn.reasoning}
            </p>
          ) : null}
        </div>
      )}

      {turn.answer.length === 0 ? null : (
        <div className="pl-3">
          <Markdown>{turn.answer}</Markdown>
        </div>
      )}

      {inFlight && (turn.answer.length === 0 || turn.status === "awaiting-approval") ? (
        <p className="flex items-center gap-2 pl-3 font-mono text-[11px] text-ink-faint">
          {turn.status === "awaiting-approval" ? null : <Spinner className="text-amber" />}
          {STATUS_LABEL[turn.status] ?? "working"}
        </p>
      ) : null}

      {turn.status === "aborted" ? (
        <p className="pl-3 font-mono text-[11px] text-ink-faint">Stopped.</p>
      ) : null}

      {turn.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-3 pl-3">
          <p className="font-mono text-[11px] text-alert">
            {turn.error ?? "The run did not complete."}
          </p>
          {onRetry === undefined ? null : (
            <button
              type="button"
              onClick={() => onRetry(turn.id)}
              className="font-mono text-[11px] text-amber underline underline-offset-2"
            >
              put it back in the composer
            </button>
          )}
        </div>
      ) : null}

      {turn.contextUsage === undefined || compact ? null : (
        <p className="pl-3 font-mono text-[10px] text-ink-faint">
          {formatTokens(turn.contextUsage.contextTokens)} /{" "}
          {formatTokens(turn.contextUsage.contextWindow)} context
        </p>
      )}
    </article>
  );
}
