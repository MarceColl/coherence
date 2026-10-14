/**
 * The journal verbs: each one turns a command line into one appended record.
 *
 * A verb that points at an earlier record (retract, resolved, dismiss,
 * experiment close, acknowledge) reads the journal first and refuses an id it
 * cannot find or a target of the wrong kind; it never edits the target. A verb
 * that writes a new subject (decide, conjecture, defect, experiment create,
 * unable, escalate) needs nothing but its own fields and the attribution every
 * write requires.
 *
 * A verb that writes a new subject, and the work verbs that create, move or
 * close an order, may cite earlier records with --cite <id>, repeated. Every
 * cited id must name a record already in the journal or the work store, of
 * any kind; one that does not refuses the whole write. decide, escalate and
 * acknowledge take --human "<what the human said>": the words the agent
 * attributes to a human, stored apart from its own because.
 */

import { JournalError, onePositional, parseFlags, required, type FlagShape, type Parsed } from "./args.ts";
import {
  INSTRUMENT_IS_WRONG,
  deriveOutcome,
  enactmentTally,
  citesOf,
  pointsAt,
  recordId,
  type Acknowledgement,
  type Attribution,
  type Close,
  type Conjecture,
  type Decision,
  type Defect,
  type Escalation,
  type Experiment,
  type JournalRecord,
  type Kind,
  type Resolution,
  type Retraction,
  type Stamp,
  type Step,
  type StepResult,
  type Unable,
  type Dismissal,
  type Enactment,
  type StepOutcome,
  type WorkKind,
  STEP_RESULTS,
  alternation,
  spoken,
} from "./record.ts";
import { loadSpecModel, projectPractices } from "../spec/model.ts";
import { originFields } from "./defects.ts";
import { amendCommand, floorGaps, type ModelPractice } from "../spec/practices.ts";
import { appendRecordTo, gitState, loadJournal, type Loaded } from "./store.ts";
import { describeBinding, loadWork } from "./work.ts";
import { recordsOnOtherBranches } from "./branches.ts";
import { recordDefectTelemetry } from "../lifecycle/telemetry.ts";

export interface Context {
  cwd: string;
  now: () => Date;
  /**
   * What stands against a record before it is written, one line each: the
   * command line supplies the lexicon's rejected names; none when absent.
   */
  vet?: (record: object) => string[];
}

/** Refuse a record the vet stands against, before anything is written: the store is append-only. */
export function vetted(ctx: Context, record: object): void {
  const problems = ctx.vet?.(record) ?? [];
  if (problems.length > 0) throw new JournalError(`nothing was written; the store is append-only, so reword this record first:\n${problems.map((p) => `  ${p}`).join("\n")}`);
}

export interface Written {
  record: JournalRecord;
  /** What the verb prints on success; the first line starts with the new id. */
  lines: string[];
}

/** Every verb takes attribution; --work names the work order when the inferred binding is not wanted. */
const COMMON: Record<string, FlagShape> = { session: "one", agent: "one", work: "one" };

export function withCommon(spec: Record<string, FlagShape>): Record<string, FlagShape> {
  return { ...COMMON, ...spec };
}

export function attribution(parsed: Parsed): Attribution {
  const session = required(parsed, "session", "every record binds through its session");
  const agent = required(parsed, "agent", "every record names the agent that wrote it");
  const work = parsed.one.get("work");
  return work === undefined ? { session, agent } : { session, agent, work };
}

/**
 * The head every record shares, in the journal and in the work store. The id
 * hashes session, time, and the record's text; this is the one site that
 * mints one.
 */
export function head<K extends Kind | WorkKind>(kind: K, who: Attribution, ctx: Context, text: string): Stamp<K> & { work?: string } {
  const at = ctx.now().toISOString();
  const { commit, dirty } = gitState(ctx.cwd);
  return { id: recordId(kind, who.session, at, text), kind, at, ...who, commit, dirty };
}

/** The flag that cites earlier records, for every verb that may cite. */
export const CITE: Record<string, FlagShape> = { cite: "many" };

/**
 * The records a write cites, checked against both stores: each --cite must
 * name a record already in the journal or the work store, of any kind, or
 * one another branch has committed (a parallel session's, before it merges),
 * and none may be given twice. An id found nowhere is refused: that is a typo. Returns the field to spread into the record,
 * empty when nothing is cited, so a record that cites nothing looks exactly
 * like one written before citations existed. This is the one site that
 * accepts a citation.
 */
