/**
 * The chokepoint check: for one chokepoint-form enforcement, resolve the
 * protected thing and the chokepoint, collect every reference to the
 * protected thing and the chokepoint, and classify each site.
 *
 * Two sites carry a form the language gives them, and the form is read
 * before the range (ruling d-7abd1ba8):
 *
 *   inside   a plain import specifier sitting in the chokepoint's own module
 *            — the one location through which the chokepoint reaches the
 *            thing — or any site within the chokepoint symbol's range, or
 *            within its module when the chokepoint is a module; for a
 *            protected module, within the module itself
 *   reference an adapter-reported reference to the chokepoint outside its own
 *             definition; it may be an import, re-export, type use, or call,
 *             and makes no stronger semantic claim
 *   test      under a test folder or a test file by name; retained separately
 *             on every site and used as the protected-site class
 *   exempt    under the folder the bullet's from: line (or the config's
 *             chokepointFrom) says the chokepoint does not govern: the
 *             component's own code for `outside the component`, the named
 *             folder for `outside <folder>`; never under `anywhere`, the
 *             default. Read after the forms, the range and the test folders,
 *             so a re-export is still a bypass there
 *   bypass   an export-from specifier or a wildcard re-export of the protected thing, wherever it
 *            stands, because it widens the thing's reach with no call at
 *            all; an import of the protected thing in any other module; and
 *            every other site outside the chokepoint
 *
 * The grade follows: visibility-choked when the protected thing is not
 * visible outside its module and nothing bypasses (the adapter says whether
 * its language can reach this rung); reference-choked when visible and
 * nothing bypasses; broken when a bypass exists or the chokepoint cannot be
 * resolved; not chokeable when the protected thing cannot be resolved as a
 * symbol or a module.
 *
 * The refutation must prove that this check would fire, and who enforces the
 * graded rung decides how. Where Coherence's check is the enforcer, the
 * adapter stages the synthetic sites the form rule could otherwise swallow —
 * a use in the chokepoint's own module past its range, and a re-export — and
 * the check classifies each with the same function every other site goes
 * through; only when it calls every one `bypass` does the refutation fire.
 * Where the chokepoint governs only references from outside a folder, the
 * adapter stages a use from outside that folder in place of any site the
 * exemption covers, so the refutation still proves an outside use is caught. A
 * staged site the instrument could not see, or one the check would call
 * `inside` (the chokepoint covers everywhere the language lets the thing be
 * named) or `test` (the protected thing lives under a test folder, so nothing
 * can ever be a bypass), proves only that the instrument answers, and the
 * check says which and records not run. Where the language is the enforcer
 * (visibility-choked, closure-choked), Coherence's check can never be made to
 * fire, and the compiler's or interpreter's refusal of the synthetic outside
 * reference is the refutation instead (ruling rs-e93ecdd6).
 *
 * A checker that draws a module boundary (tach) changes two things where its
 * rung is earned: a site in the module's own code is inside, since the
 * checker lets a module use its internals (a re-export stays a bypass by its
 * form), and every import the checker refused that reaches the protected
 * thing is a bypass, merged with the site the instrument reported on its
 * line. Its refusal of a staged outside import is the refutation, recorded
 * as refused by the checker.
 */

import { isTestPath, rangeContains, withinFolder, type CheckerBoundary, type Definition, type LanguageAdapter, type ReferenceSite, type Rung, type Visibility } from "../adapters/adapter.ts";
import { horizonSites, projectSites, searchedHorizon } from "../adapters/project-files.ts";
import { fromText, type ChokepointFrom } from "../spec/grammar.ts";
import type { Bypass, Governed, Grade, ReferenceTarget, RefutationState, SiteClass, Verdict } from "./record.ts";

export interface ClassifiedSite extends Omit<ReferenceSite, "test"> {
  class: SiteClass;
  of: ReferenceTarget;
  /** Test location is an orthogonal fact, not a claim about how the chokepoint is used: a test path, or a site the adapter marks as test. */
  test: boolean;
  /** The checker that refuses this import, with its error, when one does. */
  checker?: string;
}

