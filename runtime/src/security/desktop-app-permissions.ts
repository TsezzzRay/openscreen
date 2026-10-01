import type { DesktopAppIdentity } from "../desktop/api.js";
export type { DesktopAppIdentity } from "../desktop/api.js";

type Permission = "allowed" | "denied";
type Decision = { permission: Permission; approvalId?: string };

export class DesktopAppPermissions {
  private readonly bySession = new Map<string, Map<string, Decision>>();

  state(sessionId: string, app: DesktopAppIdentity): Permission | "unknown" {
    return this.bySession.get(sessionId)?.get(this.key(app))?.permission ?? "unknown";
  }

  approvalId(sessionId: string, app: DesktopAppIdentity): string | undefined {
    return this.bySession.get(sessionId)?.get(this.key(app))?.approvalId;
  }

  decide(sessionId: string, app: DesktopAppIdentity, approved: boolean, approvalId?: string): void {
    let permissions = this.bySession.get(sessionId);
    if (permissions === undefined) {
      permissions = new Map();
      this.bySession.set(sessionId, permissions);
    }
    const key = this.key(app);
    if (!permissions.has(key)) permissions.set(key, {
      permission: approved ? "allowed" : "denied",
      ...(approved && approvalId !== undefined ? { approvalId } : {}),
    });
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private key(app: DesktopAppIdentity): string {
    return app.bundleId ? `bundle:${app.bundleId}` : `process:${app.pid}`;
  }
}
