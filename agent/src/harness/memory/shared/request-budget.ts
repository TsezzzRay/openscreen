export { requireValidInputTokenCount } from "../../../model-token-count.js";

const TRUNCATION_MARKER = "\n…[truncated]…\n";

export type BoundedText = {
  text: string;
  originalCharacters: number;
  truncatedCharacters: number;
};

export function modelInputTokenBudget({
  operation,
  contextWindowTokens,
  maxInputTokens,
  maxOutputTokens,
  contextWindowFraction,
}: {
  operation: string;
  contextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindowFraction?: { numerator: number; denominator: number };
}) {
  const values = [contextWindowTokens, maxInputTokens, maxOutputTokens];
  if (!operation || values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      (contextWindowFraction !== undefined && (
        !Number.isSafeInteger(contextWindowFraction.numerator) ||
        !Number.isSafeInteger(contextWindowFraction.denominator) ||
        contextWindowFraction.numerator <= 0 ||
        contextWindowFraction.denominator <= 0 ||
        contextWindowFraction.numerator > contextWindowFraction.denominator
      ))) {
    throw new Error(`Invalid ${operation || "model"} token budget`);
  }
  const fractionBudget = contextWindowFraction === undefined
    ? contextWindowTokens
    : Math.floor(
      contextWindowTokens * contextWindowFraction.numerator /
        contextWindowFraction.denominator,
    );
  const value = Math.min(
    maxInputTokens,
    fractionBudget,
    contextWindowTokens - maxOutputTokens,
  );
  if (value <= 0) throw new Error(`${operation} output leaves no input budget`);
  return value;
}

export function turnMemoryInputTokenBudget({
  contextWindowTokens,
  maxInputTokens,
  maxOutputTokens,
}: {
  contextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}) {
  return modelInputTokenBudget({
    operation: "Turn Memory",
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    contextWindowFraction: { numerator: 7, denominator: 10 },
  });
}

export function boundedText(value: string, maxCharacters: number): BoundedText {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error(`Invalid text character limit: ${String(maxCharacters)}`);
  }
  const characters = Array.from(value);
  const originalCharacters = characters.length;
  if (originalCharacters <= maxCharacters) {
    return { text: value, originalCharacters, truncatedCharacters: 0 };
  }

  const marker = Array.from(TRUNCATION_MARKER);
  if (maxCharacters <= marker.length) {
    return {
      text: characters.slice(0, maxCharacters).join(""),
      originalCharacters,
      truncatedCharacters: originalCharacters - maxCharacters,
    };
  }

  const retainedCharacters = maxCharacters - marker.length;
  const headCharacters = Math.ceil(retainedCharacters * 2 / 3);
  const tailCharacters = retainedCharacters - headCharacters;
  return {
    text: [
      ...characters.slice(0, headCharacters),
      ...marker,
      ...characters.slice(originalCharacters - tailCharacters),
    ].join(""),
    originalCharacters,
    truncatedCharacters: originalCharacters - maxCharacters,
  };
}
