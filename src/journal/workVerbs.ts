/**
 * The work verbs: one command, five subcommands, each an appended record or a read.
 *
 *   work create "<objective>" --success "<criterion>" --boundary "<files>" [--owner-session <id>] [--cite <id>]...
 *   work move <id> <state> --because "<why>" [--cite <id>]...   (state: one of MOVE_STATES)
 *   work close <id> --because "<what was done>" [--cite <id>]...
 *   work owner <id> --owner-session <id> --because "<why>"
 *   work inspect [<id>]
 *
 * Every write takes --session and --agent. An order grants nothing
 * and refuses nothing: anyone may move it or change its owner, and the record
 * says who did. Content is what a reader wants: the objective, the
 * observable success criterion, the boundary, and everything the owner
 * session wrote while it held the order.
 *
 * A create, move or close may cite earlier records with --cite, checked as
 * every journal citation is; a decision id written into a because stays
 * text, and --cite is how it becomes a citation a reader can follow.
 */

import { relative } from "node:path";
import { loadRuns, type RunRecord } from "../enforcement/record.ts";
import { JournalError, onePositional, parseFlags, required } from "./args.ts";
import { GLYPH, MOVE_STATES, alternation, spoken, anySubjectOf, citedBy, citesOf, isWorkState, subjectOf, kindLabel, type AnyRecord, type JournalRecord, type WorkCompletion, type WorkOrderRecord, type WorkOwner, type WorkMove, type WorkRecord } from "./record.ts";
import { loadJournal } from "./store.ts";
import { CITE, attribution, citations, head, vetted, withCommon, type Context, type Written } from "./verbs.ts";
import { appendWork, isTerminal, loadOrders, type WorkOrder } from "./work.ts";

/** What a work verb prints on success; the first line starts with the record id. */
export interface WorkWritten {
  lines: string[];
}

/** The one way a work record reaches its store: vetted first, so a record the vet stands against is refused before anything is written. */
function writeWork(ctx: Context, record: WorkRecord): string {
  vetted(ctx, record);
  return relative(ctx.cwd, appendWork(ctx.cwd, record));
}

function orderOrRefuse(cwd: string, id: string, verb: string): WorkOrder {
  const found = loadOrders(cwd).find((order) => order.id === id);
  if (found === undefined) throw new JournalError(`work ${verb}: no work order with id ${id}`);
  return found;
}

function refuseTerminal(order: WorkOrder, verb: string): void {
  if (isTerminal(order.state)) throw new JournalError(`work ${verb}: ${order.id} is ${order.state}; a closed or cancelled order does not move`);
}

function create(argv: string[], ctx: Context): WorkWritten {
  const parsed = parseFlags(argv, withCommon({ success: "one", boundary: "one", "owner-session": "one", ...CITE }));
  const who = attribution(parsed);
  if (who.work !== undefined) throw new JournalError("work create: --work names a journal record's order, not a new order's");
  const objective = onePositional(parsed, "objective");
  const success = required(parsed, "success", "an order names the observable criterion that completes it");
  const boundary = required(parsed, "boundary", "an order names the folders or files its owner may write");
  const owner = parsed.one.get("owner-session") ?? who.session;
  const record: WorkOrderRecord = { ...head("order", who, ctx, objective), objective, success, boundary, owner, ...citations(parsed, ctx.cwd) };
  const file = writeWork(ctx, record);
  return {
    lines: [
      `${record.id}  work order recorded in ${file}; owner ${owner}; state open`,
      ...citeLines(record),
      `  nothing binds to it until its owner activates it: work move ${record.id} active --because "<taking it up>" --session ${owner} --agent <name>`,
    ],
  };
}