export interface ChokepointResult {
  /** The values as the spec wrote them. */
  input: ChokepointInput;
  verdict: Verdict;
  grade: Grade;
  /** Who refuses a bypass at the graded rung, for a choked grade. */
  enforcer?: string;
  refutation: RefutationState;
  /** What the refutation did and saw. */
  refutationAccount: string;
  protectedThing: Definition | undefined;
  chokepoint: Definition | undefined;
  sites: ClassifiedSite[];
  /** Whether `sites` is complete; unavailable results keep an empty transient array but are never persisted as evidence. */
  siteEvidence: "complete" | "unavailable";
  bypasses: Bypass[];
  /** Which references the check governed; absent where it never got as far as classifying. */
  governed?: Governed;
  /** Protected-reference counts retained for grading and compatibility; chokepoint callers live in `sites`. */
  counts: Record<Exclude<SiteClass, "chokepoint-reference">, number>;
  visibility: string | undefined;
  files: string[];
  reason: string;
  /** The project folder, relative to the repository top, when the reference search covered that folder alone. */
  horizon?: string;
}

export interface ChokepointInput {
  protects: string;
  chokepoint: string;
  component: string;
  testFolders: readonly string[];
  /** The project root: only its own files are evidence, so a site outside them is never classified. */
  root: string;
  /** Which references the chokepoint governs; absent is anywhere. */
  from?: ChokepointFrom | undefined;
  /** Who said it: the bullet's own from: line, or the config's chokepointFrom; absent is the default. */
  fromBy?: "bullet" | "config" | undefined;
}

/** Which references a check governs, and the folder it exempts: the component's for `outside the component`, the named one for `outside <folder>`. */
export function governedOf(input: Pick<ChokepointInput, "from" | "fromBy" | "component">): Governed {
  const from = input.from ?? "anywhere";
  const by = input.from === undefined ? "default" : (input.fromBy ?? "bullet");
  if (from === "anywhere") return { value: "anywhere", by };
  return { value: fromText(from), by, exempt: from === "outside the component" ? input.component : from.outside };
}

export function classifySite(site: ReferenceSite, protectedThing: Definition, chokepoint: Definition, testFolders: readonly string[], exempt?: string): Exclude<SiteClass, "chokepoint-reference"> {
  const position = { line: site.line - 1, character: site.character };
  // A re-export widens the thing's reach with no call at all, so it is a bypass wherever it stands.
  if (site.form === "re-export") return "bypass";
  // A site the adapter read as test code is a test before any range: a test module in the chokepoint's own file is not inside it.
  if (site.test === true) return "test";
  // A plain import specifier is how the chokepoint's own module reaches the thing, not a place the thing is used.
  const inChokepointModule = chokepoint.kind === "module" ? withinModule(site.file, chokepoint.file) : site.file === chokepoint.file;
  if (site.form === "import" && inChokepointModule) return "inside";
  if (chokepoint.kind === "module" ? inChokepointModule : site.file === chokepoint.file && rangeContains(chokepoint.range, position)) return "inside";
  if (protectedThing.kind === "module" && withinModule(site.file, protectedThing.file)) return "inside";
  if (isTestPath(site.file, testFolders)) return "test";
  // A use from where the chokepoint does not govern: reported as exempt, never a bypass and never dropped.
  if (exempt !== undefined && withinFolder(site.file, exempt)) return "exempt";
  return "bypass";
}


/**
 * A reference to the door itself is reliance, not a bypass. Recursion within
 * the door is inside; every outside site is only `chokepoint-reference`, because the
 * adapter may be reporting an import, re-export, type use, or runtime call.
 * Test location and syntactic form remain separate fields on the site.
 */
export function classifyChokepointSite(site: ReferenceSite, chokepoint: Definition): "inside" | "chokepoint-reference" {
  const position = { line: site.line - 1, character: site.character };
  const inChokepoint = chokepoint.kind === "module"
    ? withinModule(site.file, chokepoint.file)
    : site.file === chokepoint.file && rangeContains(chokepoint.range, position);
  return inChokepoint ? "inside" : "chokepoint-reference";
}

/** Whether a site lies in the code a checker's module boundary leaves free to use its internals. */
function ownedBy(boundary: CheckerBoundary, file: string): boolean {
  const under = (path: string): boolean => (path.endsWith("/") ? file.startsWith(path) : file === path);
  return boundary.owns.some(under) && !boundary.except.some(under);
}

/**
 * Whether a file is the module, or one of the files its module subtree owns:
 * a Python package's own files under its __init__; under a Rust `X/mod.rs`,
 * the files of `X/`; under a Rust `X.rs`, the files of its sibling `X/`; and
 * under a crate root `src/lib.rs` or `src/main.rs`, the files of `src/`.
 */
