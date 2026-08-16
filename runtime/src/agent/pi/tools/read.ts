import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type AgentTool,
  type ExecutionEnv,
  type TruncationResult,
} from "@earendil-works/pi-agent-core";

import { byteLength, textResult, unwrapResult } from "./tool-support.js";

function truncationNotice(
  truncation: TruncationResult,
  startLine: number,
  totalLines: number,
): string {
  const endLine = startLine + truncation.outputLines - 1;
  const byteNotice = truncation.truncatedBy === "bytes"
    ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
    : "";
  return `Showing lines ${startLine}-${endLine} of ${totalLines}${byteNotice}. Use offset=${endLine + 1} to continue.`;
}

export function createReadTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    path: Type.String({ description: "Relative or absolute file path" }),
    offset: Type.Optional(Type.Integer({
      minimum: 1,
      description: "1-indexed first line",
    })),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      description: "Maximum lines to read",
    })),
  }, { additionalProperties: false });
  return {
    name: "read",
    label: "Read",
    description:
      "Read a UTF-8 text file with bounded output. Use offset and limit to continue large files.",
    parameters,
    async execute(_toolCallId, params, signal) {
      const raw = unwrapResult(await env.readTextFile(params.path, signal));
      const allLines = raw.split("\n");
      const hasTerminalNewline = raw.endsWith("\n");
      if (hasTerminalNewline) allLines.pop();
      const start = (params.offset ?? 1) - 1;
      if (start >= allLines.length) {
        throw new Error(
          `Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }
      const end = params.limit === undefined
        ? allLines.length
        : Math.min(start + params.limit, allLines.length);
      const truncation = truncateHead(allLines.slice(start, end).join("\n"));
      let output = truncation.content;
      if (truncation.firstLineExceedsLimit) {
        output = `[Line ${start + 1} is ${formatSize(byteLength(allLines[start] ?? ""))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash to inspect a bounded byte range.]`;
      } else if (truncation.truncated) {
        output += `\n\n[${truncationNotice(truncation, start + 1, allLines.length)}]`;
      } else if (params.limit !== undefined && end < allLines.length) {
        output += `\n\n[${allLines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
      } else if (hasTerminalNewline && end === allLines.length) {
        output += "\n";
      }
      return textResult(output, {
        path: params.path,
        offset: start + 1,
        linesReturned: truncation.outputLines,
        ...(truncation.truncated ? { truncation } : {}),
      });
    },
  } satisfies AgentTool<typeof parameters>;
}
