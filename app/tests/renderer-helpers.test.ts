import { describe, expect, test } from "vitest";

import { shouldCopyAnswer } from "../src/renderer/overlay/copy-shortcut.ts";
import { dateGroup, groupByDate } from "../src/renderer/relative-time.ts";

describe("overlay Command+C", () => {
  test("copies the latest answer when nothing is selected", () => {
    expect(shouldCopyAnswer({ pageSelection: "", fieldSelectionLength: 0, answer: "Done." })).toBe(true);
  });

  test("leaves a page selection to the system copy", () => {
    expect(shouldCopyAnswer({ pageSelection: "Do", fieldSelectionLength: 0, answer: "Done." })).toBe(false);
  });

  test("leaves a composer selection to the system copy", () => {
    expect(shouldCopyAnswer({ pageSelection: "", fieldSelectionLength: 3, answer: "Done." })).toBe(false);
  });

  test("does nothing without an answer to copy", () => {
    expect(shouldCopyAnswer({ pageSelection: "", fieldSelectionLength: 0, answer: undefined })).toBe(false);
    expect(shouldCopyAnswer({ pageSelection: "", fieldSelectionLength: 0, answer: "  " })).toBe(false);
  });
});

describe("sidebar date groups", () => {
  const now = new Date(2026, 9, 2, 15, 0);
  const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString();

  test("buckets by local calendar day", () => {
    expect(dateGroup(at(2, 0), now)).toBe("Today");
    expect(dateGroup(at(1, 23), now)).toBe("Yesterday");
    expect(dateGroup(new Date(2026, 8, 25, 9).toISOString(), now)).toBe("Previous 7 days");
    expect(dateGroup(new Date(2026, 8, 20, 9).toISOString(), now)).toBe("Older");
    expect(dateGroup("not a date", now)).toBe("Older");
  });

  test("keeps list order within a group and drops empty groups", () => {
    const groups = groupByDate(
      [
        { id: "a", createdAt: at(2, 14) },
        { id: "b", createdAt: new Date(2026, 8, 1).toISOString() },
        { id: "c", createdAt: at(2, 8) },
      ],
      now,
    );
    expect(groups.map((entry) => entry.group)).toEqual(["Today", "Older"]);
    expect(groups[0]!.items.map((item) => item.id)).toEqual(["a", "c"]);
  });
});
