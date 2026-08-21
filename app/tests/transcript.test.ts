import { describe, expect, test } from "vitest";

import type { ProductTranscriptMessage } from "@shared/protocol.ts";

import {
  projectTranscript,
  restoreLocalAttachments,
  sessionToRestore,
} from "@/store/transcript.ts";
import { newTurn } from "@/store/types.ts";

const at = "2026-08-21T00:00:00.000Z";

function message(
  partial: Partial<ProductTranscriptMessage> & Pick<ProductTranscriptMessage, "id" | "role">,
): ProductTranscriptMessage {
  return { timestamp: at, text: "", ...partial };
}

describe("projectTranscript", () => {
  test("folds assistant and tool messages into the preceding question", () => {
    const turns = projectTranscript([
      message({ id: "u1", role: "user", text: "why", imageCount: 2 }),
      message({ id: "t1", role: "tool", text: "hit", toolName: "grep" }),
      message({ id: "a1", role: "assistant", text: "because", reasoning: "hm" }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "u1",
      question: "why",
      historicalImageCount: 2,
      answer: "because",
      reasoning: "hm",
    });
    expect(turns[0]?.toolActivities).toEqual([
      { callId: "t1", name: "grep", text: "hit", status: "finished", isError: false },
    ]);
  });

  test("concatenates consecutive assistant messages into one answer", () => {
    const turns = projectTranscript([
      message({ id: "u1", role: "user", text: "q" }),
      message({ id: "a1", role: "assistant", text: "one ", reasoning: "a" }),
      message({ id: "a2", role: "assistant", text: "two", reasoning: "b" }),
    ]);

    expect(turns[0]?.answer).toBe("one two");
    expect(turns[0]?.reasoning).toBe("ab");
  });

  test("marks a turn failed when the runtime reports an incomplete run", () => {
    const turns = projectTranscript([
      message({ id: "u1", role: "user", text: "q" }),
      message({ id: "a1", role: "assistant", text: "partial", isError: true }),
    ]);

    expect(turns[0]?.status).toBe("failed");
    expect(turns[0]?.error).toBe("The previous Agent run did not complete.");
  });

  test("hides injected context messages", () => {
    const turns = projectTranscript([
      message({ id: "c1", role: "context", text: "MEMORY.md" }),
      message({ id: "u1", role: "user", text: "q" }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("q");
  });

  test("keeps a leading assistant message when no question precedes it", () => {
    const turns = projectTranscript([
      message({ id: "a1", role: "assistant", text: "orphan" }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("");
    expect(turns[0]?.answer).toBe("orphan");
  });
});

describe("restoreLocalAttachments", () => {
  const attachment = (id: string) => ({
    id,
    path: `/tmp/${id}.png`,
    mimeType: "image/png" as const,
    url: `osfile://local/${id}`,
  });

  test("rebinds local files to the reloaded turn with the same question", () => {
    const previous = [
      newTurn({ id: "p1", question: "same", attachments: [attachment("a")] }),
    ];
    const restored = [newTurn({ id: "r1", question: "same" })];

    expect(restoreLocalAttachments(restored, previous)[0]?.attachments).toEqual([
      attachment("a"),
    ]);
  });

  test("claims each previous attachment set at most once", () => {
    const previous = [
      newTurn({ id: "p1", question: "same", attachments: [attachment("a")] }),
      newTurn({ id: "p2", question: "same", attachments: [attachment("b")] }),
    ];
    const restored = [
      newTurn({ id: "r1", question: "same" }),
      newTurn({ id: "r2", question: "same" }),
      newTurn({ id: "r3", question: "same" }),
    ];

    const result = restoreLocalAttachments(restored, previous);
    expect(result[2]?.attachments).toEqual([attachment("b")]);
    expect(result[1]?.attachments).toEqual([attachment("a")]);
    expect(result[0]?.attachments).toEqual([]);
  });

  test("leaves a turn alone when no previous question matches", () => {
    const previous = [
      newTurn({ id: "p1", question: "other", attachments: [attachment("a")] }),
    ];
    const restored = [newTurn({ id: "r1", question: "same" })];

    expect(restoreLocalAttachments(restored, previous)[0]?.attachments).toEqual([]);
  });
});

describe("sessionToRestore", () => {
  const sessions = [{ id: "a" }, { id: "b" }];

  test("prefers the remembered session when it still exists", () => {
    expect(sessionToRestore(sessions, "b")).toBe("b");
  });

  test("falls back to the newest session when the remembered one is gone", () => {
    expect(sessionToRestore(sessions, "gone")).toBe("a");
  });

  test("reports nothing to restore when there are no sessions", () => {
    expect(sessionToRestore([], "a")).toBeUndefined();
  });
});
