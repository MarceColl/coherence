import type { JsonValue } from "./types.ts";

/** Validate a value crossing a plugin boundary as lossless JSON data. */
export function assertJsonValue(
  value: unknown,
  subject: string,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${subject} must contain only finite JSON numbers`);
  }
  if (typeof value !== "object")
    throw new Error(`${subject} must be JSON-serializable`);
  if (ancestors.has(value))
    throw new Error(`${subject} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length
        || Reflect.ownKeys(value).some((key) =>
          typeof key === "symbol" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))))
      throw new Error(`${subject} must be a dense JSON array without custom properties`);
    for (const [index, item] of value.entries())
      assertJsonValue(item, `${subject}[${index}]`, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error(`${subject} must contain only plain JSON objects`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol")
        throw new Error(`${subject} must not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(`${subject}.${key} must be an enumerable JSON value`);
      assertJsonValue(descriptor.value, `${subject}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
