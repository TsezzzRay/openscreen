export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly content: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}
