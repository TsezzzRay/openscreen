import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type {
  ApplicationCommand,
  ApplicationEvent,
  ApplicationHandler,
} from "../application/api.js";
import {
  parseJsonlCommand,
  recoverJsonlRequestId,
  serializeJsonlEvent,
} from "./jsonl-codec.js";

async function write(stream: Writable, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      stream.write(line + "\n", (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export interface JsonlTransportOptions {
  handler: ApplicationHandler;
  input: Readable;
  output: Writable;
  stderr: Writable;
}

export async function serveJsonl(options: JsonlTransportOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const active = new Set<Promise<void>>();
  let transportFailure: Error | undefined;
  let signalTransportFailure!: (error: Error) => void;
  const transportFailed = new Promise<Error>((resolve) => {
    signalTransportFailure = resolve;
  });
  const observeTransportFailure = (error: unknown) => {
    if (transportFailure !== undefined) return;
    transportFailure = error instanceof Error ? error : new Error(String(error));
    signalTransportFailure(transportFailure);
    lines.close();
  };
  options.output.on("error", observeTransportFailure);
  options.stderr.on("error", observeTransportFailure);
  let writes = Promise.resolve();
  const output = (requestId: string, event: ApplicationEvent) => {
    const current = writes.then(() =>
      write(options.output, serializeJsonlEvent(requestId, event))
    );
    void current.catch(observeTransportFailure);
    writes = current;
    return current;
  };
  const reportInvalid = async (line: string) => {
    const requestId = recoverJsonlRequestId(line);
    if (requestId !== undefined) {
      await output(requestId, {
        type: "failed",
        error: { code: "invalid-argument", message: "Invalid agent request" },
      });
    } else {
      await write(options.stderr, "Invalid agent request");
    }
  };
  const dispatch = (command: ApplicationCommand) => {
    let terminal = false;
    const task = (async () => {
      try {
        await options.handler.execute(command, async (event) => {
          const isTerminal = event.type === "completed" || event.type === "failed";
          if (terminal) return;
          if (isTerminal) terminal = true;
          await output(command.requestId, event);
        });
        if (!terminal) {
          terminal = true;
          await output(command.requestId, { type: "completed" });
        }
      } catch (error) {
        if (!terminal) {
          terminal = true;
          await output(command.requestId, {
            type: "failed",
            error: {
              code: "unknown",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    })();
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
  };

  const consume = async () => {
    for await (const line of lines) {
      try {
        dispatch(parseJsonlCommand(line));
      } catch {
        await reportInvalid(line);
      }
    }
    await Promise.allSettled([...active]);
    if (transportFailure !== undefined) throw transportFailure;
    await writes;
  };

  try {
    const outcome = await Promise.race([
      consume().then(
        () => ({ status: "completed" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
      transportFailed.then((error) => ({ status: "failed" as const, error })),
    ]);
    if (outcome.status === "failed") throw outcome.error;
  } finally {
    lines.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    options.output.off("error", observeTransportFailure);
    options.stderr.off("error", observeTransportFailure);
  }
}
