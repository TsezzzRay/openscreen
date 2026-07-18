import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

import {
  countRequestTokens,
  countTurns,
  getModel,
  makeRequest,
  relayStream,
  summarizeTurns,
  type OutputEnvelope,
} from "./model.js";
import {
  COMPACT_AT_TOKENS,
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
  const client = new OpenAI();
  const model = getModel();
  const session: SessionState = { turns: [], firstKeptTurnIndex: 0 };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const compact = () => compactSession(
    session,
    (turns) => countTurns(client, model, turns),
    (previousSummary, turns) => summarizeTurns(
      client,
      model,
      previousSummary,
      turns,
    ),
  );

  for await (const line of lines) {
    const { requestId, input } = JSON.parse(line) as InputEnvelope;
    emit({ requestId, type: "started" });
    try {
      const imageBase64 = (await readFile(input.image)).toString("base64");
      const buildRequest = () => makeRequest(model, input.text, imageBase64, session);
      await compactIfNeeded(
        () => countRequestTokens(client, buildRequest()),
        compact,
      );
      const stream = await client.responses.create(buildRequest());
      const result = await relayStream(requestId, stream, emit);
      if (result !== null) {
        session.turns.push({ user: input.text, assistant: result.output });
        if ((result.totalTokens ?? 0) >= COMPACT_AT_TOKENS) {
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
