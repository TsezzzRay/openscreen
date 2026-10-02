import { AppWindow, FileText, ShieldAlert, Terminal } from "lucide-react";

import type { ApplicationEvent, ProductSessionSummary } from "@shared/protocol.ts";

import { Button } from "./Button.tsx";

type ApprovalRequest = Extract<ApplicationEvent, { type: "approval_requested" }>["request"];

const DETAIL_PRE =
  "mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-edge-soft bg-black/30 px-2.5 py-2 font-mono text-caption";

/**
 * Pending tool approvals. Every fact the runtime sends is shown in full — the
 * exact command, path, content, or target application — together with the
 * scope and risk of saying yes, because this card is the only thing between
 * the model and the user's machine.
 */
export function ApprovalPanel({
  requests,
  sessions,
  decisionsInFlight,
  error,
  onDecide,
}: {
  requests: ApprovalRequest[];
  sessions: ProductSessionSummary[];
  decisionsInFlight: string[];
  error?: string | undefined;
  onDecide: (id: string, approved: boolean) => void;
}): React.ReactNode {
  if (requests.length === 0 && error === undefined) return null;
  return (
    <section aria-label="Pending tool approvals" className="flex flex-col gap-3">
      {requests.map(request => {
        const session = sessions.find(item => item.id === request.sessionId);
        const pending = decisionsInFlight.includes(request.id);
        const desktop = request.tool === "desktop_click" || request.tool === "desktop_scroll" || request.tool === "desktop_type";
        const desktopTarget = typeof request.target === "string" ? undefined : request.target;
        const displayTarget = typeof request.target === "string" ? request.target : JSON.stringify(request.target);
        const Icon = request.tool === "bash" ? Terminal : desktop ? AppWindow : FileText;
        return (
          <article key={request.id} className="rounded-xl border border-edge bg-white/[0.035] p-3.5">
            <header className="flex items-start gap-3">
              <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-white/[0.12] text-ink">
                <Icon size={13} strokeWidth={2.2} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-ui font-medium text-ink">Paused for approval · {request.tool === "bash" ? "host command" : request.tool === "desktop_click" ? "desktop click" : request.tool === "desktop_scroll" ? "desktop scroll" : request.tool === "desktop_type" ? "desktop text input" : `${request.tool} file`}</p>
                <p className="truncate text-caption text-ink-dim">{session?.name ?? request.sessionId}</p>
              </div>
            </header>
            <div className="mt-3 pl-[34px]">
              {request.tool === "bash" ? (
                <>
                  <p className="text-caption text-ink-dim">Exact command</p>
                  <pre className={`${DETAIL_PRE} text-ink`}>{displayTarget}</pre>
                  <Warning>Host execution can access files and the network outside the sandbox and make multiple desktop changes. Background tasks started by this command may continue after it returns. Later host commands require separate approval.</Warning>
                </>
              ) : desktop ? (
                <>
                  <p className="text-body text-ink">Application: {desktopTarget?.appName ?? "Unavailable"}</p>
                  <p className="mt-1 break-all font-mono text-caption text-ink-dim">Bundle ID: {desktopTarget?.bundleId ?? "Unavailable (permission limited to this process)"}</p>
                  <p className="mt-0.5 font-mono text-caption text-ink-dim">Current window: {desktopTarget?.windowId ?? "Unavailable"}</p>
                  {request.previewImage === undefined ? null : (
                    <img className="mt-2 max-h-52 max-w-full rounded-lg border border-edge-soft object-contain" alt="Window captured for this approval" src={`data:${request.previewImage.mimeType};base64,${request.previewImage.dataBase64}`} />
                  )}
                  <Warning>Allowing grants click, scroll, and text input in all windows of this application for this chat. Denying blocks further requests for this application in this chat. Desktop tools request background input targeted at a window and never request foreground retries. The target application may activate itself.</Warning>
                </>
              ) : (
                <>
                  <p className="break-all font-mono text-caption text-ink">Exact path: {displayTarget}</p>
                  {request.expectedContent === undefined ? null : (
                    <div className="mt-2">
                      <p className="text-caption text-ink-faint">Current content</p>
                      <pre className={`${DETAIL_PRE} text-ink-dim`}>{request.expectedContent}</pre>
                    </div>
                  )}
                  {request.expectedAbsent ? <p className="mt-2 text-caption text-ink-faint">Target does not exist yet; creation only is approved.</p> : null}
                  <div className="mt-2">
                    <p className="text-caption text-ink-faint">Proposed complete content</p>
                    <pre className={`${DETAIL_PRE} text-ink`}>{request.proposedContent ?? ""}</pre>
                  </div>
                </>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button disabled={pending} onClick={() => onDecide(request.id, false)}>Deny</Button>
                <Button variant="primary" disabled={pending} onClick={() => onDecide(request.id, true)}>{desktop ? "Allow for this chat" : "Approve once"}</Button>
              </div>
            </div>
          </article>
        );
      })}
      {error === undefined ? null : <p role="alert" className="text-caption text-alert">{error}</p>}
    </section>
  );
}

function Warning({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <p className="mt-2 flex gap-2 rounded-lg bg-alert/10 px-2.5 py-2 text-caption text-alert">
      <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
