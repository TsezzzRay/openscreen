import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentTool } from "../../types.js";
import {
  requiredString,
  validateKeys,
} from "../shared/arguments.js";
import { withFileMutationQueue } from "../shared/file-mutation-queue.js";

type Edit = { oldText: string; newText: string };

function normalize(value: string) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function countOccurrences(content: string, target: string) {
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(target, index)) !== -1) {
    count += 1;
    index += Math.max(target.length, 1);
  }
  return count;
}

function parseEdits(argumentsValue: Record<string, unknown>) {
  const value = argumentsValue.edits;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  return value.map((candidate, index): Edit => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`edits[${index}] must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    validateKeys(record, ["oldText", "newText"]);
    if (typeof record.oldText !== "string" || record.oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must be a non-empty string`);
    }
    if (typeof record.newText !== "string") {
      throw new Error(`edits[${index}].newText must be a string`);
    }
    return { oldText: normalize(record.oldText), newText: normalize(record.newText) };
  });
}

function applyEdits(content: string, edits: Edit[], path: string) {
  const matches = edits.map((edit, index) => {
    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences === 0) {
      throw new Error(`Could not find edits[${index}] in ${path}. oldText must match exactly.`);
    }
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of edits[${index}] in ${path}. oldText must be unique.`);
    }
    return {
      editIndex: index,
      start: content.indexOf(edit.oldText),
      end: content.indexOf(edit.oldText) + edit.oldText.length,
      newText: edit.newText,
    };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index - 1].end > matches[index].start) {
      throw new Error(
        `edits[${matches[index - 1].editIndex}] and edits[${matches[index].editIndex}] overlap in ${path}`,
      );
    }
  }
  let result = content;
  for (const match of [...matches].reverse()) {
    result = result.slice(0, match.start) + match.newText + result.slice(match.end);
  }
  if (result === content) throw new Error(`No changes made to ${path}`);
  return result;
}

export function createEditTool(cwd: string): AgentTool {
  return {
    definition: {
      type: "function",
      name: "edit",
      description: "Apply one or more disjoint exact-text replacements to one file. Every oldText must be unique and all matches are evaluated against the original content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path" },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Unique exact text in the original file" },
                newText: { type: "string", description: "Replacement text" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
      strict: true,
    },
    source: "system",
    guidelines: [
      "Use one edit call for multiple disjoint replacements in the same file.",
      "Keep each oldText small but unique; merge overlapping replacements.",
    ],
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["path", "edits"]);
      const path = requiredString(argumentsValue, "path");
      const edits = parseEdits(argumentsValue);
      const absolutePath = resolve(cwd, path);
      return withFileMutationQueue(absolutePath, async () => {
        signal.throwIfAborted();
        const raw = await readFile(absolutePath, "utf8");
        signal.throwIfAborted();
        const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
        const withoutBom = bom ? raw.slice(1) : raw;
        const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n";
        const updated = applyEdits(normalize(withoutBom), edits, path);
        const finalContent = bom + (lineEnding === "\r\n"
          ? updated.replaceAll("\n", "\r\n")
          : updated);
        await writeFile(absolutePath, finalContent, "utf8");
        signal.throwIfAborted();
        return {
          content: `Successfully replaced ${edits.length} blocks in ${path}`,
          details: {
            replacements: edits.length,
            bytesWritten: Buffer.byteLength(finalContent, "utf8"),
          },
        };
      });
    },
  };
}
