import {
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  RotateCcw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { ImportedAttachment } from "@shared/ipc.ts";

import { type ApprovalActivity, type ChatTurn, isTurnInFlight } from "../store/types.ts";
import { AttachmentStrip } from "./AttachmentStrip.tsx";
import { Markdown } from "./Markdown.tsx";
import { Spinner } from "./Spinner.tsx";
import { ToolStrip } from "./ToolStrip.tsx";

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const STATUS_LABEL: Record<string, string> = {
  capturing: "Reading the screen",
  requesting: "Thinking",
  generating: "Answering",
  "awaiting-approval": "Paused for approval",
};

function approvalLabel(approval: ApprovalActivity, inFlight: boolean): string {
  if (approval.status === "pending") {
    return inFlight ? "Waiting for approval" : "Approval outcome unknown after run ended";
  }
  if (approval.status === "approved") {
    return approval.tool.startsWith("desktop_")
      ? "Application allowed for this chat; action not confirmed"
      : "Approved once; action not confirmed";
  }
  if (approval.status === "denied") {
    return approval.tool.startsWith("desktop_")
      ? "Application denied for this chat; not executed"
      : "Denied; not executed";
  }
  if (approval.tool === "bash") return "Approved host command executed";
  if (approval.tool === "desktop_click") return "Desktop click executed under app approval";
  if (approval.tool === "desktop_scroll") return "Desktop scroll executed under app approval";
  if (approval.tool === "desktop_type") return "Desktop text entered under app approval";
  return "Approved file change committed";
}

function approvalIcon(approval: ApprovalActivity, inFlight: boolean): LucideIcon | undefined {
  if (approval.status === "pending") return inFlight ? undefined : CircleHelp;
  if (approval.status === "approved") return ShieldCheck;
  if (approval.status === "denied") return Ban;
  return CircleCheck;
}

/**
 * One question and everything that answered it, in the order the run produced
 * it: the question, what the agent did, what it was thinking, then the answer.
 *
 * The main window lays a turn out as a conversation — the question in a bubble
 * on the right, the answer as open prose beside the agent's mark. `compact` is
 * the overlay's density, where a turn is one card and the question is only its
 * heading.
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
  const imageLabel =
    imageCount === 0 ? null : `${imageCount} ${imageCount === 1 ? "image" : "images"} attached`;

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      {turn.toolActivities.length === 0 ? null : <ToolStrip activities={turn.toolActivities} />}

      {turn.approvals.length === 0 ? null : (
        <ul aria-label="Tool approvals" className="flex flex-col gap-1">
          {turn.approvals.map((approval) => {
            const Icon = approvalIcon(approval, inFlight);
            const negative = approval.status === "denied";
            return (
              <li
                key={`${approval.id}:${approval.callId}`}
                className="flex min-w-0 items-start gap-2 text-caption leading-5"
              >
                <span className={`mt-0.5 shrink-0 ${negative ? "text-alert" : "text-ink-dim"}`}>
                  {Icon === undefined ? (
                    <Spinner size={13} className="text-signal" />
                  ) : (
                    <Icon size={13} strokeWidth={2.2} aria-hidden />
                  )}
                </span>
                <span className="min-w-0">
                  <span className={negative ? "text-alert" : "text-ink"}>
                    {approvalLabel(approval, inFlight)}
                  </span>
                  <span className="text-ink-faint"> · {approval.tool} · </span>
                  <code className="break-all whitespace-pre-wrap font-mono text-ink-faint">
                    {typeof approval.target === "string" ? approval.target : JSON.stringify(approval.target)}
                  </code>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {turn.reasoning.length === 0 ? null : (
        <div>
          <button
            type="button"
            onClick={() => setShowReasoning((value) => !value)}
            className="inline-flex items-center gap-1 text-caption text-ink-faint transition-colors hover:text-ink-dim"
            aria-expanded={showReasoning}
          >
            <ChevronRight
              size={13}
              strokeWidth={2.2}
              className={`transition-transform ${showReasoning ? "rotate-90" : ""}`}
              aria-hidden
            />
            Reasoning
          </button>
          {showReasoning ? (
            <p className="mt-1.5 max-w-[68ch] whitespace-pre-wrap border-l border-edge pl-3 text-body text-ink-dim">
              {turn.reasoning}
            </p>
          ) : null}
        </div>
      )}

      {turn.answer.length === 0 ? null : <Markdown>{turn.answer}</Markdown>}

      {inFlight && (turn.answer.length === 0 || turn.status === "awaiting-approval") ? (
        <p className="flex items-center gap-2 text-body text-ink-dim">
          {turn.status === "awaiting-approval" ? null : <Spinner className="text-signal" />}
          {STATUS_LABEL[turn.status] ?? "Working"}
        </p>
      ) : null}

      {turn.status === "aborted" ? <p className="text-body text-ink-faint">Stopped.</p> : null}

      {turn.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="flex items-center gap-1.5 text-body text-alert">
            <CircleAlert size={14} className="shrink-0" aria-hidden />
            {turn.error ?? "The run did not complete."}
          </p>
          {onRetry === undefined ? null : (
            <button
              type="button"
              onClick={() => onRetry(turn.id)}
              className="inline-flex items-center gap-1 text-body text-ink-dim transition-colors hover:text-ink"
            >
              <RotateCcw size={13} aria-hidden />
              Put back in the composer
            </button>
          )}
        </div>
      ) : null}

      {turn.contextUsage === undefined || compact ? null : (
        <p className="text-caption text-ink-faint">
          {formatTokens(turn.contextUsage.contextTokens)} /{" "}
          {formatTokens(turn.contextUsage.contextWindow)} context
        </p>
      )}
    </div>
  );

  if (compact) {
    return (
      <article className="flex flex-col gap-2.5 rounded-xl border border-edge-soft bg-fill px-4 py-3.5">
        {turn.question.length === 0 ? null : (
          <p className="line-clamp-3 whitespace-pre-wrap text-caption text-ink-dim">
            {turn.question}
            {imageLabel === null ? null : <span className="text-ink-faint"> · {imageLabel}</span>}
          </p>
        )}
        {body}
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-4">
      {turn.question.length === 0 ? null : (
        <div className="flex flex-col items-end gap-1.5">
          <p className="max-w-[78%] whitespace-pre-wrap rounded-[18px] bg-fill-selected px-3.5 py-2 text-ui text-ink">
            {turn.question}
          </p>
          {turn.attachments.length === 0 ? null : (
            <AttachmentStrip attachments={turn.attachments} onOpen={onOpenAttachment} />
          )}
          {imageLabel === null ? null : <p className="text-caption text-ink-faint">{imageLabel}</p>}
        </div>
      )}
      <div className="flex gap-3">
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-edge bg-gradient-to-br from-white/[0.12] to-white/[0.02]"
          aria-hidden
        >
          <span className="size-[7px] rounded-full bg-signal" />
        </span>
        {body}
      </div>
    </article>
  );
}
