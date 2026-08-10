export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1_024;
export const GREP_MAX_LINE_LENGTH = 500;

export type TruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
};

export type TruncationOptions = {
  maxLines?: number;
  maxBytes?: number;
};

function splitLinesForCounting(content: string) {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function unchangedResult(
  content: string,
  lines: string[],
  totalBytes: number,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines: lines.length,
    totalBytes,
    outputLines: lines.length,
    outputBytes: totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function formatSize(bytes: number) {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function truncateHead(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return unchangedResult(content, lines, totalBytes, maxLines, maxBytes);
  }

  if (Buffer.byteLength(lines[0] ?? "", "utf8") > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    output.push(line);
    outputBytes += lineBytes;
  }
  if (output.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines";
  const outputContent = output.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

function truncateStringToBytesFromEnd(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

export function truncateTail(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return unchangedResult(content, lines, totalBytes, maxLines, maxBytes);
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let index = lines.length - 1; index >= 0 && output.length < maxLines; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (output.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        output.unshift(partial);
        outputBytes = Buffer.byteLength(partial, "utf8");
        lastLinePartial = true;
      }
      break;
    }
    output.unshift(line);
    outputBytes += lineBytes;
  }
  if (output.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines";
  const outputContent = output.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return {
    text: `${line.slice(0, maxChars)}... [truncated]`,
    wasTruncated: true,
  };
}
