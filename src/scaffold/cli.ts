/**
 * The scaffold commands:
 *
 *   node src/cli.ts scaffold component <folder> "<intent>"
 *   node src/cli.ts scaffold invariant <componentFolder> "<sentence>" [--name "<name>"] --kinds a,b [--chokepoint|--totality-oracle] [--crossing "a -> b"] [--preview] [--write]
 *   node src/cli.ts scaffold control "<entrance>" | --all [--component <folder>] [--whole] [--as name|guard|invariant|none] [--guard <symbol>] [--reason "<why>"] [--write]
 *   node src/cli.ts scaffold control --baseline --session <id> --agent <name>
 *   node src/cli.ts scaffold entrances [<folder or file>]
 *   node src/cli.ts scaffold import tach [<module>...] | --all [--write]
 *
 * The control verb proposes the closure for an entrance with no traced
 * control (control.ts) from the recorded Structure reading when it still
 * describes the tree. Else, when the request names entrances (one by name,
 * or every one --all --component declares), from a reading scoped to their
 * routes: only the components those routes enter are asked about, the
 * output says which, and the reading is never recorded; it stands only when
 * every fact the route rule reads is settled (scopedUnsettled), and the
 * whole reading is taken otherwise. --all alone, --baseline and --whole read
 * every component interface now and record the reading. Every reading reuses
 * the language server's kept answers that no changed file could have changed
 * (kept-answers.ts), so one after a spec edit asks the server only what no
 * earlier reading asked, and says on stderr what it reused and asked.
 *
 * The invariant bullet prints on stdout with every absent slot as a
 * placeholder; the applicable checklist shapes print on stderr as guidance.
 * The entrances verb prints the ## entrances bullets for the detected
 * entrances no declared entrance covers (entrances.ts), from a scan of the
 * tree that needs no reading; it never writes.
 *
 * --preview writes an ephemeral Scope page in the system temporary directory;
 * --write independently appends the bullet to the component's spec.
 */

import { DEFAULT_VENDOR_DIR, vendorClient } from "../conformance/vendor.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { JournalError, parseFlags } from "../journal/args.ts";
import type { Io } from "../journal/cli.ts";
import { writeStructurePreview } from "../readings/scope/build.ts";
import type { StructurePreview } from "../readings/scope/derive.ts";
import { loadSeed } from "../spec/seed.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { allLanguagesRead, languagesReadLine } from "../readings/scope/languages-read.ts";
import { cliName } from "../lifecycle/hook.ts";
import { BUDGET_FLAG_NAMES, BUDGET_FLAGS, budgetFlags, readComponentInterfaces, readingAdapters } from "../readings/scope/component-interfaces.ts";
import type { ScopedReading } from "../readings/scope/model.ts";
import { scopedUnsettled } from "../readings/scope/scoped-route.ts";
import { freshReading, gapsOf, readAndRecord, recordGapBaseline, structureState } from "../readings/scope/gaps.ts";
import { keptLine } from "../readings/scope/kept-answers.ts";
import { flowOf, flowPartialText } from "../readings/scope/structure-flow.ts";
import { proposeClosures, renderAll, renderProposal, writeClosure, type Closure, type Proposal } from "./control.ts";
import { proposeEntrances, renderEntrances, under } from "./entrances.ts";
import { undeclaredOf } from "../readings/scope/undeclared.ts";
import { loadSpecModel } from "../spec/model.ts";
import { existsSync } from "node:fs";
import { IMPORT_USAGE, importVerb } from "./import.ts";
import { appendInvariant, appendPractice, componentDir, parseCrossing, practiceFileFor, renderGuidance, renderInvariant, renderPractice, scaffoldComponent, ScaffoldError, specsIn, type Form } from "./scaffold.ts";

