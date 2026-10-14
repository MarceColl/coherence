/**
 * The work store: where work orders live, how they are read back, and the
 * binding inference every journal write and every run goes through.
 *
 * Sealed shards per writing session under .coherence/work (shards.ts), append only,
 * with the journal's conventions: id, at, session, agent, commit, dirty. An
 * order is the fold of its records in time order: the order record sets the
 * content and the first owner; moves and the close set its state;
 * owner records move its owner. Nothing here grants or refuses anything: an
 * order is context, and the binding is how a reader finds everything one
 * assignment produced.
 *
 * Binding is inferred, never flagged by default: a session that owns exactly
 * one active order binds every record it writes to that order. A session
 * owning none or several binds nothing, and the record says which.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendWhole, storeLines } from "./append.ts";
import { JournalError } from "./args.ts";
import { isWorkKind, TERMINAL_STATES, type WorkRecord, type WorkState } from "./record.ts";
import { shardFor } from "./shards.ts";
import { isStoreFile, storeDir } from "./stores.ts";

export const WORK_DIR = storeDir("work");

/** A session names its file, so it must be a plain file-safe token. */
export const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function workDir(cwd: string): string {
  return join(cwd, WORK_DIR);
}

export function workFile(cwd: string, session: string): string {
  if (!SESSION_TOKEN.test(session)) {
    throw new JournalError(`session "${session}" cannot name a file; use letters, digits, dot, dash, or underscore`);
  }
  return join(workDir(cwd), `${session}.jsonl`);
}

/** Append one work record to the session's shard (shards.ts); the file and directory are created on first write. Returns the shard's path. */
export function appendWork(cwd: string, record: WorkRecord): string {
  workFile(cwd, record.session);
  mkdirSync(workDir(cwd), { recursive: true });
  const shard = shardFor(cwd, "work", record.session);
  appendWhole(shard.file, `${JSON.stringify(record)}\n`);
  shard.kept();
  return shard.file;
}

export interface WorkDamaged {
  file: string;
  line: number;
  reason: string;
}

export interface LoadedWork {
  /** Every readable work record across every session, oldest first. */
  records: WorkRecord[];
  damaged: WorkDamaged[];
}

function compareWork(a: WorkRecord, b: WorkRecord): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function loadWork(cwd: string): LoadedWork {
  const dir = workDir(cwd);
  const loaded: LoadedWork = { records: [], damaged: [] };
  if (!existsSync(dir)) return loaded;
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter(isStoreFile).sort()) {
    for (const { line, number } of storeLines(readFileSync(join(dir, name), "utf8"), seen)) {
      const verdict = parseWorkLine(line);
      if (typeof verdict === "string") loaded.damaged.push({ file: join(WORK_DIR, name), line: number, reason: verdict });
      else loaded.records.push(verdict);
    }
  }
  loaded.records.sort(compareWork);
  return loaded;
}

function parseWorkLine(line: string): WorkRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a record object";
  const record = value as Record<string, unknown>;
  for (const field of ["id", "kind", "at", "session", "agent"]) {
    if (typeof record[field] !== "string" || record[field] === "") return `missing ${field}`;
  }
  const kind = record["kind"] as string;
  if (!isWorkKind(kind)) return `unknown kind "${kind}"`;
  if (Number.isNaN(Date.parse(record["at"] as string))) return `unreadable time "${String(record["at"])}"`;
  return value as WorkRecord;
}

/** One order as a reader sees it: the fold of its records in time order. */
export interface WorkOrder {
  id: string;
  objective: string;
  success: string;
  boundary: string;
  /** The session that owns it now. */
  owner: string;
  state: WorkState;
  /** When and by whom it was created. */
  at: string;
  session: string;
  agent: string;
  /** Every record about it after the order record, oldest first. */
  history: Exclude<WorkRecord, { kind: "order" }>[];
  /** The records the order record cites, when it cites any; its moves and close carry their own. */
  cites?: string[];
}

/** Every order, oldest first, folded from the loaded records; a record about an unknown order is skipped. */
export function foldOrders(loaded: LoadedWork): WorkOrder[] {
  const orders = new Map<string, WorkOrder>();
  for (const record of loaded.records) {
    if (record.kind === "order") {
      orders.set(record.id, {
        id: record.id,
        objective: record.objective,
        success: record.success,
        boundary: record.boundary,
        owner: record.owner,
        state: "open",
        at: record.at,
        session: record.session,
        agent: record.agent,
        history: [],
        ...(record.cites === undefined ? {} : { cites: record.cites }),
      });
      continue;
    }
    const order = orders.get(record.of);
    if (order === undefined) continue;
    order.history.push(record);
    if (record.kind === "owner") order.owner = record.owner;
    else order.state = record.state;
  }
  return [...orders.values()];
}

export function loadOrders(cwd: string): WorkOrder[] {
  return foldOrders(loadWork(cwd));
}

export function isTerminal(state: WorkState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The orders a session owns in a given state, oldest first. */
export function ownedIn(orders: readonly WorkOrder[], session: string, state: WorkState): WorkOrder[] {
  return orders.filter((order) => order.owner === session && order.state === state);
}

/** What the append settles about a record's work order. */
export interface WorkBinding {
  work?: string;
  binding: string;
}

/**
 * The binding a record written by `session` carries. With `given` (a --work
 * flag) the order must exist. Without it: the one active order the session
 * owns, or nothing, with the reason in the record.
 */
export function workBinding(cwd: string, session: string, given?: string): WorkBinding {
  const orders = loadOrders(cwd);
  if (given !== undefined) {
    if (!orders.some((order) => order.id === given)) throw new JournalError(`--work ${given}: no work order with that id`);
    return { work: given, binding: "flag" };
  }
  const active = ownedIn(orders, session, "active");
  if (active.length === 1) return { work: active[0]!.id, binding: "inferred: the one active order this session owns" };
  if (active.length === 0) return { binding: "none: this session owns no active work order" };
  return { binding: `none: this session owns ${active.length} active work orders (${active.map((o) => o.id).join(", ")}); pass --work <id>` };
}

/** The binding as one printed line, for the verbs and the hook. */
export function describeBinding(bound: WorkBinding): string {
  return bound.work === undefined ? `bound to no work order (${bound.binding.replace(/^none: /, "")})` : `bound to ${bound.work} (${bound.binding})`;
}
