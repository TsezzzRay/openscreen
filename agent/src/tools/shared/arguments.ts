export function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
) {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return result;
}

export function requiredText(
  value: Record<string, unknown>,
  key: string,
) {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`${key} must be a string`);
  return result;
}

export function optionalString(
  value: Record<string, unknown>,
  key: string,
) {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return result;
}

export function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
) {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "boolean") throw new Error(`${key} must be a boolean`);
  return result;
}

export function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
) {
  const result = value[key];
  if (result === undefined) return undefined;
  if (!Number.isSafeInteger(result) || (result as number) < minimum) {
    const label = minimum === 1 ? "a positive integer" : `an integer >= ${minimum}`;
    throw new Error(`${key} must be ${label}`);
  }
  return result as number;
}

export function optionalPositiveNumber(
  value: Record<string, unknown>,
  key: string,
) {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) {
    throw new Error(`${key} must be a positive finite number`);
  }
  return result;
}