function withinModule(file: string, moduleFile: string): boolean {
  if (file === moduleFile) return true;
  const owned = /^(.*)\/(?:__init__\.py|mod\.rs)$/.exec(moduleFile)?.[1] ?? /^((?:.*\/)?src)\/(?:lib|main)\.rs$/.exec(moduleFile)?.[1] ?? /^(.*)\.rs$/.exec(moduleFile)?.[1];
  return owned !== undefined && file.startsWith(owned + "/");
}

const NOT_CHOKEABLE_NOTE = "the totality oracle form (over + via) is the compromise where structure is unavailable";

/** The rungs whose enforcer is the language itself, where a refusal is the refutation (ruling rs-e93ecdd6). */
const LANGUAGE_ENFORCED = new Set<Grade>(["visibility-choked", "closure-choked"]);

function nameOf(site: SiteClass | undefined): string {
  return site === undefined ? "as unreported" : site === "test" ? "a test reference" : site === "chokepoint-reference" ? "an outside chokepoint reference" : site === "exempt" ? "exempt, from where the chokepoint does not govern" : "a reference inside the chokepoint";
}

/** Who said which references a check governs, in words. */
export function governedBy(governed: Governed): string {
  return governed.by === "bullet" ? "its from: line" : governed.by === "config" ? "the config's chokepointFrom" : "the default";
}

/** The clause a reason carries when the check governed less than anywhere, so an exempt reference never reads as an absent one. */
function governedClause(governed: Governed, exempt: number): string {
  if (governed.exempt === undefined) return "";
  return `; governs only references from outside ${governed.exempt} (from: ${governed.value}, by ${governedBy(governed)}), so ${exempt} reference${exempt === 1 ? "" : "s"} from inside it ${exempt === 1 ? "is" : "are"} exempt`;
}

/**
 * What a verdict over a project nested below the repository top must say:
 * its reference search covered the project folder alone, so a caller
 * elsewhere in the repository was never read, and a clean grade claims no
 * more than that folder.
 */
export function horizonNote(horizon: string): string {
  return `; references searched inside ${horizon} only: callers elsewhere in the repository were not read`;
}

export async function checkChokepoint(adapter: LanguageAdapter, input: ChokepointInput): Promise<ChokepointResult> {
  const result = await checkWithinProject(adapter, input);
  // A graded verdict over a nested project says where its search reached; one never graded (nothing resolved) searched nothing.
  const horizon = result.siteEvidence === "complete" ? searchedHorizon(input.root) : undefined;
  return horizon === undefined ? result : { ...result, horizon, reason: result.reason + horizonNote(horizon) };
}