export const SCAFFOLD_USAGE = [
  '  scaffold component <folder> "<intent>"',
  '  scaffold invariant <componentFolder> "<sentence>" [--name "<name>"] --kinds <a,b|none> [--chokepoint|--totality-oracle] [--crossing "<level> -> <level>"] [--preview] [--write]',
  `  scaffold control "<entrance>" | --all [--component <folder>] [--whole] [--as name|guard|invariant|none] [--guard <symbol>] [--reason "<why>"] [--write] ${BUDGET_FLAGS}   the closure for an entrance with no traced control: an entrances: line naming it on an invariant, a guard: line, an invariant, or control: none; with no recorded reading of the tree, an entrance or a component reads only the components its routes enter, unrecorded (--whole reads and records every one)`,
  "  scaffold control --baseline --session <id> --agent <name>   record the entrances with no traced control at adoption, so orient names only new ones",
  '  scaffold practice <componentFolder> "<name>" "<sentence>" [--when "<trigger>"] [--write]   a practice bullet with every slot to fill; --write appends it to the practice file beside the spec',
  "  scaffold entrances [<folder or file>]   the ## entrances bullets for the detected entrances no spec declares, by the component that owns each; printed, never written",
  `  scaffold client [--dir <folder>] [--write | --check]   the conformance trace client and its node:test hooks, vendored byte for byte (default folder ${DEFAULT_VENDOR_DIR}); --write never overwrites, --check exits 1 on drift`,
  IMPORT_USAGE,
].join("\n");

function usage(message: string): never {
  throw new ScaffoldError(`${message}\n${SCAFFOLD_USAGE}`);
}

function componentVerb(argv: string[], io: Io): void {
  const parsed = parseFlags(argv, {});
  const [folder, intent, ...rest] = parsed.positionals;
  if (folder === undefined || intent === undefined) usage("scaffold component takes a folder and an intent");
  if (rest.length > 0) usage(`unexpected argument "${rest[0]}"; quote the intent`);
  const result = scaffoldComponent(io.cwd, folder, intent);
  io.out(`wrote ${result.path}`);
  if (resolve(io.cwd, folder) === resolve(io.cwd)) {
    io.err("this is the entry spec: add ## trust levels (one bullet per level, name: meaning) before the invariants so crossings can name them");
  }
}

function previewPath(): string {
  return join(mkdtempSync(join(tmpdir(), "coherence-scaffold-preview-")), "scope.html");
}

function invariantVerb(argv: string[], io: Io): void | Promise<void> {
  const parsed = parseFlags(argv, {
    name: "one",
    kinds: "one",
    crossing: "one",
    chokepoint: "switch",
    "totality-oracle": "switch",
    preview: "switch",
    write: "switch",
  });
  const [folder, sentence, ...rest] = parsed.positionals;
  if (folder === undefined || sentence === undefined) usage("scaffold invariant takes a component folder and a sentence");
  if (rest.length > 0) usage(`unexpected argument "${rest[0]}"; quote the sentence`);
  if (parsed.switches.has("chokepoint") && parsed.switches.has("totality-oracle")) usage("--chokepoint or --totality-oracle, not both");
  const form: Form = parsed.switches.has("totality-oracle") ? "totality oracle" : "chokepoint";
  const dir = componentDir(io.cwd, folder);
  const component = relative(resolve(io.cwd), dir).split(sep).join("/") || ".";
  const specs = specsIn(dir);
  if (specs.length === 0) throw new ScaffoldError(`${folder} holds no spec; scaffold component ${folder} "<intent>" first`);
  const crossingText = parsed.one.get("crossing");
  if (parsed.switches.has("preview") && crossingText === undefined) usage('--preview requires --crossing "<trust level> -> <trust level>"');
  const crossing = crossingText === undefined ? undefined : parseCrossing(crossingText);
  const kindsText = parsed.one.get("kinds");
  const kinds =
    kindsText === undefined
      ? undefined
      : kindsText.trim() === "none"
        ? "none"
        : kindsText.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "");
  const seed = loadSeed();
  const name = parsed.one.get("name") ?? "<name>";
  const { bullet, shapes } = renderInvariant(seed, { sentence, name: parsed.one.get("name"), kinds, form, crossing });

  const finish = (outPath?: string): void => {
    if (parsed.switches.has("write")) {
      const specPath = join(dir, specs[0]!);
      appendInvariant(specPath, bullet);
      io.out(bullet.trimEnd());
      io.out(`appended to ${specPath}`);
    } else {
      io.out(bullet.trimEnd());
    }
    if (outPath !== undefined) io.out(`preview wrote ${outPath}`);
    if (kinds === undefined) io.err(`no --kinds given: name the kinds of thing protected (${Object.keys(seed.kinds).join(", ")}) or none, and the checklist follows`);
    const guidance = renderGuidance(shapes);
    if (guidance !== "") io.err(guidance.trimEnd());
  };

  if (!parsed.switches.has("preview")) {
    finish();
    return;
  }

  // Preview validation and rendering happen before the optional spec write, so
  // an invalid component or trust-level endpoint cannot leave a partial edit.
  const proposal: StructurePreview = { component, name, crossing: crossing! };
  const outPath = previewPath();
  return writeStructurePreview(io.cwd, proposal, outPath).then(
    () => finish(outPath),
    (error: unknown) => {
      throw new ScaffoldError(error instanceof Error ? error.message : String(error));
    },
  );
}

