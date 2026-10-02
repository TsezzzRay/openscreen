/** A short age for a list row: "now", "5m", "3h", "2d". */
export function relativeTime(iso: string, now = Date.now()): string {
  const created = Date.parse(iso);
  if (Number.isNaN(created)) return "";
  const minutes = Math.round((now - created) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

/** Which sidebar heading a chat created at `iso` falls under, by local calendar day. */
export function dateGroup(iso: string, now = new Date()): DateGroup {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return "Older";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const time = created.getTime();
  if (time >= startOfToday) return "Today";
  if (time >= startOfToday - day) return "Yesterday";
  if (time >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}

/**
 * Splits an already ordered list into date headings, keeping the list's own
 * order inside each heading and dropping headings with nothing under them.
 */
export function groupByDate<T extends { createdAt: string }>(
  items: T[],
  now = new Date(),
): { group: DateGroup; items: T[] }[] {
  const groups = new Map<DateGroup, T[]>();
  for (const item of items) {
    const group = dateGroup(item.createdAt, now);
    const bucket = groups.get(group);
    if (bucket === undefined) groups.set(group, [item]);
    else bucket.push(item);
  }
  const order: DateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Older"];
  return order.flatMap((group) => {
    const bucket = groups.get(group);
    return bucket === undefined ? [] : [{ group, items: bucket }];
  });
}