export function citations(parsed: Parsed, cwd: string): { cites?: string[] } {
  const given = parsed.many.get("cite") ?? [];
  if (given.length === 0) return {};
  const known = new Set<string>([
    ...loadJournal(cwd).records.map((record) => record.id),
    ...loadWork(cwd).records.map((record) => record.id),
  ]);
  const seen = new Set<string>();
  for (const id of given) {
    if (id.trim() === "") throw new JournalError("--cite needs a record id");
    if (seen.has(id)) throw new JournalError(`--cite ${id} given twice`);
    seen.add(id);
  }
  const unknown = given.filter((id) => !known.has(id));
  const elsewhere = unknown.length === 0 ? new Map() : recordsOnOtherBranches(cwd, unknown);
  const missing = unknown.find((id) => !elsewhere.has(id));
  if (missing !== undefined) throw new JournalError(`--cite ${missing}: no journal or work record has that id, here or committed on another branch; cite a record that exists (journal, work inspect)`);
  return { cites: given };
}

/** Each cited id, with the branch that holds it when this checkout does not. */
function citedWhere(cwd: string, ids: readonly string[]): string[] {
  const local = new Set<string>([...loadJournal(cwd).records.map((r) => r.id), ...loadWork(cwd).records.map((r) => r.id)]);
  const elsewhere = recordsOnOtherBranches(cwd, ids.filter((id) => !local.has(id)));
  return ids.map((id) => {
    const found = elsewhere.get(id);
    return found === undefined ? id : `${id} (on branch ${found.branch}, not in this checkout)`;
  });
}

/** The words a human said, as the agent attributes them; refused when given blank. */
function humanWords(parsed: Parsed): { human?: string } {
  const human = parsed.one.get("human");
  if (human === undefined) return {};
  if (human.trim() === "") throw new JournalError("--human needs the words the human said");
  return { human };
}

function write(ctx: Context, record: JournalRecord, extra: string[] = []): Written {
  vetted(ctx, record);
  const { record: written, file } = appendRecordTo(ctx.cwd, record);
  return {
    record: written,
    lines: [
      `${written.id}  ${written.kind} recorded in ${file}`,
      `  ${describeBinding({ binding: written.binding ?? "none: unsettled", ...(written.work === undefined ? {} : { work: written.work }) })}`,
      ...(citesOf(written).length > 0 ? [`  cites ${citedWhere(ctx.cwd, citesOf(written)).join(", ")}`] : []),
      ...extra,
    ],
  };
}

/** The record an id names, refused when absent or of another kind. */
function target<K extends Kind>(loaded: Loaded, id: string, kind: K | null, verb: string): JournalRecord & { kind: K } {
  const found = loaded.records.find((record) => record.id === id);
  if (found === undefined) throw new JournalError(`${verb}: no record with id ${id}`);
  if (kind !== null && found.kind !== kind) {
    throw new JournalError(`${verb}: ${id} is a ${found.kind}, not a ${kind}`);
  }
  return found as JournalRecord & { kind: K };
}

/** Records that already point at an id, so a second resolution or close is refused. */
function pointers(loaded: Loaded, id: string): JournalRecord[] {
  return loaded.records.filter((record) => pointsAt(record) === id);
}

function refuseIfAnswered(loaded: Loaded, id: string, verb: string, kinds: readonly Kind[]): void {
  // A retracted answer answers nothing: a defect closed without a guard can be closed again after its resolution is retracted.
  const withdrawn = new Set(loaded.records.flatMap((r) => (r.kind === "retraction" ? [r.of] : [])));
  const prior = pointers(loaded, id).find((record) => kinds.includes(record.kind) && !withdrawn.has(record.id));
  if (prior !== undefined) {
    throw new JournalError(`${verb}: ${id} was already answered by ${prior.id} (${prior.kind})`);
  }
}

export function decide(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ over: "many", because: "one", human: "one", ...CITE }));
  const who = attribution(parsed);
  const chose = onePositional(parsed, "what was chosen");
  const because = required(parsed, "because", "a decision records why");
  const given = parsed.many.get("over") ?? [];
  let over: string[] | "none";
  if (given.length === 0) {
    over = [];
  } else if (given.some((value) => value.trim().toLowerCase() === "none")) {
    if (given.length > 1) throw new JournalError("--over none cannot be combined with a rejected alternative");
    over = "none";
  } else {
    over = given;
  }
  const record: Decision = { ...head("decision", who, ctx, chose), chose, over, because, ...humanWords(parsed), ...citations(parsed, ctx.cwd) };
  return write(ctx, record);
}