/** The entrances a request names, when it names some: one by name (in one component), or every one a component declares. */
type Asked = readonly { component: string; name: string }[] | undefined;

/**
 * The Structure model the control verb proposes from: the recorded reading
 * while it describes the tree; else, when the request names entrances, a
 * reading scoped to their routes, never recorded, standing only when
 * scopedUnsettled finds nothing it could not settle; else one read whole now
 * (and recorded). `scope` says what the scoped reading read, when it stood.
 */
async function controlModel(root: string, io: Io, values: ReadonlyMap<string, string>, asked: Asked) {
  const fresh = freshReading(root);
  let reading = fresh?.reading;
  let scope: ScopedReading | undefined;
  if (reading === undefined) {
    const budget = budgetFlags(values);
    if (typeof budget === "string") usage(budget);
    const adapters = readingAdapters(root, budget);
    const adapter = adapters.of;
    try {
      if (asked !== undefined) {
        io.err(`reading only the component interfaces the routes of ${asked.map((e) => e.name).join(", ")} need (no recorded reading describes this tree; --whole reads and records every one)`);
        const scoped = await readComponentInterfaces(root, adapter, { budget, scope: { entrances: asked } });
        const kept = scoped.kind === "read" ? keptLine(scoped.kept) : undefined;
        if (kept !== undefined) io.err(kept);
        // A budget the scoped reading spent, the whole one would spend sooner: the partial reading is shown as partial.
        const state = structureState(root, scoped);
        const unsettled = scoped.kind === "read" && scoped.partial === undefined ? scopedUnsettled(state, flowOf(state)) : undefined;
        if (unsettled === undefined) {
          reading = scoped;
          scope = scoped.kind === "read" ? scoped.scoped : undefined;
        } else io.err(`the scoped reading cannot settle ${unsettled} without the interfaces it did not read; reading them all`);
      }
      if (reading === undefined) {
        io.err("reading the component interfaces through the language adapter (no recorded reading describes this tree); a question no kept answer settles is asked of the language server, which can take minutes");
        reading = await readAndRecord(root, () => readComponentInterfaces(root, adapter, { budget }));
        const kept = reading.kind === "read" ? keptLine(reading.kept) : undefined;
        if (kept !== undefined) io.err(kept);
      }
    } finally {
      await adapters.close();
    }
  }
  if (reading.kind !== "read") throw new ScaffoldError(`the component interfaces could not be read (${reading.because}), so no route's controls are known`);
  const state = structureState(root, reading);
  const model = flowOf(state);
  const partial = flowPartialText(model);
  if (partial !== undefined) io.err(`${partial}; a gap below may only be a route the reading did not finish`);
  // A multi-language project: which languages the reading the proposals rest on read, and each one it did not, with why.
  const languages = languagesReadLine(model.languages);
  if (languages !== undefined) io.out(languages);
  return { state, model, scope };
}

/**
 * The entrances a control request names, read from the specs before any
 * reading: every entrance called `name` (in `component`, when given), or,
 * with no name, every entrance `component` declares; undefined for every
 * entrance (--all alone). A name or a component no spec declares is refused
 * here, so no reading is spent on it.
 */
