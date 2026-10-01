export interface ScreenAttributionMetric {
  contentLines: number;
  flaggedLines: number;
  rate: number | null;
}

/** Narrow, deterministic signal; it does not detect every attribution error. */
export function screenAttributionMetric(text: string): ScreenAttributionMetric {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const flaggedLines = lines.filter((line) => /\buser\s+(?:stated|asked|chose|approved|replied)\b/iu.test(line)).length;
  return { contentLines: lines.length, flaggedLines, rate: lines.length ? flaggedLines / lines.length : null };
}
