import { rgPath } from "@vscode/ripgrep";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  executeShellWithCapture,
  formatSize,
  truncateHead,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import {
  boundedFindCommand,
  FIND_BYTE_LIMIT_SENTINEL,
  SEARCH_CAPTURE_MAX_BYTES,
} from "./search-support.js";
import { shellQuote, textResult, unwrapResult } from "./tool-support.js";

const DEFAULT_FIND_LIMIT = 1_000;

export function createFindTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    pattern: Type.String({ description: "Glob such as '*.ts' or 'src/**/*.test.ts'" }),
    path: Type.Optional(Type.String({ description: "Directory; defaults to cwd" })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false });
  return {
    name: "find",
    label: "Find files",
    description:
      "Find files by glob with packaged ripgrep while respecting ignore files.",
    parameters,
    async execute(_toolCallId, params, signal) {
      const root = params.path ?? ".";
      const limit = params.limit ?? DEFAULT_FIND_LIMIT;
      const ripgrep = [
        rgPath,
        "--files",
        "--hidden",
        "--sort", "path",
        "--glob", params.pattern,
        "--", ".",
      ].map(shellQuote).join(" ");
      const captured = unwrapResult(await executeShellWithCapture(
        env,
        boundedFindCommand(ripgrep, limit + 1),
        { abortSignal: signal, cwd: root },
      ));
      if (captured.cancelled) throw new Error("Find aborted");
      if (captured.exitCode !== 0 && captured.exitCode !== 1) {
        throw new Error(
          `${captured.output || "ripgrep failed"}\n\nripgrep exited with code ${captured.exitCode}`,
        );
      }
      const candidates = captured.output.split("\n").filter(Boolean);
      const byteLimitReached = candidates.includes(FIND_BYTE_LIMIT_SENTINEL);
      const matches = candidates
        .filter((value) => value !== FIND_BYTE_LIMIT_SENTINEL)
        .map((value) => value.replaceAll("\\", "/").replace(/^\.\//, ""));
      if (matches.length === 0 && byteLimitReached) {
        return textResult(
          "Search byte limit reached before a complete path could be returned. Refine the pattern or path.",
          { matches: 0, byteLimitReached: true },
        );
      }
      if (matches.length === 0) {
        return textResult("No files found matching pattern", { matches: 0 });
      }
      const selected = matches.slice(0, limit);
      const truncation = truncateHead(selected.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = { matches: selected.length };
      if (matches.length > limit) {
        notices.push(
          `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
        details.resultLimitReached = limit;
      }
      if (byteLimitReached) {
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
      return textResult(
        `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
        details,
      );
    },
  } satisfies AgentTool<typeof parameters>;
}
