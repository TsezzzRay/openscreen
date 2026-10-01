import type { ApplicationEvent, ProductSessionSummary } from "@shared/protocol.ts";

type ApprovalRequest = Extract<ApplicationEvent, { type: "approval_requested" }>["request"];

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
    <section aria-label="Pending tool approvals" className="max-h-[340px] shrink-0 overflow-y-auto border-b border-amber/30 bg-amber/[0.06] px-4 py-3">
      {requests.map(request => {
        const session = sessions.find(item => item.id === request.sessionId);
        const pending = decisionsInFlight.includes(request.id);
        const desktop = request.tool === "desktop_click" || request.tool === "desktop_scroll" || request.tool === "desktop_type";
        const desktopTarget = typeof request.target === "string" ? undefined : request.target;
        const displayTarget = typeof request.target === "string" ? request.target : JSON.stringify(request.target);
        return (
          <article key={request.id} className="mb-3 last:mb-0 rounded-lg border border-amber/30 bg-surface p-3">
            <p className="font-mono text-[11px] text-amber">Paused for approval · {request.tool === "bash" ? "host command" : request.tool === "desktop_click" ? "desktop click" : request.tool === "desktop_scroll" ? "desktop scroll" : request.tool === "desktop_type" ? "desktop text input" : `${request.tool} file`}</p>
            <p className="mt-1 text-[12px] text-ink-dim">{session?.name ?? request.sessionId}</p>
            {request.tool === "bash" ? (
              <>
                <p className="mt-2 font-mono text-[11px] text-ink">Exact command</p>
                <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-[11px] text-ink">{displayTarget}</pre>
                <p className="mt-1 text-[11px] text-alert">Host execution can access files and the network outside the sandbox and make multiple desktop changes. Background tasks started by this command may continue after it returns. Later host commands require separate approval.</p>
              </>
            ) : desktop ? (
              <>
                <p className="mt-2 text-[12px] text-ink">Application: {desktopTarget?.appName ?? "Unavailable"}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-ink-dim">Bundle ID: {desktopTarget?.bundleId ?? "Unavailable (permission limited to this process)"}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-dim">Current window: {desktopTarget?.windowId ?? "Unavailable"}</p>
                {request.previewImage === undefined ? null : (
                  <img className="mt-2 max-h-52 max-w-full object-contain" alt="Window captured for this approval" src={`data:${request.previewImage.mimeType};base64,${request.previewImage.dataBase64}`} />
                )}
                <p className="mt-2 text-[11px] text-alert">Allowing grants click, scroll, and text input in all windows of this application for this chat. Denying blocks further requests for this application in this chat. Desktop tools request background input targeted at a window and never request foreground retries. The target application may activate itself.</p>
              </>
            ) : (
              <>
                <p className="mt-2 break-all font-mono text-[11px] text-ink">Exact path: {displayTarget}</p>
                {request.expectedContent === undefined ? null : (
                  <div className="mt-2">
                    <p className="font-mono text-[10px] text-ink-faint">Current content</p>
                    <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-[10px] text-ink-dim">{request.expectedContent}</pre>
                  </div>
                )}
                {request.expectedAbsent ? <p className="mt-2 font-mono text-[10px] text-ink-faint">Target does not exist yet; creation only is approved.</p> : null}
                <div className="mt-2">
                  <p className="font-mono text-[10px] text-ink-faint">Proposed complete content</p>
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-[10px] text-ink">{request.proposedContent ?? ""}</pre>
                </div>
              </>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={pending} onClick={() => onDecide(request.id, false)} className="rounded border border-edge px-2.5 py-1 font-mono text-[11px] text-ink-dim disabled:opacity-50">Deny</button>
              <button type="button" disabled={pending} onClick={() => onDecide(request.id, true)} className="rounded bg-amber px-2.5 py-1 font-mono text-[11px] text-black disabled:opacity-50">{desktop ? "Allow for this chat" : "Approve once"}</button>
            </div>
          </article>
        );
      })}
      {error === undefined ? null : <p role="alert" className="font-mono text-[11px] text-alert">{error}</p>}
    </section>
  );
}
