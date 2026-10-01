import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { FileError, ExecutionError, type AgentTool, type ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { DesktopDriverOptions, DesktopRunContext, DesktopCallContext, DesktopWindowState, DesktopActionTarget, DesktopApprovalTarget, DesktopAuditEvent } from "../desktop/api.js";
import { DesktopActions } from "../desktop/actions.js";
import { createDesktopTools } from "../desktop/tools.js";

import { createAgentTools } from "../agent/pi/tools/create-agent-tools.js";
import { ApprovalCoordinator, type ApprovalRequest, type ApprovalTool } from "./approval-coordinator.js";
import { DesktopAppPermissions, type DesktopAppIdentity } from "./desktop-app-permissions.js";
import { SandboxedFileWriter } from "./sandboxed-file-writer.js";
import { SandboxedToolShell } from "./sandboxed-shell.js";
import type { AgentApprovalTarget, AgentDiagnosticListener, AgentExecutionDiagnostic } from "../agent/api.js";

export type SecurityToolEvent =
  | { type: "security-approval-requested"; request: ApprovalRequest }
  | { type: "security-approval-decided"; id: string; approved: boolean; reason: "approved" | "denied" | "cancelled" }
  | { type: "security-tool-committed"; id: string; callId: string; tool: ApprovalTool; target: AgentApprovalTarget }
  | { type: "security-host-execution-uncertain"; id: string; callId: string; target: string; reason: string }
  | Extract<DesktopAuditEvent, { type: "security-desktop-execution-uncertain" }>;

type ExecutionEvent = Exclude<SecurityToolEvent, { type: "security-approval-requested" | "security-approval-decided" }>;

interface ToolSecurityOptions extends DesktopDriverOptions {
  cwd: string;
  dataRoot: string;
  ownPid?: number;
  desktopAppForPid?: (pid: number, observedAppName?: string) => Promise<DesktopAppIdentity>;
  outputRoot?: string;
  onEvent?: (event: SecurityToolEvent) => void;
}

interface RunContext extends DesktopRunContext {
  sessionId: string;
  outputRoot: string;
  shell: SandboxedToolShell;
  host: NodeExecutionEnv;
  writer: SandboxedFileWriter;
  emit: (event: SecurityToolEvent) => void | Promise<void>;
  diagnose?: AgentDiagnosticListener;
}

interface CallContext extends DesktopCallContext {
  tool: string;
  host: boolean;
  source?: { path: string; content: string };
  receipt?: { event: ExecutionEvent; auditError?: string };
}

export class ToolSecurity {
  readonly approvals = new ApprovalCoordinator();
  readonly tools: AgentTool[];
  private readonly desktopPermissions = new DesktopAppPermissions();
  private readonly runScope = new AsyncLocalStorage<RunContext>();
  private readonly callScope = new AsyncLocalStorage<CallContext>();

  constructor(private readonly options: ToolSecurityOptions) {
    const base = new NodeExecutionEnv({ cwd: options.cwd });
    const env = new Proxy(base, {
      get: (target, property) => {
        if (property === "readTextFile") return async (path: string, signal?: AbortSignal) => {
          const result = await target.readTextFile(path, signal);
          const call = this.callScope.getStore();
          if (result.ok && call?.tool === "edit") call.source = { path: resolve(options.cwd, path), content: result.value };
          return result;
        };
        if (property === "writeFile") return (path: string, content: string | Uint8Array, signal?: AbortSignal) =>
          this.writeFile(path, content, signal);
        if (property === "appendFile") return (path: string, content: string | Uint8Array, signal?: AbortSignal) =>
          this.appendFile(path, content, signal);
        if (property === "createTempFile") return (options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) =>
          this.createTempFile(options);
        if (property === "exec") return (command: string, executionOptions?: Parameters<NodeExecutionEnv["exec"]>[1]) =>
          this.exec(command, executionOptions);
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ExecutionEnv;
    const actions = new DesktopActions(options, {
      run: () => this.runScope.getStore(),
      call: () => this.callScope.getStore(),
      app: (pid, name) => this.desktopApp(pid, name),
      authorize: (state, screenshot, target) => {
        const run = this.runScope.getStore();
        const call = this.callScope.getStore();
        if (!run || !call) throw new Error("Desktop authorization requires an active tool call");
        return this.authorizeDesktopApp(run, call, state, screenshot, target);
      },
      recordOutcome: event => {
        const run = this.runScope.getStore();
        const call = this.callScope.getStore();
        if (!run || !call) throw new Error("Desktop outcome requires an active tool call");
        return this.recordExecution(run, call, event);
      },
    });
    const baseTools = [...createAgentTools(env), ...createDesktopTools(options, actions)];
    this.tools = baseTools.map(tool => ({
      ...tool,
      execute: (...args: Parameters<typeof tool.execute>) => {
        const params = args[1] as Record<string, unknown>;
        const call: CallContext = {
          id: args[0],
          tool: tool.name,
          host: tool.name === "bash" && params.host === true,
          signal: args[2],
        };
        return this.callScope.run(call, async () => {
          try {
            const result = await Reflect.apply(tool.execute, tool, args) as Awaited<ReturnType<typeof tool.execute>>;
            const receipt = call.receipt;
            if (!receipt || receipt.event.type !== "security-tool-committed") return result;
            const event = receipt.event;
            const target = JSON.stringify(event.target);
            const text = event.tool === "bash"
              ? `\nUser approved this one-time host command ${target}; command executed.`
              : typeof event.target !== "string"
                ? `\nUser's conversation-scoped application approval authorized this desktop action ${target}; ${event.target.action} executed, but the intended UI outcome still needs verification.`
                : `\nUser approved this one-time change to ${target}; approved change committed.`;
            return {
              ...result,
              content: [...result.content, { type: "text" as const, text: text + this.auditWarning(receipt) }],
            };
          } catch (error) {
            // Bash reports cancellation at its actual command/approval boundary.
            // Other tools must retain typed cancellation before receipt wrapping.
            const run = this.runScope.getStore();
            if (run && call.tool !== "bash" &&
              (error instanceof FileError || error instanceof ExecutionError) && error.code === "aborted") {
              await this.diagnose(run, { type: "tool-cancelled", callId: call.id });
            }
            const receipt = call.receipt;
            if (!receipt || receipt.event.type === "security-tool-committed" && receipt.event.tool !== "bash") throw error;
            const event = receipt.event;
            const warning = this.auditWarning(receipt);
            const detail = error instanceof Error ? error.message : String(error);
            const target = JSON.stringify(event.target);
            if (event.type === "security-desktop-execution-uncertain") {
              throw new Error(`User's conversation-scoped application approval authorized desktop ${event.target.action} ${target}; it may have run and its effects are unknown. Check side effects before retrying. ${detail}.${warning}`, { cause: error });
            }
            throw new Error(event.type === "security-host-execution-uncertain"
              ? `User approved this one-time host command ${target}; the command may have run and its effects are unknown. Check side effects before retrying. ${detail}.${warning}`
              : `User approved this one-time host command ${target}; command executed but failed: ${detail}.${warning}`, { cause: error });
          }
        });
      },
    })) as AgentTool[];
  }

  private auditWarning(receipt: NonNullable<CallContext["receipt"]>): string {
    return receipt.auditError === undefined ? "" : ` Approval audit commit record failed: ${receipt.auditError}. The side effect is not rolled back.`;
  }

  async prepare(sessionId: string, emit: RunContext["emit"], diagnose?: AgentDiagnosticListener): Promise<{
    outputRoot: string;
    execute: <T>(work: () => Promise<T>) => Promise<T>;
  }> {
    const outputRoot = this.options.outputRoot ?? join(this.options.dataRoot, "task-outputs", randomUUID());
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const shell = new SandboxedToolShell({ cwd: this.options.cwd, outputRoot });
    const host = new NodeExecutionEnv({
      cwd: this.options.cwd,
      shellEnv: {
        ...Object.fromEntries(Object.keys(process.env).map(key => [key, ""])),
        HOME: outputRoot,
        TMPDIR: outputRoot,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    const run: RunContext = { sessionId, outputRoot, shell, host, writer: new SandboxedFileWriter(outputRoot), emit, diagnose };
    return { outputRoot, execute: work => this.runScope.run(run, work) };
  }

  private async request(run: RunContext, call: CallContext, target: AgentApprovalTarget, details: Pick<ApprovalRequest, "proposedContent" | "expectedContent" | "expectedAbsent" | "previewImage"> = {}, onDecision?: (reason: "approved" | "denied" | "cancelled", id: string) => void): Promise<string> {
    const pending = this.approvals.request({
      sessionId: run.sessionId,
      callId: call.id,
      tool: call.tool as ApprovalTool,
      target,
      ...details,
      signal: call.signal,
    });
    const request = this.approvals.pending().find(item => item.id === pending.id);
    try {
      if (request) await this.publish(run, { type: "security-approval-requested", request });
    } catch (error) {
      this.approvals.decide(pending.id, false);
      throw error;
    }
    const decision = await pending.decision;
    await this.diagnose(run, { type: "approval-outcome", approvalId: pending.id, reason: decision.reason });
    if (decision.reason === "denied") onDecision?.(decision.reason, pending.id);
    await this.publish(run, { type: "security-approval-decided", id: pending.id, approved: decision.approved, reason: decision.reason });
    if (decision.reason !== "denied") onDecision?.(decision.reason, pending.id);
    if (decision.reason === "cancelled") throw new ExecutionError("aborted", "Tool approval was aborted");
    if (!decision.approved) throw new Error("User did not approve this tool action");
    return pending.id;
  }

  private async desktopApp(pid: number, fallbackName: string | undefined): Promise<DesktopAppIdentity> {
    const app = this.options.desktopAppForPid === undefined
      ? { pid, appName: fallbackName ?? "Unknown application" }
      : await this.options.desktopAppForPid(pid, fallbackName);
    if (app.pid !== pid || !app.appName || (app.bundleId !== undefined && !app.bundleId)) {
      throw new Error("Desktop application identity is unavailable");
    }
    if (pid === this.options.ownPid || app.bundleId === "com.openscreen.app") {
      throw new Error("OpenScreen's own window cannot be controlled");
    }
    return app;
  }

  private async authorizeDesktopApp(
    run: RunContext,
    call: CallContext,
    state: DesktopWindowState,
    screenshot: { mimeType: string; dataBase64: string },
    actionTarget: DesktopActionTarget,
  ): Promise<{ approvalId: string; target: DesktopApprovalTarget; app: DesktopAppIdentity }> {
    const app = await this.desktopApp(state.pid, state.appName);
    const target: DesktopApprovalTarget = { ...structuredClone(actionTarget),
      scope: "application", appName: app.appName, bundleId: app.bundleId ?? null };
    const permission = this.desktopPermissions.state(run.sessionId, app);
    if (permission === "denied") throw new Error(`User denied desktop access to ${app.appName} for this conversation`);
    if (permission === "allowed") {
      const approvalId = this.desktopPermissions.approvalId(run.sessionId, app);
      if (approvalId === undefined) throw new Error("Desktop approval record is missing");
      return { approvalId, target, app };
    }
    const approvalId = await this.request(run, call, target,
      { previewImage: { mimeType: screenshot.mimeType as "image/png" | "image/jpeg", dataBase64: screenshot.dataBase64 } },
      (reason, id) => {
        if (reason !== "cancelled") this.desktopPermissions.decide(run.sessionId, app, reason === "approved", id);
      });
    return { approvalId, target, app };
  }

  private async writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const run = this.runScope.getStore();
    const call = this.callScope.getStore();
    const target = resolve(this.options.cwd, path);
    if (!run || !call || typeof content !== "string") {
      return { ok: false as const, error: new FileError("permission_denied", "File write lacks a valid task context", target) };
    }
    if (signal?.aborted || call.signal?.aborted) {
      return { ok: false as const, error: new FileError("aborted", "File write was aborted", target) };
    }
    try {
      let ancestor = target;
      const missing: string[] = [];
      let canonicalTarget: string;
      for (;;) {
        try {
          canonicalTarget = join(await realpath(ancestor), ...missing.reverse());
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Write target is a dangling symlink");
          } catch (inspectionError) {
            if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
          }
          const parent = dirname(ancestor);
          if (parent === ancestor) throw error;
          missing.push(basename(ancestor));
          ancestor = parent;
        }
      }
      const inside = canonicalTarget.startsWith(`${await realpath(run.outputRoot)}${sep}`);
      const approvedTarget = inside ? undefined : canonicalTarget;
      let expectedContent = call.tool === "edit" && call.source?.path === target ? call.source.content : undefined;
      let expectedAbsent = false;
      if (call.tool === "edit" && expectedContent === undefined) throw new Error("Edit source was not captured");
      if (!inside && call.tool === "write") {
        try { expectedContent = await readFile(approvedTarget!, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          expectedAbsent = true;
        }
      }
      const approvalId = inside ? undefined : await this.request(run, call, approvedTarget!, {
        proposedContent: content,
        ...(expectedContent === undefined ? {} : { expectedContent }), expectedAbsent,
      });
      if (signal?.aborted || call.signal?.aborted) throw new FileError("aborted", "File write was aborted", target);
      await run.writer.write(canonicalTarget, content, {
        ...(approvalId === undefined ? {} : { approvedPath: approvedTarget }),
        ...(expectedContent === undefined ? {} : { expectedContent }),
        ...(inside ? {} : { expectedAbsent }),
        signal: signal ?? call.signal,
      });
      if (approvalId !== undefined) {
        await this.recordExecution(run, call, { type: "security-tool-committed", id: approvalId,
          callId: call.id, tool: call.tool as ApprovalTool, target: approvedTarget! });
      }
      return { ok: true as const, value: undefined };
    } catch (error) {
      if ((error instanceof FileError || error instanceof ExecutionError) && error.code === "aborted") {
        return { ok: false as const, error: new FileError("aborted", error.message, target, error) };
      }
      return { ok: false as const, error: new FileError("permission_denied", error instanceof Error ? error.message : String(error), target) };
    }
  }

  private async createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) {
    const run = this.runScope.getStore();
    const call = this.callScope.getStore();
    if (!run || !call) return { ok: false as const, error: new FileError("permission_denied", "Temporary file lacks a valid task context") };
    const name = (options?.prefix ?? "") + randomUUID() + (options?.suffix ?? "");
    const path = resolve(run.outputRoot, name);
    if (!path.startsWith(run.outputRoot + sep) || options?.abortSignal?.aborted || call.signal?.aborted) {
      return { ok: false as const, error: new FileError("permission_denied", "Invalid temporary file request", path) };
    }
    try {
      await run.writer.write(path, "", { signal: options?.abortSignal ?? call.signal });
      return { ok: true as const, value: path };
    } catch (error) {
      return { ok: false as const, error: new FileError("permission_denied", error instanceof Error ? error.message : String(error), path) };
    }
  }

  private async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const run = this.runScope.getStore();
    const call = this.callScope.getStore();
    const target = resolve(this.options.cwd, path);
    if (!run || !call || typeof content !== "string" || !target.startsWith(run.outputRoot + sep)) {
      return { ok: false as const, error: new FileError("permission_denied", "Append outside task output is not allowed", target) };
    }
    if (signal?.aborted || call.signal?.aborted) {
      return { ok: false as const, error: new FileError("aborted", "Append was aborted", target) };
    }
    try {
      await run.writer.append(target, content, signal ?? call.signal);
      return { ok: true as const, value: undefined };
    } catch (error) {
      return { ok: false as const, error: new FileError("permission_denied", error instanceof Error ? error.message : String(error), target) };
    }
  }

  private async exec(command: string, executionOptions?: Parameters<NodeExecutionEnv["exec"]>[1]) {
    const run = this.runScope.getStore();
    const call = this.callScope.getStore();
    if (!run || !call) return { ok: false as const, error: new ExecutionError("unknown", "Shell execution lacks a valid task context") };
    try {
      if (call.host) {
        const approvalId = await this.request(run, call, command);
        const result = await this.executeCommand(run, call, command, executionOptions, approvalId);
        if (result.ok) {
          await this.recordExecution(run, call, { type: "security-tool-committed", id: approvalId,
            callId: call.id, tool: "bash", target: command });
        } else if (["timeout", "aborted", "callback_error"].includes(result.error.code)) {
          await this.recordExecution(run, call, { type: "security-host-execution-uncertain", id: approvalId,
            callId: call.id, target: command, reason: result.error.code });
        }
        return result;
      }
      return await this.executeCommand(run, call, command, executionOptions);
    } catch (error) {
      return { ok: false as const, error: error instanceof ExecutionError ? error : new ExecutionError("unknown", error instanceof Error ? error.message : String(error)) };
    }
  }

  /** Approval and its pause precede the command runtime interval. This records
   * real backend attempts, not shell text guesses or an automatic host retry.
   */
  private async executeCommand(run: RunContext, call: CallContext, command: string,
    options: Parameters<NodeExecutionEnv["exec"]>[1], approvalId?: string) {
    if (call.signal?.aborted || options?.abortSignal?.aborted) {
      await this.diagnose(run, { type: "tool-cancelled", callId: call.id });
      throw new ExecutionError("aborted", "Command aborted before execution");
    }
    const attemptId = randomUUID();
    const started = performance.now();
    await this.diagnose(run, { type: "command-start", callId: call.id, attemptId, host: call.host,
      ...(approvalId === undefined ? {} : { approvalId }) });
    let result: Awaited<ReturnType<NodeExecutionEnv["exec"]>>;
    try { result = await (call.host ? run.host : run.shell).exec(command, options); }
    catch (error) { result = { ok: false, error: error instanceof ExecutionError ? error : new ExecutionError("unknown", "Command backend failed") }; }
    const cancelled = !result.ok && result.error.code === "aborted";
    await this.diagnose(run, { type: "command-end", callId: call.id, attemptId, host: call.host,
      durationMs: performance.now() - started,
      status: cancelled ? "cancelled" : result.ok && result.value.exitCode === 0 ? "completed" : "failed",
      ...(result.ok ? { exitCode: result.value.exitCode } : { errorCode: result.error.code }) });
    return result;
  }

  private async diagnose(run: RunContext, event: AgentExecutionDiagnostic): Promise<void> {
    try { await run.diagnose?.(event); } catch { /* Trace sinks cannot affect approval or execution. */ }
  }

  private async recordExecution(run: RunContext, call: CallContext, event: ExecutionEvent): Promise<void> {
    const receipt: NonNullable<CallContext["receipt"]> = { event };
    call.receipt = receipt;
    try { await this.publish(run, event); }
    catch (error) { receipt.auditError = error instanceof Error ? error.message : String(error); }
  }

  private async publish(run: RunContext, event: SecurityToolEvent): Promise<void> {
    try { this.options.onEvent?.(event); } catch { /* Audit/UI observers cannot alter authorization. */ }
    await run.emit(event);
  }
}