function askedOf(root: string, name: string | undefined, component: string | undefined): Asked {
  if (name === undefined && component === undefined) return undefined;
  const components = loadSpecModel(root, { runs: false }).components;
  if (component !== undefined && !components.some((c) => c.folder === component)) throw new ScaffoldError(`no component's spec is at ${component}; --component takes a component's folder, as query structure lists them`);
  const asked = components.flatMap((c) => (component === undefined || c.folder === component ? c.entrances.filter((e) => name === undefined || e.name === name).map((e) => ({ component: c.folder, name: e.name })) : []));
  if (name !== undefined && asked.length === 0) throw new ScaffoldError(`no entrance is named ${JSON.stringify(name)}; query structure lists them`);
  return asked;
}

/** The line that says a proposal came from a scoped reading, and what it read. */
function scopedLine(scope: ScopedReading | undefined): string | undefined {
  if (scope === undefined) return undefined;
  return `scoped reading, not recorded: only the interfaces of ${scope.components.join(", ")}, which the routes of ${scope.entrances.map((e) => e.name).join(", ")} enter, were read; every other component was never asked (--whole reads and records every one)`;
}

const CLOSURE_KINDS = ["name", "guard", "invariant", "none"] as const;

/** The closure --as names, or the proposed one; a guard with rivals needs --guard to choose. */
function chosen(p: Proposal, as: string | undefined, guard: string | undefined): Closure {
  const kind = as ?? p.closures[0]!.kind;
  if (!(CLOSURE_KINDS as readonly string[]).includes(kind)) usage(`--as takes ${CLOSURE_KINDS.join(", ")}`);
  const candidates = p.closures.filter((c) => c.kind === kind);
  if (kind === "name" && candidates.length === 0) throw new ScaffoldError(`no verified invariant covered ${p.entrance.name} by its crossing alone, so there is no entrances: line to write; close it with --as guard, --as invariant or --as none`);
  if (kind === "guard") {
    if (candidates.length === 0) throw new ScaffoldError(`no verified chokepoint is traced on ${p.entrance.name}'s handler or called by it, so there is no guard: line to write; close it with --as invariant or --as none`);
    const pick = guard === undefined ? candidates[0]! : candidates.find((c) => c.kind === "guard" && c.symbol === guard);
    if (pick === undefined) throw new ScaffoldError(`${p.entrance.name}'s handler does not call ${guard}; it calls ${candidates.map((c) => (c.kind === "guard" ? c.symbol : "")).join(", ")}`);
    if (pick.kind === "guard" && pick.rivals.length > 0 && guard === undefined) throw new ScaffoldError(`${pick.invariant}'s module has several symbols the route's handlers call (${pick.rivals.join(", ")}); choose the one that applies its check with --guard <symbol>`);
    return pick;
  }
  return candidates[0]!;
}

