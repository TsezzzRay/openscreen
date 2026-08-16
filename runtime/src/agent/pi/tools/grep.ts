import { rgPath } from "@vscode/ripgrep";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  executeShellWithCapture,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import {
  boundedGrepCommand,
  displayPath,
  parseGrepMatches,
  SEARCH_CAPTURE_MAX_BYTES,
} from "./search-support.js";
import { shellQuote, textResult, unwrapResult } from "./tool-support.js";

const DEFAULT_GREP_LIMIT = 100;

export function createGrepTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    pattern: Type.String({ description: "Regular expression or literal text" }),
    path: Type.Optional(Type.String({ description: "File or directory; defaults to cwd" })),
    glob: Type.Optional(Type.String({ description: "Optional file glob filter" })),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false });
  return {
    name: "grep",
    label: "Search file contents",
    description:
      "Search file contents with packaged ripgrep while respecting ignore files.",
    parameters,
    async execute(_toolCallId, params, signal) {
      const root = params.path ?? ".";
      const limit = params.limit ?? DEFAULT_GREP_LIMIT;
      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.pattern, root);
      const ripgrep = [rgPath, ...args].map(shellQuote).join(" ");
      const captured = unwrapResult(await executeShellWithCapture(
        env,
        boundedGrepCommand(ripgrep, limit + 1),
        { abortSignal: signal },
      ));
      if (captured.cancelled) throw new Error("Grep aborted");
      if (captured.exitCode !== 0 && captured.exitCode !== 1) {
        throw new Error(
          `${captured.output || "ripgrep failed"}\n\nripgrep exited with code ${captured.exitCode}`,
        );
      }
      const parsed = parseGrepMatches(captured.output);
      const matches = parsed.matches;
      if (matches.length === 0 && parsed.byteLimitReached) {
        return textResult(
          "Search byte limit reached before a complete match could be returned. Refine the pattern or path.",
          { matches: 0, byteLimitReached: true },
        );
      }
      if (matches.length === 0) {
        return textResult("No matches found", { matches: 0 });
      }
      const selected = matches.slice(0, limit);
      const output: string[] = [];
      let linesTruncated = false;
      for (const match of selected) {
        const path = await displayPath(env, match.path, root);
        if ((params.context ?? 0) === 0) {
          const line = truncateLine(match.text.replaceAll("\r", ""));
          linesTruncated ||= line.wasTruncated;
          output.push(`${path}:${match.line}: ${line.text}`);
          continue;
        }
        const raw = unwrapResult(await env.readTextFile(match.path, signal));
        const lines = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
        const start = Math.max(1, match.line - (params.context ?? 0));
        const end = Math.min(lines.length, match.line + (params.context ?? 0));
        for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
          const line = truncateLine(lines[lineNumber - 1] ?? "");
          linesTruncated ||= line.wasTruncated;
          output.push(lineNumber === match.line
            ? `${path}:${lineNumber}: ${line.text}`
            : `${path}-${lineNumber}- ${line.text}`);
        }
      }
      const truncation = truncateHead(output.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = {
        matches: selected.length,
        matchedLines: selected.map(({ path, line }) => ({ path, line })),
      };
      if (matches.length > limit) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
        details.matchLimitReached = limit;
      }
      if (parsed.byteLimitReached) {
        notices.push(
          `${formatSize(SEARCH_CAPTURE_MAX_BYTES)} search byte limit reached. Refine pattern or path`,
        );
        details.byteLimitReached = true;
      }
      if (truncation.truncated || captured.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
        if (captured.fullOutputPath) {
          details.fullOutputPath = captured.fullOutputPath;
        }
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
        details.linesTruncated = true;
      }
      return textResult(
        `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
        details,
      );
    },
  } satisfies AgentTool<typeof parameters>;
}