async function checkWithinProject(adapter: LanguageAdapter, input: ChokepointInput): Promise<ChokepointResult> {
  const hint = { component: input.component, testFolders: input.testFolders };
  const empty: Record<Exclude<SiteClass, "chokepoint-reference">, number> = { inside: 0, test: 0, exempt: 0, bypass: 0 };
  const governed = governedOf(input);
  const base = { input, sites: [] as ClassifiedSite[], siteEvidence: "unavailable" as const, bypasses: [], counts: empty, visibility: undefined, files: [] as string[], refutation: "missing" as RefutationState, refutationAccount: "not attempted" };

  const protectedResolved = await adapter.resolve(input.protects, hint);
  if (!protectedResolved.ok) {
    const where = protectedResolved.candidates === undefined ? "" : ` (${protectedResolved.candidates.join(", ")})`;
    return {
      ...base,
      verdict: "not run",
      grade: "not chokeable",
      protectedThing: undefined,
      chokepoint: undefined,
      reason: `protected thing ${protectedResolved.reason}${where}; ${NOT_CHOKEABLE_NOTE}`,
    };
  }
  const protectedThing = protectedResolved.definition;
  const chokepointResolved = await adapter.resolve(input.chokepoint, hint);
  if (!chokepointResolved.ok) {
    const where = chokepointResolved.candidates === undefined ? "" : ` (${chokepointResolved.candidates.join(", ")})`;
    return {
      ...base,
      verdict: "fail",
      grade: "broken",
      protectedThing,
      chokepoint: undefined,
      files: [protectedThing.file],
      reason: `chokepoint ${chokepointResolved.reason}${where}; the protected thing stands with no chokepoint`,
    };
  }
  const chokepoint = chokepointResolved.definition;
  // A definition outside the project's files is no answer about this project: an instrument that indexed a nested
  // checkout (a warm server started before the rule) resolved the name to that checkout's copy. Nothing is graded on it.
  const foreign = [protectedThing, chokepoint].filter((d) => projectSites(input.root, [d]).length === 0);
  if (foreign.length > 0) {
    return {
      ...base,
      verdict: "not run",
      // Not a structural defect and not a grade of this project's structure: the answer came from another tree.
      grade: "not chokeable",
      protectedThing,
      chokepoint,
      reason: `the instrument resolved ${foreign.map((d) => `${d.name} to ${d.file}`).join(" and ")}, which is not one of the project's files (ignored, or inside a nested checkout); nothing was graded. A warm server that indexed a nested checkout answers this way: stop it (coherence serve restarts it) and run again`,
    };
  }

  // These are two distinct questions. Protected references decide the grade;
  // chokepoint references describe legal reliance on the door. A run records
  // sites only after both queries complete, so a failed second query cannot
  // turn partial evidence into a confirmed empty set.
  // Only the project's own files and its reference horizon's are evidence (horizonSites): a site in a nested checkout or an ignored file
  // is someone else's working text, never a bypass, even from an instrument that still reports one.
  const protectedReferences = horizonSites(input.root, await adapter.references(protectedThing));
  const chokepointReferences = horizonSites(input.root, await adapter.references(chokepoint));
  const visibility = await adapter.visibility(protectedThing, chokepoint);
  const boundary = visibility.boundary;
  // Where a checker draws the module boundary, the module's own code is free to use its internals; a re-export still widens the thing's reach.
  const protectedClass = (site: ReferenceSite): Exclude<SiteClass, "chokepoint-reference"> => {
    const found = classifySite(site, protectedThing, chokepoint, input.testFolders, governed.exempt);
    return found === "bypass" && boundary !== undefined && site.form !== "re-export" && ownedBy(boundary, site.file) ? "inside" : found;
  };
  const sites: ClassifiedSite[] = [
    ...protectedReferences.map((site) => ({ ...site, of: "protected" as const, test: site.test === true || isTestPath(site.file, input.testFolders), class: protectedClass(site) })),
    ...chokepointReferences.map((site) => ({ ...site, of: "chokepoint" as const, test: site.test === true || isTestPath(site.file, input.testFolders), class: classifyChokepointSite(site, chokepoint) })),
  ];
  // Every import the checker refused is a bypass, on the site the instrument reported on its line or as a site of its own.
  for (const refused of boundary?.violations ?? []) {
    const checker = `${boundary!.checker}: ${refused.message}`;
    const same = sites.find((s) => s.of === "protected" && s.file === refused.file && s.line === refused.line);
    if (same !== undefined) Object.assign(same, { class: "bypass", checker });
    else sites.push({ file: refused.file, line: refused.line, character: 0, symbol: refused.symbol, form: "import", of: "protected", test: isTestPath(refused.file, input.testFolders), class: "bypass", checker });
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character || a.of.localeCompare(b.of));
  const counts: Record<Exclude<SiteClass, "chokepoint-reference">, number> = { inside: 0, test: 0, exempt: 0, bypass: 0 };
  for (const site of sites) if (site.of === "protected" && site.class !== "chokepoint-reference") counts[site.class] += 1;
  const bypasses: Bypass[] = sites.filter((s) => s.of === "protected" && s.class === "bypass").map((s) => ({ file: s.file, line: s.line, symbol: s.symbol ?? "module top level", ...(s.checker === undefined ? {} : { checker: s.checker }) }));
  const files = [...new Set([protectedThing.file, chokepoint.file, ...sites.map((s) => s.file)])].sort();

  const earned = rungFor(adapter, visibility);
  const refutation = await adapter.refute(protectedThing, chokepoint, governed.exempt);
  const classified = refutation.staged.map((staged) => ({
    what: staged.what,
    class: staged.site === undefined ? undefined : classifySite(staged.site, protectedThing, chokepoint, input.testFolders, governed.exempt),
  }));
  // The rung whose enforcer is the language refutes itself: a synthetic reference the compiler or the interpreter
  // refuses is the proof, and Coherence's own check never has to be made to fire (ruling rs-e93ecdd6).
  const languageRefused = refutation.refused !== undefined && LANGUAGE_ENFORCED.has(earned.grade);
  // A checker that draws a module boundary refutes its own rung the same way: its refusal of a staged outside import is the proof.
  const checkerRefused = refutation.refused !== undefined && boundary !== undefined && earned.grade === "checker-choked";
  // Otherwise every staged site must be one this check's own classification calls a bypass (ruling d-7abd1ba8).
  const short = classified.filter((site) => site.class !== "bypass");
  const fired = classified.length > 0 && refutation.seen && short.length === 0;
  const refutationState: RefutationState = languageRefused ? "refused by the language" : checkerRefused ? "refused by the checker" : fired ? "automatic" : "missing";
  const refutationAccount = languageRefused || checkerRefused
    ? `${refutation.account}; the ${earned.grade} rung is enforced by ${earned.enforcer}, and its refusal is the refutation`
    : !refutation.seen || classified.length === 0
      ? refutation.account
      : fired
        ? `${refutation.account}, and the check classified each one a bypass`
        : `${refutation.account}, but the check classified ${short.map((s) => `${s.what} ${nameOf(s.class)}`).join(" and ")}, not a bypass; the refutation is vacuous`;

  if (bypasses.length > 0) {
    return {
      input,
      verdict: "fail",
      grade: "broken",
      refutation: refutationState,
      refutationAccount,
      protectedThing,
      chokepoint,
      sites,
      siteEvidence: "complete",
      bypasses,
      counts,
      visibility: visibility.evidence,
      files,
      governed,
      reason: `${bypasses.length} reference${bypasses.length === 1 ? "" : "s"} to ${protectedThing.name} outside ${chokepoint.name}: ${bypasses.map((b) => `${b.file}:${b.line} in ${b.symbol}${b.checker === undefined ? "" : ` (${b.checker})`}`).join(", ")}${governedClause(governed, counts.exempt)}`,
    };
  }
  // When the instrument could not see the synthetic site, Coherence's own check enforces nothing: a ladder may name the rung that is left.
  // A site the instrument saw but the check would not call a bypass leaves the earned rung's fact standing; only the verdict drops.
  const vacuousRung = !languageRefused && !checkerRefused && !refutation.seen && adapter.ladder.whenVacuous !== undefined ? rungsOf(adapter).find((r) => r.grade === adapter.ladder.whenVacuous) : undefined;
  const graded: Rung = vacuousRung === undefined ? earned : { ...vacuousRung, fact: `the instrument could not see the synthetic reference, so Coherence's check enforces nothing here and only the convention stands (${visibility.evidence})` };
  const tests = counts.test > 0 ? `; ${counts.test} test reference${counts.test === 1 ? "" : "s"}` : "";
  const proved = languageRefused || checkerRefused || fired;
  const vacuous = proved ? "" : `; refutation missing: ${refutationAccount}`;
  return {
    input,
    verdict: proved ? "pass" : "not run",
    grade: graded.grade,
    enforcer: graded.enforcer,
    refutation: refutationState,
    refutationAccount,
    protectedThing,
    chokepoint,
    sites,
    siteEvidence: "complete",
    bypasses,
    counts,
    visibility: visibility.evidence,
    files,
    governed,
    reason: `${protectedThing.name} is ${graded.grade}, enforced by ${graded.enforcer}: ${graded.fact}${tests}${governedClause(governed, counts.exempt)}${vacuous}`,
  };
}

/** The ladder's rungs; a warm server started before ladders carried rungs answers with none, and the check must not crash on it. */
function rungsOf(adapter: LanguageAdapter): readonly Rung[] {
  return adapter.ladder.rungs ?? [];
}

/** The rung a clean chokepoint earns: the adapter's own verdict when its visibility carries one, else the two-rung rule over exportedness. */
function rungFor(adapter: LanguageAdapter, visibility: Visibility): Rung {
  if (visibility.rung !== undefined) return visibility.rung;
  const listed = (grade: Grade): Rung | undefined => rungsOf(adapter).find((r) => r.grade === grade);
  if (visibility.enforced && !visibility.visible && adapter.ladder.top === "visibility-choked") {
    return { grade: "visibility-choked", enforcer: listed("visibility-choked")?.enforcer ?? "the compiler", fact: `not visible outside its module (${visibility.evidence}) and every reference inside the chokepoint` };
  }
  return { grade: "reference-choked", enforcer: listed("reference-choked")?.enforcer ?? "Coherence's check at the edit and in CI", fact: `visible outside its module (${visibility.evidence}); every reference in the project is inside the chokepoint` };
}