async function controlVerb(argv: string[], io: Io): Promise<void> {
  const parsed = parseFlags(argv, {
    all: "switch",
    whole: "switch",
    write: "switch",
    baseline: "switch",
    as: "one",
    guard: "one",
    reason: "one",
    component: "one",
    session: "one",
    agent: "one",
    work: "one",
    because: "one",
    cite: "many",
    ...Object.fromEntries(BUDGET_FLAG_NAMES.map((flag) => [flag, "one" as const])),
  });
  const root = io.cwd;
  const [name, ...rest] = parsed.positionals;
  if (rest.length > 0) usage(`unexpected argument "${rest[0]}"; quote the entrance's name`);
  const all = parsed.switches.has("all");
  const baseline = parsed.switches.has("baseline");
  if (baseline && (all || name !== undefined || parsed.switches.has("write"))) usage("--baseline takes no entrance, --all or --write");
  if (!baseline && (name === undefined) === !all) usage("scaffold control takes an entrance's name, or --all");
  const component = parsed.one.get("component");
  const { state, model, scope } = await controlModel(root, io, parsed.one, baseline || parsed.switches.has("whole") ? undefined : askedOf(root, all ? undefined : name, component));
  if (baseline) {
    const session = parsed.one.get("session");
    const agent = parsed.one.get("agent");
    if (session === undefined || agent === undefined) usage("--baseline records a journal decision: pass --session <id> --agent <name>");
    const work = parsed.one.get("work");
    const cite = parsed.many.get("cite");
    io.out(recordGapBaseline(root, gapsOf(state, model), { session, agent, ...(work === undefined ? {} : { work }), ...(cite === undefined ? {} : { cite }) }, parsed.one.get("because")));
    return;
  }
  const proposals = proposeClosures(root, state, model, readEnforcementConfig(root).languages);
  const cli = await cliName(root);
  const as = parsed.one.get("as");
  const guard = parsed.one.get("guard");
  const scoped = scopedLine(scope);
  if (all) {
    // --component names whose gaps: the entrances that component declares.
    const theirs = component === undefined ? proposals : proposals.filter((p) => p.entrance.owners[0] === component);
    io.out(renderAll(theirs, cli));
    if (scoped !== undefined) io.out(scoped);
    if (!parsed.switches.has("write")) return;
    if (as !== undefined && as !== "guard") usage("--all --write writes only guard: lines; write an invariant or control: none one entrance at a time");
    // Bottom-up within each spec, so an inserted line never moves a bullet still to be written.
    const writable = theirs
      .filter((p) => p.closures[0]!.kind === "guard")
      .filter((p) => { const c = p.closures[0]!; return c.kind === "guard" && (guard === undefined ? c.rivals.length === 0 : c.symbol === guard); })
      .sort((a, b) => a.specPath.localeCompare(b.specPath) || b.declared.line - a.declared.line);
    for (const p of writable) io.out(`wrote ${writeClosure(root, p, p.closures[0]!)}`);
    if (writable.length === 0) io.err("no guard: line was written: none is proposed, or each is a choice between symbols (--guard <symbol> makes it)");
    return;
  }
  const matches = proposals.filter((p) => p.entrance.name === name && (component === undefined || p.entrance.owners[0] === component));
  if (matches.length === 0) {
    const declared = model.entrances.filter((e) => e.name === name && (component === undefined || e.owners[0] === component));
    if (declared.length === 0) throw new ScaffoldError(`no entrance is named ${JSON.stringify(name)}; query structure lists them`);
    const e = declared[0]!;
    const route = model.routes.find((r) => r.entrances.includes(e.id));
    io.out(`${e.name} needs no closure: ${e.noControl !== undefined ? `it declares control: none — ${e.noControl}` : route === undefined ? `it has no route (${e.reason ?? "unresolved"})` : route.traced.length > 0 ? `its route is controlled (${route.traced.map((c) => c.name).join(", ")})` : "it carries trust inside the system's control in"}.`);
    if (scoped !== undefined) io.out(scoped);
    return;
  }
  if (matches.length > 1) usage(`${matches.length} components declare an entrance named ${JSON.stringify(name)} (${matches.map((p) => p.entrance.owners[0]).join(", ")}); choose with --component <folder>`);
  const p = matches[0]!;
  if (as !== undefined && !(CLOSURE_KINDS as readonly string[]).includes(as)) usage(`--as takes ${CLOSURE_KINDS.join(", ")}`);
  // --as puts the chosen closure first, so what is printed is what --write would write.
  const shown: Proposal = as === undefined ? p : { ...p, closures: [...p.closures.filter((c) => c.kind === as), ...p.closures.filter((c) => c.kind !== as)] };
  io.out(renderProposal(shown, cli));
  if (scoped !== undefined) io.out(scoped);
  if (!parsed.switches.has("write")) return;
  io.out(`wrote ${writeClosure(root, p, chosen(p, as, guard), parsed.one.get("reason"))}`);
}