function move(argv: string[], ctx: Context): WorkWritten {
  const parsed = parseFlags(argv, withCommon({ because: "one", ...CITE }));
  const who = attribution(parsed);
  const [id, state, ...rest] = parsed.positionals;
  if (id === undefined || state === undefined) throw new JournalError("work move takes <id> <state>");
  if (rest.length > 0) throw new JournalError(`work move: unexpected argument "${rest[0]}"`);
  if (!isWorkState(state)) throw new JournalError(`work move: "${state}" is not ${spoken(MOVE_STATES)}`);
  if (state === "completed") throw new JournalError(`work move: completed is what close records; run: work close ${id} --because "<what was done>"`);
  const because = required(parsed, "because", "a move records why the order moved");
  const order = orderOrRefuse(ctx.cwd, id, "move");
  refuseTerminal(order, "move");
  if (order.state === state) throw new JournalError(`work move: ${id} is already ${state}`);
  const record: WorkMove = { ...head("move", who, ctx, `${id}\n${state}\n${because}`), of: id, state, because, ...citations(parsed, ctx.cwd) };
  const file = writeWork(ctx, record);
  return { lines: [`${record.id}  ${id} ${order.state} -> ${state} recorded in ${file}`, ...citeLines(record)] };
}

function close(argv: string[], ctx: Context): WorkWritten {
  const parsed = parseFlags(argv, withCommon({ because: "one", ...CITE }));
  const who = attribution(parsed);
  const id = onePositional(parsed, "work order id");
  const because = required(parsed, "because", "a close records what was done against the success criterion");
  const order = orderOrRefuse(ctx.cwd, id, "close");
  refuseTerminal(order, "close");
  const record: WorkCompletion = { ...head("completion", who, ctx, `${id}\n${because}`), of: id, state: "completed", because, ...citations(parsed, ctx.cwd) };
  const file = writeWork(ctx, record);
  return { lines: [`${record.id}  ${id} ${order.state} -> completed recorded in ${file}`, ...citeLines(record)] };
}

function owner(argv: string[], ctx: Context): WorkWritten {
  const parsed = parseFlags(argv, withCommon({ "owner-session": "one", because: "one" }));
  const who = attribution(parsed);
  const id = onePositional(parsed, "work order id");
  const next = required(parsed, "owner-session", "the session that owns the order from here");
  const because = required(parsed, "because", "an owner change records why");
  const order = orderOrRefuse(ctx.cwd, id, "owner");
  refuseTerminal(order, "owner");
  if (order.owner === next) throw new JournalError(`work owner: ${id} is already owned by ${next}`);
  const record: WorkOwner = { ...head("owner", who, ctx, `${id}\n${next}\n${because}`), of: id, owner: next, because };
  const file = writeWork(ctx, record);
  return { lines: [`${record.id}  ${id} owner ${order.owner} -> ${next} recorded in ${file}`] };
}

function citeLines(record: AnyRecord): string[] {
  return citesOf(record).length > 0 ? [`  cites ${citesOf(record).join(", ")}`] : [];
}

function stamp(at: string): string {
  return `${at.slice(0, 10)} ${at.slice(11, 16)}`;
}

/** The line that names a record from either store in a list of related records: time, id, kind, agent, subject. */
export function relatedLine(record: AnyRecord): string {
  return `${stamp(record.at)} ${record.id}  ${kindLabel(record)}  ${record.agent}  ${anySubjectOf(record)}`;
}

/** Every record the order's own records cite, in the order they were written, with the record that cites it. */
function orderCites(order: WorkOrder): { by: string; id: string }[] {
  return [
    ...(order.cites ?? []).map((id) => ({ by: order.id, id })),
    ...order.history.flatMap((event) => citesOf(event).map((id) => ({ by: event.id, id }))),
  ];
}

/** The work records an order fold came from: each order's own record and its history. */
export function workRecordsOf(orders: readonly WorkOrder[]): AnyRecord[] {
  return orders.flatMap((order): AnyRecord[] => [
    { id: order.id, kind: "order", at: order.at, session: order.session, agent: order.agent, commit: null, dirty: false, objective: order.objective, success: order.success, boundary: order.boundary, owner: order.owner, ...(order.cites === undefined ? {} : { cites: order.cites }) },
    ...order.history,
  ]);
}

/** Time order, then id, for records from either store. */
function byTime(a: AnyRecord, b: AnyRecord): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One order with everything related to it: its history, the records it
 * cites, the journal records bound to it, the records that cite it or one
 * of its own records, and the runs bound to it. `orders` is every order, so
 * a work record that cites this one is found too.
 */