export function retract(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one" }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the id to retract");
  const because = required(parsed, "because", "a retraction records what refuted the record");
  const loaded = loadJournal(ctx.cwd);
  const found = target(loaded, of, null, "retract");
  if (found.kind === "retraction") throw new JournalError(`retract: ${of} is itself a retraction`);
  refuseIfAnswered(loaded, of, "retract", ["retraction"]);
  const record: Retraction = { ...head("retraction", who, ctx, `${of}\n${because}`), of, because };
  return write(ctx, record);
}

export function conjecture(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ "could-be": "many", "discriminated-by": "one", ...CITE }));
  const who = attribution(parsed);
  const observation = onePositional(parsed, "the observation");
  const discriminatedBy = required(parsed, "discriminated-by", "a conjecture names the test that separates its candidates");
  const named = parsed.many.get("could-be") ?? [];
  const hasInstrument = named.some((value) => value.trim().toLowerCase() === INSTRUMENT_IS_WRONG);
  const couldBe = hasInstrument ? named : [INSTRUMENT_IS_WRONG, ...named];
  const record: Conjecture = {
    ...head("conjecture", who, ctx, observation),
    observation,
    couldBe,
    discriminatedBy,
    ...citations(parsed, ctx.cwd),
  };
  return write(ctx, record);
}

/** The --class, --introduced and --caught flags a defect, its classification and its close take. */
const ORIGIN: Record<string, FlagShape> = { class: "one", introduced: "one", caught: "one" };

function originGiven(parsed: Parsed): { class?: string | undefined; introduced?: string | undefined; caught?: string | undefined } {
  return { class: parsed.one.get("class"), introduced: parsed.one.get("introduced"), caught: parsed.one.get("caught") };
}

/**
 * Resolve a conjecture, or close a defect. A defect's close names a guard for
 * its whole class (--guard <component folder>/<invariant>, an invariant some
 * spec declares) or a decision saying why fixing the instance suffices
 * (--decision <id>), or both; a close with neither is written and spec
 * --check names it. A retracted resolution no longer answers its target.
 */
export function resolved(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one", as: "one", guard: "one", decision: "one", ...ORIGIN }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the conjecture or defect id");
  const because = required(parsed, "because", "a resolution records what the test showed, or what fixed the defect");
  const loaded = loadJournal(ctx.cwd);
  const found = target(loaded, of, null, "resolved");
  if (found.kind !== "conjecture" && found.kind !== "defect") throw new JournalError(`resolved: ${of} is a ${found.kind}, not a conjecture or a defect`);
  refuseIfAnswered(loaded, of, "resolved", ["resolution", "dismissal"]);
  const as = parsed.one.get("as");
  const guard = parsed.one.get("guard");
  const decision = parsed.one.get("decision");
  const given = originGiven(parsed);
  if (found.kind === "conjecture") {
    const defectOnly = [guard === undefined ? "" : "--guard", decision === undefined ? "" : "--decision", ...Object.entries(given).map(([k, v]) => (v === undefined ? "" : `--${k}`))].filter((f) => f !== "");
    if (defectOnly.length > 0) throw new JournalError(`resolved: ${defectOnly.join(", ")} close a defect; ${of} is a conjecture`);
    const record: Resolution = { ...head("resolution", who, ctx, `${of}\n${because}`), of, because, ...(as === undefined ? {} : { as }) };
    return write(ctx, record);
  }
  if (as !== undefined) throw new JournalError(`resolved: --as names a conjecture's winning candidate; ${of} is a defect`);
  if (guard !== undefined) checkGuard(ctx.cwd, guard);
  if (decision !== undefined) {
    const d = loaded.records.find((r) => r.id === decision);
    if (d === undefined) throw new JournalError(`resolved: --decision ${decision}: no record with that id`);
    if (d.kind !== "decision") throw new JournalError(`resolved: --decision ${decision} is a ${d.kind}, not a decision`);
  }
  const record: Resolution = {
    ...head("resolution", who, ctx, `${of}\n${because}`),
    of,
    because,
    ...(guard === undefined ? {} : { guard }),
    ...(decision === undefined ? {} : { decision }),
    ...originFields(given, ctx.cwd),
  };
  const extra =
    guard === undefined && decision === undefined
      ? [`  closed with neither a guard nor a decision: spec --check names it; a guard for the class (--guard <component>/<invariant>) or a decision (--decision <id>) is what a close owes`]
      : [];
  return write(ctx, record, extra);
}