async function entrancesVerb(argv: string[], io: Io): Promise<void> {
  const parsed = parseFlags(argv, {});
  const [target, ...rest] = parsed.positionals;
  if (rest.length > 0) usage(`unexpected argument "${rest[0]}"; scaffold entrances takes one folder or file`);
  const root = io.cwd;
  let within: string | undefined;
  if (target !== undefined) {
    const path = resolve(root, target);
    within = relative(resolve(root), path).split(sep).join("/") || ".";
    if (within === ".." || within.startsWith("../") || !existsSync(path)) throw new ScaffoldError(`${target} is no folder or file inside the project`);
  }
  const model = loadSpecModel(root, { runs: false });
  if (model.components.length === 0) throw new ScaffoldError(`no component has a spec yet; scaffold component . "<intent>" first`);
  const measured = undeclaredOf(root, model);
  const undeclared = (measured?.undeclared ?? []).filter((c) => under(c.file, within));
  const groups = proposeEntrances(undeclared, model.components);
  const languages = measured?.languages ?? allLanguagesRead(readEnforcementConfig(root));
  io.out(renderEntrances({ groups, detected: measured?.detected ?? 0, declared: measured?.declared ?? 0, target: within, levels: model.trustLevels, cli: await cliName(root), languages }));
}

function scaffoldFailure(error: unknown, io: Io): number {
  if (error instanceof ScaffoldError || error instanceof JournalError) {
    io.err(`scaffold: ${error.message}`);
    return 1;
  }
  throw error;
}

function practiceVerb(argv: string[], io: Io): void {
  const parsed = parseFlags(argv, { when: "one", write: "switch" });
  const [folder, name, sentence, ...rest] = parsed.positionals;
  if (folder === undefined || name === undefined || sentence === undefined) usage("scaffold practice takes a component folder, a name, and a sentence");
  if (rest.length > 0) usage(`unexpected argument "${rest[0]}"; quote the sentence`);
  const dir = componentDir(io.cwd, folder);
  const specs = specsIn(dir);
  // A spec and its practice file are always paired (d-861e8319): no spec, no practice file.
  if (specs.length === 0) throw new ScaffoldError(`${folder} holds no spec, and a practice file stands only beside one; scaffold component ${folder} "<intent>" first`);
  const bullet = renderPractice(name, sentence, parsed.one.get("when"));
  io.out(bullet.trimEnd());
  if (parsed.switches.has("write")) {
    const path = practiceFileFor(dir, specs[0]!);
    appendPractice(path, bullet);
    io.out(`appended to ${path}`);
  }
  io.err("fill every slot: a pitfall cites the record or commit that witnessed it, learned: names what the practice rests on, and spec --check refuses a practice that cites nothing");
}

/** Synchronous shapes return a number; preview returns the rendering promise. */
/** scaffold client: the trace client vendored into the project, printed, written once, or checked for drift. */
function clientVerb(argv: string[], io: Io): number {
  const parsed = parseFlags(argv, { dir: "one", write: "switch", check: "switch" });
  if (parsed.positionals.length > 0) usage(`scaffold client: unexpected argument "${parsed.positionals[0]}"`);
  if (parsed.switches.has("write") && parsed.switches.has("check")) usage("scaffold client takes --write or --check, not both");
  const mode = parsed.switches.has("write") ? "write" : parsed.switches.has("check") ? "check" : "print";
  const { lines, exit } = vendorClient(io.cwd, parsed.one.get("dir") ?? DEFAULT_VENDOR_DIR, mode);
  for (const line of lines) io.out(line);
  return exit;
}

export function scaffoldCommand(argv: string[], io: Io): number | Promise<number> {
  const [shape, ...rest] = argv;
  try {
    if (shape === "component") {
      componentVerb(rest, io);
      return 0;
    }
    if (shape === "invariant") {
      const result = invariantVerb(rest, io);
      return result === undefined ? 0 : result.then(() => 0, (error: unknown) => scaffoldFailure(error, io));
    }
    if (shape === "practice") {
      practiceVerb(rest, io);
      return 0;
    }
    if (shape === "control") return controlVerb(rest, io).then(() => 0, (error: unknown) => scaffoldFailure(error, io));
    if (shape === "import") {
      importVerb(rest, io);
      return 0;
    }
    if (shape === "entrances") return entrancesVerb(rest, io).then(() => 0, (error: unknown) => scaffoldFailure(error, io));
    if (shape === "client") return clientVerb(rest, io);
    usage('scaffold takes "component", "invariant", "practice", "control", "entrances", "client" or "import"');
  } catch (error) {
    return scaffoldFailure(error, io);
  }
}
