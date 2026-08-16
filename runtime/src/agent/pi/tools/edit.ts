import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";

import { byteLength, textResult, unwrapResult } from "./tool-support.js";

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function countOccurrences(content: string, target: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

export function createEditTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    path: Type.String({ description: "Relative or absolute file path" }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({
        minLength: 1,
        description: "Unique exact text in the original file",
      }),
      newText: Type.String({ description: "Replacement text" }),
    }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false });
  return {
    name: "edit",
    label: "Edit",
    description:
      "Apply disjoint exact-text replacements. Every oldText must occur exactly once.",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const raw = unwrapResult(await env.readTextFile(params.path, signal));
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const withoutBom = bom ? raw.slice(1) : raw;
      const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n";
      const original = normalize(withoutBom);
      const matches = params.edits.map((edit, index) => {
        const oldText = normalize(edit.oldText);
        const occurrences = countOccurrences(original, oldText);
        if (occurrences === 0) {
          throw new Error(
            `Could not find edits[${index}] in ${params.path}. oldText must match exactly.`,
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `Found ${occurrences} occurrences of edits[${index}] in ${params.path}. oldText must be unique.`,
          );
        }
        const start = original.indexOf(oldText);
        return {
          index,
          start,
          end: start + oldText.length,
          newText: normalize(edit.newText),
        };
      }).sort((left, right) => left.start - right.start);
      for (let index = 1; index < matches.length; index += 1) {
        if (matches[index - 1].end > matches[index].start) {
          throw new Error(
            `edits[${matches[index - 1].index}] and edits[${matches[index].index}] overlap in ${params.path}`,
          );
        }
      }
      let updated = original;
      for (const match of [...matches].reverse()) {
        updated = updated.slice(0, match.start) + match.newText +
          updated.slice(match.end);
      }
      if (updated === original) {
        throw new Error(`No changes made to ${params.path}`);
      }
      const finalContent = bom +
        (lineEnding === "\r\n" ? updated.replaceAll("\n", "\r\n") : updated);
      unwrapResult(await env.writeFile(params.path, finalContent, signal));
      return textResult(
        `Successfully replaced ${params.edits.length} block${params.edits.length === 1 ? "" : "s"} in ${params.path}`,
        {
          path: params.path,
          replacements: params.edits.length,
          bytesWritten: byteLength(finalContent),
        },
      );
    },
  } satisfies AgentTool<typeof parameters>;
}
