/**
 * Command+C copies the latest answer only when nothing is selected. With a
 * selection — in the page or inside the composer — the user meant the system
 * copy, and the shortcut must not take it from them.
 */
export function shouldCopyAnswer({
  pageSelection,
  fieldSelectionLength,
  answer,
}: {
  pageSelection: string;
  fieldSelectionLength: number;
  answer: string | undefined;
}): boolean {
  if (pageSelection.length > 0 || fieldSelectionLength > 0) return false;
  return answer !== undefined && answer.trim().length > 0;
}