export function renderOrder(order: WorkOrder, journal: readonly JournalRecord[], runs: readonly RunRecord[], orders: readonly WorkOrder[] = [order]): string[] {
  const lines = [
    `${order.id}  ${order.state}  owner ${order.owner}`,
    `  objective: ${order.objective}`,
    `  success:   ${order.success}`,
    `  boundary:  ${order.boundary}`,
    `  created ${stamp(order.at)} by ${order.agent} (${order.session})`,
  ];
  for (const event of order.history) {
    const what = event.kind === "owner" ? `owner -> ${event.owner}` : `-> ${event.state}`;
    lines.push(`  ${stamp(event.at)} ${event.id}  ${what}  ${event.agent}: ${event.because}`);
  }
  const everything: AnyRecord[] = [...journal, ...workRecordsOf(orders)];
  const byId = new Map(everything.map((record) => [record.id, record]));
  const cites = orderCites(order);
  lines.push(`  cites: ${cites.length}`);
  for (const { by, id } of cites) {
    const found = byId.get(id);
    lines.push(`    ${found === undefined ? `${id}  (not in the stores read)` : relatedLine(found)}${by === order.id ? "" : `  [cited by ${by}]`}`);
  }
  const bound = journal.filter((record) => record.work === order.id);
  lines.push(`  journal records bound: ${bound.length}`);
  for (const record of bound) lines.push(`    ${stamp(record.at)} ${GLYPH[record.kind]} ${record.id}  ${record.agent}  ${subjectOf(record)}`);
  const own = new Set([order.id, ...order.history.map((event) => event.id)]);
  const index = citedBy(everything);
  const citing = new Map<string, AnyRecord>();
  for (const id of own) for (const record of index.get(id) ?? []) if (!own.has(record.id)) citing.set(record.id, record);
  const citers = [...citing.values()].sort(byTime);
  lines.push(`  cited by: ${citers.length}`);
  for (const record of citers) lines.push(`    ${relatedLine(record)}  [cites ${citesOf(record).filter((id) => own.has(id)).join(", ")}]`);
  const boundRuns = runs.filter((run) => (run as RunRecord & { work?: string }).work === order.id);
  lines.push(`  runs bound: ${boundRuns.length}`);
  for (const run of boundRuns) {
    const fails = run.invariants.filter((e) => e.verdict === "fail").length;
    lines.push(`    ${stamp(run.at)} run by ${run.agent}: ${run.invariants.length} enforcements, ${fails} fail, at ${run.commit ?? "no commit"}`);
  }
  return lines;
}

function inspect(argv: string[], ctx: Context): WorkWritten {
  const parsed = parseFlags(argv, {});
  const [id, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new JournalError(`work inspect: unexpected argument "${rest[0]}"`);
  const orders = loadOrders(ctx.cwd);
  if (id === undefined) {
    if (orders.length === 0) return { lines: ["no work orders"] };
    return { lines: orders.map((order) => `${order.id}  ${order.state.padEnd(9)}  ${order.owner}  ${order.objective}`) };
  }
  const order = orders.find((o) => o.id === id);
  if (order === undefined) throw new JournalError(`work inspect: no work order with id ${id}`);
  return { lines: renderOrder(order, loadJournal(ctx.cwd).records, loadRuns(ctx.cwd).records, orders) };
}

export function work(argv: string[], ctx: Context): Written | WorkWritten {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create":
      return create(rest, ctx);
    case "move":
      return move(rest, ctx);
    case "close":
      return close(rest, ctx);
    case "owner":
      return owner(rest, ctx);
    case "inspect":
      return inspect(rest, ctx);
    default:
      throw new JournalError('work takes "create", "move", "close", "owner", or "inspect"');
  }
}

export const WORK_USAGE = [
  "work orders (writes need --session <id> --agent <name>; binding to journal writes and runs is inferred from sole active ownership):",
  '  work create "<objective>" --success "<observable criterion>" --boundary "<folders or files the owner may write>" [--owner-session <id>] [--cite <id>]...',
  `  work move <id> <${alternation(MOVE_STATES)}> --because "<why>" [--cite <id>]...`,
  '  work close <id> --because "<what was done>" [--cite <id>]...',
  '  work owner <id> --owner-session <id> --because "<why>"',
  "  work inspect [<id>]",
].join("\n");