/** A guard names an invariant a spec in this project declares, as <component folder>/<name>. */
function checkGuard(root: string, guard: string): void {
  const slash = guard.lastIndexOf("/");
  const folder = slash === -1 ? "" : guard.slice(0, slash);
  const name = slash === -1 ? guard : guard.slice(slash + 1);
  let model;
  try {
    model = loadSpecModel(root, { runs: false });
  } catch (error) {
    throw new JournalError(`resolved: --guard ${guard}: the specs cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  const component = model.components.find((c) => c.folder === folder);
  if (slash === -1 || component === undefined) throw new JournalError(`resolved: --guard ${guard} reads <component folder>/<invariant name>; components: ${model.components.map((c) => c.folder).join(", ")}`);
  if (!component.invariants.some((i) => i.name === name)) throw new JournalError(`resolved: --guard ${guard}: ${folder} declares no invariant named "${name}"`);
}

/**
 * Classify a defect after the fact: a decision citing it, carrying the class,
 * origin and catch it gives. The defect is never edited; every reader folds
 * the classification into it (defects.ts).
 */
export function classify(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one", over: "many", ...ORIGIN }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the defect id");
  const because = required(parsed, "because", "a classification records the evidence it rests on");
  const loaded = loadJournal(ctx.cwd);
  target(loaded, of, "defect", "classify");
  const fields = originFields(originGiven(parsed), ctx.cwd);
  if (Object.keys(fields).length === 0) throw new JournalError("classify: give at least one of --class, --introduced, --caught");
  const said = [fields.class === undefined ? "" : `class ${fields.class}`, fields.introduced === undefined ? "" : `introduced ${fields.introduced}`, fields.caught === undefined ? "" : `caught ${fields.caught}`].filter((s) => s !== "");
  const chose = `classify ${of}: ${said.join(", ")}`;
  const given = parsed.many.get("over") ?? [];
  const over: string[] | "none" = given.length === 1 && given[0]!.trim().toLowerCase() === "none" ? "none" : given;
  const record: Decision = { ...head("decision", who, ctx, chose), classifies: { of, ...fields }, chose, over, because, cites: [of] };
  return write(ctx, record);
}

export function dismiss(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one" }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the conjecture id");
  const because = required(parsed, "because", "a dismissal records why nobody will chase the conjecture");
  const loaded = loadJournal(ctx.cwd);
  target(loaded, of, "conjecture", "dismiss");
  refuseIfAnswered(loaded, of, "dismiss", ["resolution", "dismissal"]);
  const record: Dismissal = { ...head("dismissal", who, ctx, `${of}\n${because}`), of, because };
  return write(ctx, record);
}

export function defect(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ evidence: "one", file: "many", ...ORIGIN, ...CITE }));
  const who = attribution(parsed);
  const what = onePositional(parsed, "what failed");
  const evidence = required(parsed, "evidence", "a defect carries the reproducer or report that made it one");
  const files = parsed.many.get("file") ?? [];
  const record: Defect = { ...head("defect", who, ctx, what), what, evidence, files, ...originFields(originGiven(parsed), ctx.cwd), ...citations(parsed, ctx.cwd) };
  const written = write(ctx, record);
  recordDefectTelemetry(ctx.cwd, record);
  return written;
}

export function experiment(argv: string[], ctx: Context): Written {
  const [sub, ...rest] = argv;
  if (sub === "create") return experimentCreate(rest, ctx);
  if (sub === "close") return experimentClose(rest, ctx);
  throw new JournalError('experiment takes "create" or "close"');
}

function experimentCreate(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ context: "many", action: "many", success: "many", ...CITE }));
  const who = attribution(parsed);
  const expectation = onePositional(parsed, "the expectation");
  const context = parsed.many.get("context") ?? [];
  const actionTexts = parsed.many.get("action") ?? [];
  const successTexts = parsed.many.get("success") ?? [];
  if (actionTexts.length === 0) throw new JournalError("--action is required: an experiment plans at least one action");
  if (successTexts.length === 0) {
    throw new JournalError("--success is required: an experiment names at least one observable criterion");
  }
  const base = head("experiment", who, ctx, expectation);
  const steps = (prefix: string, texts: string[]): Step[] =>
    texts.map((text, index) => ({ id: `${base.id}.${prefix}${index + 1}`, text }));
  const record: Experiment = {
    ...base,
    expectation,
    context,
    actions: steps("a", actionTexts),
    criteria: steps("c", successTexts),
    ...citations(parsed, ctx.cwd),
  };
  const ids = [...record.actions, ...record.criteria];
  const template = [
    `experiment close ${record.id} --session ${who.session} --agent ${who.agent}`,
    ...ids.map((step) => `  --result ${step.id}=<${alternation(STEP_RESULTS)}>`),
  ].join(" \\\n");
  return write(ctx, record, [
    ...record.actions.map((step) => `  action    ${step.id}  ${step.text}`),
    ...record.criteria.map((step) => `  criterion ${step.id}  ${step.text}`),
    "close with:",
    template,
  ]);
}

function experimentClose(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ result: "many" }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the experiment id");
  const loaded = loadJournal(ctx.cwd);
  const open = target(loaded, of, "experiment", "experiment close");
  refuseIfAnswered(loaded, of, "experiment close", ["close"]);
  const results: Record<string, StepResult> = {};
  for (const pair of parsed.many.get("result") ?? []) {
    const equals = pair.indexOf("=");
    if (equals === -1) throw new JournalError(`--result "${pair}" must be <id>=<${alternation(STEP_RESULTS)}>`);
    const id = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!(STEP_RESULTS as readonly string[]).includes(value)) {
      throw new JournalError(`--result ${id}: "${value}" is not ${spoken(STEP_RESULTS)}`);
    }
    if (Object.hasOwn(results, id)) throw new JournalError(`--result ${id} given twice`);
    results[id] = value as StepResult;
  }
  const expected = [...open.actions, ...open.criteria].map((step) => step.id);
  const missing = expected.filter((id) => !Object.hasOwn(results, id));
  if (missing.length > 0) {
    throw new JournalError(`experiment close: every action and criterion needs a result; missing ${missing.join(", ")}`);
  }
  const unknown = Object.keys(results).filter((id) => !expected.includes(id));
  if (unknown.length > 0) throw new JournalError(`experiment close: ${of} has no step ${unknown.join(", ")}`);
  const outcome = deriveOutcome(expected.map((id) => results[id] as StepResult));
  const record: Close = { ...head("close", who, ctx, of), of, results, outcome };
  return write(ctx, record, [`  outcome ${outcome}`]);
}

export function unable(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one", ...CITE }));
  const who = attribution(parsed);
  const what = onePositional(parsed, "what you could not do");
  const because = required(parsed, "because", "unable names the wall");
  const record: Unable = { ...head("unable", who, ctx, what), what, because, ...citations(parsed, ctx.cwd) };
  return write(ctx, record);
}

export function escalate(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one", human: "one", ...CITE }));
  const who = attribution(parsed);
  const what = onePositional(parsed, "what a human must see");
  const because = required(parsed, "because", "an escalation records why a human");
  const record: Escalation = { ...head("escalation", who, ctx, what), what, because, ...humanWords(parsed), ...citations(parsed, ctx.cwd) };
  return write(ctx, record, ["  this escalation heads every read until a human acknowledges it"]);
}

export function acknowledge(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ because: "one", human: "one" }));
  const who = attribution(parsed);
  const of = onePositional(parsed, "the escalation id");
  const because = required(parsed, "because", "an acknowledgement records what the human decided");
  const loaded = loadJournal(ctx.cwd);
  target(loaded, of, "escalation", "acknowledge");
  refuseIfAnswered(loaded, of, "acknowledge", ["acknowledgement"]);
  const record: Acknowledgement = { ...head("acknowledgement", who, ctx, `${of}\n${because}`), of, because, ...humanWords(parsed) };
  return write(ctx, record);
}

/** The practice an id names: its full id, or its bare name when one practice alone carries it. */
export function findPractice(practices: readonly ModelPractice[], given: string): ModelPractice {
  const exact = practices.find((p) => p.id === given);
  if (exact !== undefined) return exact;
  const named = practices.filter((p) => p.name === given);
  if (named.length === 1) return named[0]!;
  const known = practices.length === 0 ? "this project declares no practice (a practice file beside a spec)" : `known: ${practices.map((p) => p.id).join("; ")}`;
  if (named.length > 1) throw new JournalError(`enact: "${given}" names ${named.length} practices; give the id: ${named.map((p) => p.id).join("; ")}`);
  throw new JournalError(`enact: no practice "${given}"; ${known}`);
}

/** The command that enacts a practice, one --step line per step, for a session to fill in. */
export function enactTemplate(practice: ModelPractice, cli: string, session: string, agent: string, trigger?: string): string {
  return [
    `${cli} enact "${practice.id}"${trigger === undefined ? "" : ` --trigger "${trigger}"`} --session ${session} --agent ${agent}`,
    ...practice.steps.map((step) => `  --step ${step.n}=done${step.leaves === undefined ? "" : `:"<the evidence: ${step.leaves}>"`}`),
  ].join(" \\\n") + "\n  (a step not done as written: --step <n>=deviated:<why> or --step <n>=skipped:<why>)";
}

/** One --step value: <n>=done[:<evidence>], <n>=deviated:<because>, or <n>=skipped:<because>. */
function stepOutcome(pair: string): { n: string; outcome: StepOutcome } {
  const match = /^(\d+)=(done|deviated|skipped)(?::([\s\S]*))?$/.exec(pair);
  if (match === null) throw new JournalError(`--step "${pair}" reads <n>=done[:<evidence>], <n>=deviated:<why>, or <n>=skipped:<why>`);
  const [, n, result, text] = match as unknown as [string, string, StepOutcome["result"], string | undefined];
  const said = text?.trim() ?? "";
  if (result === "done") return { n, outcome: said === "" ? { result } : { result, evidence: said } };
  if (said === "") throw new JournalError(`--step ${n}=${result} needs a because: a ${result} step says why, so the practice can learn from it`);
  return { n, outcome: { result, because: said } };
}

/**
 * Record a practice carried out. Every step needs an outcome: done, with its
 * evidence where the step names what it leaves, or deviated or skipped with
 * a because. The record keeps the text of the steps and pitfalls enacted, so
 * a later change to the practice is read against what was carried out. A
 * practice that has lost a step or pitfall an enactment taught, with no
 * decision amending it, is refused until that decision is recorded: enacting
 * the edited practice must not stand in for the reason.
 */
export function enact(argv: string[], ctx: Context): Written {
  const parsed = parseFlags(argv, withCommon({ step: "many", trigger: "one", ...CITE }));
  const who = attribution(parsed);
  const given = onePositional(parsed, "the practice (its id, or its name when only one practice carries it)");
  const practice = findPractice(projectPractices(ctx.cwd), given);
  const gaps = floorGaps(practice, loadJournal(ctx.cwd).records);
  if (gaps.length > 0) {
    throw new JournalError(
      `enact: ${practice.id} has lost what an enactment taught, with no decision saying why:\n` +
        gaps.map((g) => `  ${g.what}, enacted in ${g.taughtIn.id}`).join("\n") +
        `\nRecord the amendment first: ${amendCommand(practice.id, gaps[gaps.length - 1]!.taughtIn.id)}`,
    );
  }
  const results: Record<string, StepOutcome> = {};
  for (const pair of parsed.many.get("step") ?? []) {
    const { n, outcome } = stepOutcome(pair);
    if (Object.hasOwn(results, n)) throw new JournalError(`--step ${n} given twice`);
    if (!practice.steps.some((s) => String(s.n) === n)) throw new JournalError(`enact: ${practice.id} has steps 1 to ${practice.steps.length}; there is no step ${n}`);
    results[n] = outcome;
  }
  const missing = practice.steps.filter((s) => !Object.hasOwn(results, String(s.n)));
  if (missing.length > 0) {
    throw new JournalError(
      `enact: every step needs an outcome; missing ${missing.map((s) => s.n).join(", ")}. The practice, version ${practice.version}:\n` +
        practice.steps.map((s) => `  ${s.n}. ${s.text}${s.leaves === undefined ? "" : `\n     leaves: ${s.leaves}`}`).join("\n"),
    );
  }
  const trigger = parsed.one.get("trigger") ?? "explicit";
  const record: Enactment = {
    ...head("enactment", who, ctx, `${practice.id}\n${practice.version}\n${JSON.stringify(results)}`),
    practice: practice.id,
    version: practice.version,
    trigger,
    steps: practice.steps.map((s) => (s.leaves === undefined ? { text: s.text } : { text: s.text, leaves: s.leaves })),
    pitfalls: practice.pitfalls.map((p) => p.text),
    results,
    ...citations(parsed, ctx.cwd),
  };
  // A step that names its evidence and was marked done without it is claimed, not shown: said now, and again at the stop.
  const unshown = practice.steps.filter((s) => s.leaves !== undefined && results[String(s.n)]?.result === "done" && (results[String(s.n)] as { evidence?: string }).evidence === undefined);
  return write(ctx, record, [
    `  version ${practice.version}, ${enactmentTally(record)}`,
    ...unshown.map((s) => `  step ${s.n} names its evidence (${s.leaves}) and none was given: claimed, not shown`),
  ]);
}
