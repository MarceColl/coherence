/**
 * Values crossing between the code and a quint model: a logged argument (as
 * the client's encoder wrote it) becomes a quint literal of the parameter's
 * declared type, a quint state value (as an ITF trace writes it) becomes the
 * same logged form, and a declared type is written back as quint text. A value
 * the type cannot take is refused with why, never coerced: a coerced value
 * would pin a parameter to something the code never produced.
 */

import type { QuintType } from "./model-ir.ts";

/** A value that cannot be written as a literal of its type, and why. */
export class ValueError extends Error {}

function resolved(type: QuintType, types: Readonly<Record<string, QuintType>>): QuintType {
  let at = type;
  for (let i = 0; i < 16 && at.kind === "const" && at.name !== undefined && types[at.name] !== undefined; i += 1) at = types[at.name]!;
  return at;
}

function tagged(value: unknown, tag: string): unknown[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const list = (value as Record<string, unknown>)[tag];
  return Array.isArray(list) ? list : undefined;
}

/** A quint literal of `type` for a logged value. */
export function literal(value: unknown, type: QuintType, types: Readonly<Record<string, QuintType>> = {}): string {
  const t = resolved(type, types);
  switch (t.kind) {
    case "int": {
      const big = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["#bigint"] : undefined;
      const text = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof big === "string" && /^-?\d+$/.test(big) ? big : undefined;
      if (text === undefined) throw new ValueError(`${JSON.stringify(value)} is no int`);
      return text;
    }
    case "str":
      if (typeof value !== "string") throw new ValueError(`${JSON.stringify(value)} is no str`);
      if (/["\\\n\r]/.test(value)) throw new ValueError(`${JSON.stringify(value)} holds a quote, a backslash or a line break, which a quint string cannot`);
      return `"${value}"`;
    case "bool":
      if (typeof value !== "boolean") throw new ValueError(`${JSON.stringify(value)} is no bool`);
      return String(value);
    case "set": {
      const items = tagged(value, "#set") ?? (Array.isArray(value) ? value : undefined);
      if (items === undefined) throw new ValueError(`${JSON.stringify(value)} is no set`);
      return `Set(${items.map((v) => literal(v, t.elem!, types)).join(", ")})`;
    }
    case "list":
      if (!Array.isArray(value)) throw new ValueError(`${JSON.stringify(value)} is no list`);
      return `[${value.map((v) => literal(v, t.elem!, types)).join(", ")}]`;
    case "tup": {
      const items = tagged(value, "#tup") ?? (Array.isArray(value) ? value : undefined);
      const elems = t.fields?.fields?.map((f) => f.fieldType) ?? t.elems ?? [];
      if (items === undefined || items.length !== elems.length) throw new ValueError(`${JSON.stringify(value)} is no ${elems.length}-tuple`);
      return `(${items.map((v, i) => literal(v, elems[i]!, types)).join(", ")})`;
    }
    case "fun": {
      const pairs = tagged(value, "#map") ?? (typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : undefined);
      if (pairs === undefined) throw new ValueError(`${JSON.stringify(value)} is no map`);
      if (pairs.length === 0) return "Map()";
      return `Map(${pairs.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new ValueError(`${JSON.stringify(pair)} is no key and value`);
        return `${literal(pair[0], t.arg!, types)} -> ${literal(pair[1], t.res!, types)}`;
      }).join(", ")})`;
    }
    case "rec": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValueError(`${JSON.stringify(value)} is no record`);
      const fields = t.fields?.fields ?? [];
      const record = value as Record<string, unknown>;
      for (const name of Object.keys(record)) if (!fields.some((f) => f.fieldName === name)) throw new ValueError(`the record carries ${name}, which the type has no field for`);
      return `{ ${fields.map((f) => {
        if (!(f.fieldName in record)) throw new ValueError(`the record lacks its field ${f.fieldName}`);
        return `${f.fieldName}: ${literal(record[f.fieldName], f.fieldType, types)}`;
      }).join(", ")} }`;
    }
    default:
      throw new ValueError(`a parameter of type ${t.kind}${t.name === undefined ? "" : ` ${t.name}`} cannot be pinned from a logged value`);
  }
}

/** A value from an ITF trace in the client's logged form: big ints, sets and maps tagged, tuples as lists, records as objects. */
export function fromItf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromItf);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record["#bigint"] === "string") {
    const big = BigInt(record["#bigint"]);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : { "#bigint": record["#bigint"] };
  }
  if (Array.isArray(record["#set"])) return { "#set": record["#set"].map(fromItf) };
  if (Array.isArray(record["#map"])) return { "#map": (record["#map"] as unknown[][]).map((pair) => pair.map(fromItf)) };
  if (Array.isArray(record["#tup"])) return record["#tup"].map(fromItf);
  return Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith("#")).map(([k, v]) => [k, fromItf(v)]));
}

/** A declared type written as quint text. */
export function typeText(type: QuintType): string {
  switch (type.kind) {
    case "int":
    case "str":
    case "bool":
      return type.kind;
    case "const":
      return type.name ?? "UNKNOWN";
    case "set":
      return `Set[${typeText(type.elem!)}]`;
    case "list":
      return `List[${typeText(type.elem!)}]`;
    case "fun":
      return `${typeText(type.arg!)} -> ${typeText(type.res!)}`;
    case "tup":
      return `(${(type.fields?.fields?.map((f) => f.fieldType) ?? type.elems ?? []).map(typeText).join(", ")})`;
    case "rec":
      return `{ ${(type.fields?.fields ?? []).map((f) => `${f.fieldName}: ${typeText(f.fieldType)}`).join(", ")} }`;
    default:
      throw new ValueError(`a type of kind ${type.kind} cannot be written back`);
  }
}
