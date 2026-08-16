import type {
  Session,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import type {
  AgentSessionState,
  AgentSessionSummary,
  AgentSessionView,
  AgentTranscriptMessage,
  AgentThinkingLevel,
} from "../api.js";
import { stripMemoryCitationBlock } from "./memory-citation.js";

export interface SessionProjectionDefaults {
  thinking: AgentThinkingLevel;
}

function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function contentImageCount(
  content: string | Array<{ type: string }>,
): number | undefined {
  if (typeof content === "string") return undefined;
  const count = content.filter((block) => block.type === "image").length;
  return count > 0 ? count : undefined;
}

function messageProjection(
  entry: Extract<SessionTreeEntry, { type: "message" }>,
): AgentTranscriptMessage | undefined {
  const message = entry.message;
  if (message.role === "custom") {
    if (!message.display) return undefined;
    return {
      id: entry.id,
      role: "context",
      timestamp: entry.timestamp,
      text: contentText(message.content),
      imageCount: contentImageCount(message.content),
    };
  }
  if (message.role === "user") {
    return {
      id: entry.id,
      role: "user",
      timestamp: entry.timestamp,
      text: contentText(message.content),
      imageCount: contentImageCount(message.content),
    };
  }
  if (message.role === "assistant") {
    return {
      id: entry.id,
      role: "assistant",
      timestamp: entry.timestamp,
      text: stripMemoryCitationBlock(message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")).text,
      reasoning: message.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join(""),
      isError:
        message.stopReason === "error" || message.stopReason === "aborted",
    };
  }
  if (message.role === "toolResult") {
    return {
      id: entry.id,
      role: "tool",
      timestamp: entry.timestamp,
      text: contentText(message.content),
      toolName: message.toolName,
      isError: message.isError,
      imageCount: contentImageCount(message.content),
    };
  }
  if (message.role === "bashExecution") {
    return {
      id: entry.id,
      role: "tool",
      timestamp: entry.timestamp,
      text: message.output,
      toolName: "bash",
      isError: message.exitCode !== undefined && message.exitCode !== 0,
    };
  }
  if (message.role === "compactionSummary") {
    return {
      id: entry.id,
      role: "context",
      timestamp: entry.timestamp,
      text: message.summary,
    };
  }
  return undefined;
}

export function projectSessionName(
  explicitName: string | undefined,
  entries: SessionTreeEntry[],
): string | undefined {
  if (explicitName !== undefined && explicitName.trim()) return explicitName;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const normalized = contentText(entry.message.content)
      .replace(/\s+/g, " ")
      .trim();
    if (normalized) {
      return normalized.length <= 80
        ? normalized
        : `${normalized.slice(0, 79)}…`;
    }
    if (contentImageCount(entry.message.content) !== undefined) {
      return "Image prompt";
    }
  }
  return undefined;
}

function validThinkingLevel(value: string): value is AgentThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .includes(value);
}

function projectState(
  branch: SessionTreeEntry[],
  defaults: SessionProjectionDefaults,
): AgentSessionState {
  let thinking = defaults.thinking;
  for (const entry of branch) {
    if (
      entry.type === "thinking_level_change" &&
      validThinkingLevel(entry.thinkingLevel)
    ) {
      thinking = entry.thinkingLevel;
    }
  }
  return { thinking };
}

export async function projectSession(
  session: Session,
  defaults: SessionProjectionDefaults,
): Promise<AgentSessionView> {
  const [metadata, name, entries, branch] = await Promise.all([
    session.getMetadata(),
    session.getSessionName(),
    session.getEntries(),
    session.getBranch(),
  ]);
  const summary: AgentSessionSummary = {
    id: metadata.id,
    createdAt: metadata.createdAt,
    name: projectSessionName(name, entries),
  };
  return {
    session: summary,
    messages: branch.flatMap((entry) => {
      if (entry.type === "message") {
        const projected = messageProjection(entry);
        return projected ? [projected] : [];
      }
      if (entry.type === "custom_message" && entry.display) {
        return [{
          id: entry.id,
          role: "context" as const,
          timestamp: entry.timestamp,
          text: contentText(entry.content),
          imageCount: contentImageCount(entry.content),
        }];
      }
      return [];
    }),
    state: projectState(branch, defaults),
  };
}
