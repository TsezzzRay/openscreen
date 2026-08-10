import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type TruncationResult,
  truncateTail,
} from "./truncate.js";

export type OutputAccumulatorOptions = {
  maxLines?: number;
  maxBytes?: number;
  outputDirectory: string;
  filePrefix?: string;
};

export type OutputSnapshot = {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
};

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8");
}

export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly outputDirectory: string;
  private readonly filePrefix: string;
  private readonly decoder = new TextDecoder();
  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private outputPath: string | undefined;
  private outputStream: WriteStream | undefined;
  private outputCompletion: Promise<void> | undefined;

  constructor(options: OutputAccumulatorOptions) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.outputDirectory = options.outputDirectory;
    this.filePrefix = options.filePrefix ?? "tool-output";
  }

  append(data: Buffer) {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    if (this.outputStream || this.shouldPersist()) {
      this.ensureOutputFile();
      this.outputStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldPersist()) this.ensureOutputFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tail = truncateTail(this.snapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines ||
      this.totalDecodedBytes > this.maxBytes;
    const truncation: TruncationResult = {
      ...tail,
      truncated,
      truncatedBy: truncated
        ? tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines")
        : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncated) this.ensureOutputFile();
    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.outputPath,
    };
  }

  async close() {
    if (!this.outputStream) return;
    const stream = this.outputStream;
    this.outputStream = undefined;
    stream.end();
    await this.outputCompletion;
  }

  private appendDecodedText(text: string) {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      newlines += 1;
      lastNewline = index;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const remainder = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(remainder);
      this.hasOpenLine = remainder.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail() {
    const buffer = Buffer.from(this.tailText, "utf8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    this.tailStartsAtLineBoundary = start === 0
      ? this.tailStartsAtLineBoundary
      : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf8");
    this.tailBytes = byteLength(this.tailText);
  }

  private snapshotText() {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldPersist() {
    return this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  private ensureOutputFile() {
    if (this.outputPath) return;
    mkdirSync(this.outputDirectory, { recursive: true });
    this.outputPath = join(
      this.outputDirectory,
      `${this.filePrefix}-${randomBytes(8).toString("hex")}.log`,
    );
    this.outputStream = createWriteStream(this.outputPath, { mode: 0o600 });
    this.outputCompletion = new Promise<void>((resolve, reject) => {
      this.outputStream!.once("finish", resolve);
      this.outputStream!.once("error", reject);
    });
    void this.outputCompletion.catch(() => {});
    for (const chunk of this.rawChunks) this.outputStream.write(chunk);
    this.rawChunks = [];
  }
}
