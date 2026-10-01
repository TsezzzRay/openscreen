import { randomUUID } from "node:crypto";
import type { AgentApprovalRequest } from "../agent/api.js";

export type ApprovalTool = "bash" | "write" | "edit" | "desktop_click" | "desktop_scroll" | "desktop_type";

export type ApprovalRequest = AgentApprovalRequest;

type RequestInput = Omit<ApprovalRequest, "id"> & { signal?: AbortSignal };
type ApprovalDecision = { approved: boolean; reason: "approved" | "denied" | "cancelled" };
type Pending = { request: ApprovalRequest; settle: (decision: ApprovalDecision) => void };

export class ApprovalCoordinator {
  private readonly requests = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly onChange?: (requests: ApprovalRequest[]) => void) {}

  pending(): ApprovalRequest[] {
    return [...this.requests.values()].map(({ request }) => ({ ...request }));
  }

  request(input: RequestInput): { id: string; result: Promise<boolean>; decision: Promise<ApprovalDecision> } {
    if (this.closed) throw new Error("Approval coordinator is closed");
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      callId: input.callId,
      tool: input.tool,
      target: input.target,
      ...(input.previewImage === undefined ? {} : { previewImage: input.previewImage }),
      ...(input.proposedContent === undefined ? {} : { proposedContent: input.proposedContent }),
      ...(input.expectedContent === undefined ? {} : { expectedContent: input.expectedContent }),
      ...(input.expectedAbsent === undefined ? {} : { expectedAbsent: input.expectedAbsent }),
    };
    let settle!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>(resolve => {
      settle = outcome => {
        input.signal?.removeEventListener("abort", onAbort);
        this.requests.delete(request.id);
        resolve(outcome);
        try { this.onChange?.(this.pending()); } catch { /* UI listeners cannot affect authorization. */ }
      };
    });
    const result = decision.then(outcome => outcome.approved);
    const onAbort = () => this.settle(request.id, { approved: false, reason: "cancelled" });
    this.requests.set(request.id, { request, settle });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    else {
      try { this.onChange?.(this.pending()); } catch { /* UI listeners cannot affect authorization. */ }
    }
    return { id: request.id, result, decision };
  }

  decide(id: string, approved: boolean): boolean {
    return this.settle(id, { approved, reason: approved ? "approved" : "denied" });
  }

  private settle(id: string, decision: ApprovalDecision): boolean {
    const pending = this.requests.get(id);
    if (!pending) return false;
    pending.settle(decision);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.requests.keys()]) this.settle(id, { approved: false, reason: "cancelled" });
  }
}
