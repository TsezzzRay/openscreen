import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

import { loadRuntimeConfig } from "./config.js";
import {
  countRequestTokens,
  countTurns,
  makeRequest,
  relayStream,
  summarizeTurns,
  type OutputEnvelope,
} from "./model.js";
import {
  compactIfNeeded,
  compactSession,
  type SessionState,
} from "./session.js";

type InputEnvelope = {
  requestId: string;
  input: {
    text: string;
    image: string;
  };
};

function emit(event: OutputEnvelope) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function run() {
  const config = loadRuntimeConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const { model, context } = config;
  const session: SessionState = { turns: [], firstKeptTurnIndex: 0 };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const compact = () => compactSession(
    session,
    context.keepRecentTokens,
    (turns) => countTurns(client, model, turns),
    (previousSummary, turns) => summarizeTurns(
      client,
      model,
      previousSummary,
      turns,
      context.summaryMaxOutputTokens,
    ),
  );

  for await (const line of lines) {
    const { requestId, input } = JSON.parse(line) as InputEnvelope;
    emit({ requestId, type: "started" });
    try {
      const buildRequest = () => makeRequest(
        model,
        input.text,
        input.image,
        context.maxOutputTokens,
        session,
      );
      let request = await buildRequest();
      await compactIfNeeded(
        context.compactAtTokens,
        () => countRequestTokens(client, request),
        async () => {
          const compacted = await compact();
          request = await buildRequest();
          return compacted;
        },
      );
      const stream = await client.responses.create(request);
      const result = await relayStream(requestId, stream, emit);
      if (result !== null) {
        session.turns.push({
          user: input.text,
          assistant: result.output,
          screenshotPath: input.image,
          outputItems: result.outputItems,
        });
        if ((result.totalTokens ?? 0) >= context.compactAtTokens) {
          try {
            await compact();
          } catch (error) {
            process.stderr.write(
              `Turn-end compaction deferred: ${error instanceof Error ? error.message : "unknown error"}\n`,
            );
          }
        }
      }
    } catch (error) {
      emit({
        requestId,
        type: "failed",
        message: error instanceof Error ? error.message : "Model request failed",
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
