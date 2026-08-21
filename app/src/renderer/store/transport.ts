import type { AgentStatus } from "@shared/ipc.ts";
import type {
  ApplicationCommand,
  ApplicationEvent,
  ProductFailure,
} from "@shared/protocol.ts";

export class AgentFailureError extends Error {
  constructor(readonly failure: ProductFailure) {
    super(failure.message);
    this.name = "AgentFailureError";
  }

  get aborted(): boolean {
    return this.failure.code === "aborted";
  }
}

/**
 * What the store needs from the transport. Named separately so the store can be
 * exercised against a stub without standing up the IPC bridge.
 */
export interface AgentGateway {
  onStatus(listener: (status: AgentStatus) => void): () => void;
  send(
    command: ApplicationCommand,
    onEvent?: (event: ApplicationEvent) => void,
  ): Promise<void>;
  collect<T extends ApplicationEvent["type"]>(
    command: ApplicationCommand,
    type: T,
  ): Promise<Extract<ApplicationEvent, { type: T }>>;
}

interface PendingRequest {
  onEvent: (event: ApplicationEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Turns the main process's flat event broadcast back into per-request streams.
 *
 * The runtime guarantees exactly one terminal event (`completed` or `failed`)
 * per `requestId`, which is what settles a request here.
 */
export class AgentTransport implements AgentGateway {
  private readonly pending = new Map<string, PendingRequest>();
  private status: AgentStatus = { state: "starting" };

  constructor(private readonly bridge = window.openscreen) {
    this.bridge.agent.onEvent(({ requestId, event }) => this.dispatch(requestId, event));
    this.bridge.agent.onStatus((status) => {
      this.status = status;
      if (status.state !== "stopped") return;
      this.failAll(new Error(status.message));
    });
  }

  onStatus(listener: (status: AgentStatus) => void): () => void {
    return this.bridge.agent.onStatus(listener);
  }

  /**
   * Sends one command and resolves when it terminates. Non-terminal events are
   * handed to `onEvent` in arrival order.
   */
  async send(
    command: ApplicationCommand,
    onEvent: (event: ApplicationEvent) => void = () => {},
  ): Promise<void> {
    if (this.pending.has(command.requestId)) {
      throw new Error("A request with this id is already running.");
    }
    const settled = new Promise<void>((resolve, reject) => {
      this.pending.set(command.requestId, { onEvent, resolve, reject });
    });
    try {
      await this.bridge.agent.send(command);
    } catch (error) {
      this.pending.delete(command.requestId);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return settled;
  }

  /** Sends a command and returns the first event matching `type`. */
  async collect<T extends ApplicationEvent["type"]>(
    command: ApplicationCommand,
    type: T,
  ): Promise<Extract<ApplicationEvent, { type: T }>> {
    let found: Extract<ApplicationEvent, { type: T }> | undefined;
    await this.send(command, (event) => {
      if (event.type === type) found = event as Extract<ApplicationEvent, { type: T }>;
    });
    if (found === undefined) {
      throw new Error(`The agent did not return a ${type} response.`);
    }
    return found;
  }

  get stopped(): boolean {
    return this.status.state === "stopped";
  }

  private dispatch(requestId: string, event: ApplicationEvent): void {
    const request = this.pending.get(requestId);
    if (request === undefined) return;
    if (event.type === "completed") {
      this.pending.delete(requestId);
      request.resolve();
      return;
    }
    if (event.type === "failed") {
      this.pending.delete(requestId);
      request.reject(new AgentFailureError(event.error));
      return;
    }
    request.onEvent(event);
  }

  private failAll(error: Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) request.reject(error);
  }
}
