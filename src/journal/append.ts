/**
 * How every record store appends: one record, one whole line, or in a packed
 * shard one whole segment ended by the record separator (stores.ts). A file
 * whose last record has no terminator (a write that crashed partway, or a
 * merge that kept one side's unterminated last line) gets the terminator
 * first, so the new record never runs on into it: the torn record stays one
 * record a reader reports as damaged, and the record after it reads whole.
 *
 * A packed shard is appended to the same way, a byte append and never a
 * rewrite: its records end with U+001E and it holds no newline, so git counts
 * it as one line however many records it holds, and a concurrent writer's
 * append is never lost to a rename.
 *
 * Readers take the other half: they order and fold records by their
 * content, never by their place in a file, and a record that appears twice,
 * which a union merge can keep, is read once. Together the two make a union
 * merge of two branches' appends to one session file safe to take whole.
 */

import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { RECORD_SEPARATOR, isPacked, recordTexts } from "./stores.ts";

/** The byte that ends a record in `file`: the record separator in a packed shard, else the newline. */
function terminator(file: string): number {
  return isPacked(file) ? 0x1e : 0x0a;
}

/** Whether the file ends partway through a record: it holds bytes and the last is not its terminator. A missing file does not. */
function endsTorn(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== terminator(file);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append `line` (one JSON record and its newline) to a store file, ending a
 * torn last record first. In a packed shard the newline is the record
 * separator instead.
 */
export function appendWhole(file: string, line: string): void {
  if (!isPacked(file)) {
    appendFileSync(file, endsTorn(file) ? `\n${line}` : line, "utf8");
    return;
  }
  // A packed shard also starts with the separator, so its one line never begins as a record does: a release's
  // citation search that matches `^{"id":` on a line (1.7.x) skips it instead of reading the whole line as one record.
  const text = `${line.replace(/\n$/, "")}${RECORD_SEPARATOR}`;
  appendFileSync(file, sizeOf(file) <= 0 || endsTorn(file) ? `${RECORD_SEPARATOR}${text}` : text, "utf8");
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/**
 * The records of a store file a reader takes: each with its 1-based number
 * (the line, or in a packed shard the segment), the blank ones left out, and
 * a record identical to one already taken (across every file `seen` has met)
 * left out too, since it is the same record twice, not a second record.
 */
export function storeLines(text: string, seen: Set<string>): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  recordTexts(text).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ line, number: index + 1 });
  });
  return out;
}
