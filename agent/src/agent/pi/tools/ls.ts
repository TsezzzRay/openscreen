import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import { textResult, unwrapResult } from "./tool-support.js";

const DEFAULT_LS_LIMIT = 500;

export function createLsTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    path: Type.Optional(Type.String({ description: "Directory path; defaults to cwd" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum entries" })),
  }, { additionalProperties: false });
  return {
    name: "ls",
    label: "List directory",
    description:
      "List a directory alphabetically, including dotfiles and directory suffixes.",
    parameters,
    async execute(_toolCallId, params, signal) {
      const path = params.path ?? ".";
      const limit = params.limit ?? DEFAULT_LS_LIMIT;
      const entries = unwrapResult(await env.listDir(path, signal)).sort(
        (left, right) =>
          left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
      );
      const visible: string[] = [];
      for (const entry of entries.slice(0, limit)) {
        let isDirectory = entry.kind === "directory";
        if (entry.kind === "symlink") {
          const canonical = await env.canonicalPath(entry.path, signal);
          if (canonical.ok) {
            const target = await env.fileInfo(canonical.value, signal);
            isDirectory = target.ok && target.value.kind === "directory";
          }
        }
        visible.push(`${entry.name}${isDirectory ? "/" : ""}`);
      }
      if (visible.length === 0) {
        return textResult("(empty directory)", { path, entries: 0 });
      }
      const truncation = truncateHead(visible.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = {
        path,
        entries: visible.length,
      };
      if (entries.length > limit) {
        notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
        details.entryLimitReached = limit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      return textResult(
        `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
        details,
      );
    },
  } satisfies AgentTool<typeof parameters>;
}
