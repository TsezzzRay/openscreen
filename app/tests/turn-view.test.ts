import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TurnView } from "../src/renderer/components/TurnView.tsx";
import { newTurn } from "../src/renderer/store/types.ts";

test("shows the paused label even after answer text has streamed", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-1",
      question: "Update the file",
      answer: "I found the current value.",
      status: "awaiting-approval",
    }),
  }));

  expect(html).toContain("I found the current value.");
  expect(html).toContain("paused for approval");
});

test("does not show a failed turn's unresolved approval as still waiting", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-stopped",
      status: "failed",
      error: "Runtime exited",
      approvals: [{ id: "approval-1", callId: "call-1", tool: "bash", target: "pwd", status: "pending" }],
    }),
  }));

  expect(html).toContain("Approval outcome unknown after run ended");
  expect(html).not.toContain("Waiting for approval");
});

test("distinguishes approval from a committed file change and an executed host command", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-2",
      approvals: [
        { id: "a", callId: "call-a", tool: "write", target: "/tmp/pending.txt", status: "approved" },
        { id: "b", callId: "call-b", tool: "edit", target: "/tmp/changed.txt", status: "committed" },
        { id: "c", callId: "call-c", tool: "bash", target: "printf hello", status: "committed" },
      ],
    }),
  }));
  expect(html).toContain("Approved once; action not confirmed");
  expect(html).toContain("Approved file change committed");
  expect(html).toContain("Approved host command executed");
  expect(html).toContain("/tmp/changed.txt");
});

test("labels a committed desktop click as an action rather than a file change", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-desktop",
      approvals: [{ id: "desktop-1", callId: "call-1", tool: "desktop_click", target: "{\"action\":\"click\"}", status: "committed" }],
    }),
  }));
  expect(html).toContain("Desktop click executed under app approval");
  expect(html).not.toContain("Approved file change committed");
});

test("labels a committed desktop scroll as an executed desktop action", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-scroll",
      approvals: [{ id: "scroll-1", callId: "call-1", tool: "desktop_scroll", target: "{\"action\":\"scroll\"}", status: "committed" }],
    }),
  }));
  expect(html).toContain("Desktop scroll executed under app approval");
  expect(html).not.toContain("Approved file change committed");
});

test("labels an approved desktop app as a chat-scoped grant", () => {
  const html = renderToStaticMarkup(createElement(TurnView, {
    turn: newTurn({
      id: "turn-app-grant",
      approvals: [{ id: "app-1", callId: "call-1", tool: "desktop_type", target: "Editor", status: "approved" }],
    }),
  }));
  expect(html).toContain("Application allowed for this chat; action not confirmed");
});
