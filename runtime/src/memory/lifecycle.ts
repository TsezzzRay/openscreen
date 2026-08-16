export interface MemoryLifecycleService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MemoryRetryTimer {
  unref(): void;
}

export interface RetryingMemoryLifecycleOptions {
  service: MemoryLifecycleService;
  retryMilliseconds: number;
  setRetryTimer?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => MemoryRetryTimer;
  clearRetryTimer?: (timer: MemoryRetryTimer) => void;
}

export class RetryingMemoryLifecycle {
  private readonly setRetryTimer: NonNullable<
    RetryingMemoryLifecycleOptions["setRetryTimer"]
  >;
  private readonly clearRetryTimer: NonNullable<
    RetryingMemoryLifecycleOptions["clearRetryTimer"]
  >;
  private retryTimer?: MemoryRetryTimer;
  private attempt?: Promise<void>;
  private begun = false;
  private stopping = false;

  constructor(private readonly options: RetryingMemoryLifecycleOptions) {
    if (
      !Number.isFinite(options.retryMilliseconds) ||
      options.retryMilliseconds <= 0
    ) {
      throw new Error("Memory retryMilliseconds must be positive");
    }
    this.setRetryTimer = options.setRetryTimer ?? ((callback, delay) =>
      setTimeout(callback, delay));
    this.clearRetryTimer = options.clearRetryTimer ?? ((timer) =>
      clearTimeout(timer as NodeJS.Timeout));
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer !== undefined) return;
    let timer: MemoryRetryTimer;
    timer = this.setRetryTimer(() => {
      if (this.retryTimer !== timer) return;
      this.retryTimer = undefined;
      if (this.stopping) return;
      const attempt = this.attemptStart();
      this.attempt = attempt;
      void attempt.finally(() => {
        if (this.attempt === attempt) this.attempt = undefined;
      });
    }, this.options.retryMilliseconds);
    this.retryTimer = timer;
    timer.unref();
  }

  private async attemptStart(): Promise<void> {
    try {
      await this.options.service.start();
    } catch {
      this.scheduleRetry();
    }
  }

  async start(): Promise<void> {
    if (this.begun) {
      await this.attempt;
      return;
    }
    this.begun = true;
    this.stopping = false;
    const attempt = this.attemptStart();
    this.attempt = attempt;
    await attempt;
    if (this.attempt === attempt) this.attempt = undefined;
  }

  async stop(): Promise<void> {
    if (!this.begun) return;
    this.stopping = true;
    if (this.retryTimer !== undefined) {
      this.clearRetryTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.attempt;
    await this.options.service.stop();
    this.attempt = undefined;
    this.begun = false;
  }
}
