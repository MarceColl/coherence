/**
 * The spec grammar: one file, parsed into an intent, trust levels, and
 * invariant bullets.
 *
 *   # Name
 *
 *   One-line intent.
 *   owners: <who owns it, comma separated>       optional; declared, never routed on
 *   model: <file>.qnt | none — <why> | planned — <what>   the quint model beside the spec, or why there is none
 *
 *   ## trust levels            (entry spec only)
 *   - owner-trusted: full kernel access
 *   - public (outside): what anyone on the network sends   outside the system's control
 *
 *   ## entrances               (any spec)
 *   - <name>: <one-line meaning: what work enters here from outside>
 *     handler: <symbol, symbol in file, or a module file>   a module file: its top-level script is the handler
 *     trust: <the trust level it carries in>              optional; else derived from crossings
 *     guard: <a chokepoint's symbol>                     optional; the chokepoint its handler is registered through
 *     control: none — <reason>                           optional; it needs no control, and why (never beside guard:)
 *
 *   ## invariants
 *   - <name>: <sentence>
 *     protects: <symbol or module>            chokepoint form, with
 *     chokepoint: <symbol>
 *     from: anywhere | outside the component | outside <folder>   optional; which references the chokepoint governs
 *     over: <the set the detector is total over>   totality oracle form, with
 *     via: <the test>
 *     because: <why it exists, what it protects against>
 *     crossing: <trust level> -> <trust level>
 *     entrances: <entrance, entrance> | none   optional; the entrances whose work it checks, by name, never by crossing alone
 *     refuted: <what was broken> -> <what was seen> (YYYY-MM-DD)   the human account of a refutation record
 *     kinds: <a, b> | none
 *     checklist: <shape> declared as <invariant> | <shape> dismissed: <reason>
 *
 * Every bullet is an invariant; there is no other kind of claim. A value
 * still written as <a placeholder> parses but counts as absent, so a
 * scaffolded bullet can be written first and filled second. The sections the
 * reference used are refused by name with their replacement; any other
 * section is refused as unknown. The parser reports problems and never
 * throws on content; cross-spec facts (trust levels, declared-as names,
 * duplicate names, an entrance's trust against the crossings on its
 * handler) are checked by the model.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Seed } from "./seed.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface RetiredSection {
  section: string;
  replacement: string;
}

/** The sections the reference used, each with what replaced it. Data, so the names appear nowhere in code. */
export const RETIRED_SECTIONS: readonly RetiredSection[] = (
  JSON.parse(readFileSync(resolve(here, "retired-sections.json"), "utf8")) as { sections: RetiredSection[] }
).sections;

export const TRUST_LEVELS_SECTION = "trust levels";
export const ENTRANCES_SECTION = "entrances";
export const INVARIANTS_SECTION = "invariants";

/** What a spec may hold, for the problems that name it. */
const SECTIONS_SENTENCE = "a spec holds ## trust levels (entry spec only), ## entrances and ## invariants";

/** The keys an invariant bullet may carry, in the order the scaffold prints them. */
export const KEYS = ["protects", "chokepoint", "from", "over", "via", "because", "crossing", "entrances", "refuted", "kinds", "checklist"] as const;
export type Key = (typeof KEYS)[number];
const MANY: ReadonlySet<Key> = new Set<Key>(["refuted", "checklist"]);

export interface Problem {
  file: string;
  line: number;
  message: string;
}

export interface TrustLevel {
  name: string;
  meaning: string;
  /** Whether it comes from outside the system's control: the level is written `- <name> (outside): <meaning>`. */
  outside: boolean;
  line: number;
}

/** The marker a trust level wears when it comes from outside the system's control. */
export const OUTSIDE_MARKER = "(outside)";

/**
 * Where work enters the system from outside: a command, a host event, a
 * route, a tool. The handler is the code that receives it, named as a symbol,
 * a symbol in a file, or a module file whose top-level script receives it;
 * the model checks that it resolves. A guard names the chokepoint the handler
 * is registered through, where the reading cannot see the registration.
 */
export interface Entrance {
  name: string;
  meaning: string;
  /** Undefined when the bullet names no handler, which is a problem. */
  handler: string | undefined;
  line: number;
  /** The handler line, or the bullet's own line when there is none. */
  handlerLine: number;
  /** The trust level it declares it carries in; undefined when it declares none, and its trust is derived. */
  trust: string | undefined;
  /** The trust line, when there is one. */
  trustLine: number | undefined;
  /** The chokepoint it declares its handler is registered through (a guard: line); undefined when it declares none. */
  guard?: string | undefined;
  /** The guard line, when there is one. */
  guardLine?: number | undefined;
  /**
   * Why it needs no control (a `control: none — <reason>` line): static or
   * public content, a health check. Undefined when it declares none. It is a
   * declared, visible claim a human can challenge, never a traced control.
   */
  noControl?: string | undefined;
  /** The control line, when there is one. */
  controlLine?: number | undefined;
}

/** The one value a control: line takes, and its reason after a dash: `none — <reason>` (an em dash, or - or --). */
export const NO_CONTROL = /^none(?:\s*(?:—|–|--?)\s*(.*))?$/s;

/** How the control: line is written, for the problems that name it. */
export const NO_CONTROL_FORM = "control: none — <why this entrance needs no control>";

/**
 * A handler named as a module file (a path with an extension): the module's
 * top-level script receives the work. A path may carry a framework's route
 * segments, as every Next.js App Router route does: [slug], [...slug],
 * [[...slug]], (group), (.)intercepted and @slot.
 */
export function isModuleHandler(handler: string): boolean {
  return /^[A-Za-z0-9_./@()[\]-]+\.[A-Za-z]+$/.test(handler.trim()) && !/\s/.test(handler.trim());
}

/**
 * Which references to the protected thing a chokepoint governs: every one
 * (anywhere, the default), only those from outside the component whose spec
 * holds the bullet, or only those from outside a named folder. A reference
 * the chokepoint does not govern is classed exempt and reported, never
 * dropped and never a bypass: a module boundary lets the module's own code
 * use its internals, and a narrow invariant does not.
 */
export type ChokepointFrom = "anywhere" | "outside the component" | { outside: string };

/** How a from: value is written, for the problems that name it. */
export const FROM_FORM = "anywhere, outside the component, or outside <folder>";

/** A from: value read, or undefined when it is none of the three forms. A folder is project-relative and stays under the root. */
export function parseFrom(value: string): ChokepointFrom | undefined {
  const text = value.trim().replace(/\s+/g, " ");
  if (text === "anywhere") return "anywhere";
  if (text === "outside the component") return "outside the component";
  const named = /^outside (.+)$/.exec(text);
  if (named === null) return undefined;
  const folder = named[1]!.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (folder === "" || folder === "." || folder.startsWith("/") || /\s/.test(folder)) return undefined;
  if (folder.split("/").some((segment) => segment === ".." || segment === "" || segment === ".")) return undefined;
  return { outside: folder };
}

/** A from: value as a spec writes it. */
export function fromText(from: ChokepointFrom): string {
  return typeof from === "string" ? from : `outside ${from.outside}`;
}

export type Enforcement =
  | { form: "chokepoint"; protects: string; chokepoint: string; line: number; from?: ChokepointFrom }
  | { form: "totality oracle"; over: string; via: string; line: number };

export interface Refutation {
  broke: string;
  saw: string;
  date: string;
  line: number;
}

export interface Crossing {
  from: string;
  to: string;
  line: number;
}

/**
 * The entrances an invariant covers, by name: the work it checks enters
 * there. Its crossing says which trust it checks; this line says where, so a
 * test-backed check is credited to the entrances it names and to no other
 * entrance its crossing merely matches. "none" says it checks no entrance. A
 * name resolves in the invariant's own spec first, then in the one spec that
 * declares it; `<name> in <folder>` picks among several (see covers.ts).
 */
export interface CoveredEntrances {
  names: string[] | "none";
  line: number;
}

export type ChecklistLine =
  | { shape: string; outcome: "declared"; as: string; line: number }
  | { shape: string; outcome: "dismissed"; reason: string; line: number };

export interface Invariant {
  name: string;
  sentence: string;
  line: number;
  enforcements: Enforcement[];
  because: string | undefined;
  crossing: Crossing | undefined;
  /** The entrances it names as covered (an entrances: line); absent when it names none, and then it covers no entrance by its crossing alone. */
  entrances?: CoveredEntrances | undefined;
  refutations: Refutation[];
  /** Undefined when no kinds line was written; "none" when the line says no shape applies. */
  kinds: string[] | "none" | undefined;
  checklist: ChecklistLine[];
  /** Keys whose value is still a placeholder, as written (a checklist entry names its shape). */
  unfilled: string[];
}

/**
 * A spec's model: line. A file names the quint model that describes the
 * component (a .qnt file beside the spec, or under it); none says why a model
 * does not make sense here; planned says what a model would describe, so
 * "not built yet" never reads as "makes no sense".
 */
export type ModelLine =
  | { kind: "file"; file: string; line: number }
  | { kind: "none"; reason: string; line: number }
  | { kind: "planned"; what: string; line: number };

/** How the model: line is written, for the problems that name it. */
export const MODEL_LINE_FORM = "model: <file>.qnt, model: none — <why a model makes no sense here>, or model: planned — <what it will model>";

/** The none and planned values of a model: line, each with its text after a dash (an em dash, or - or --). */
const MODEL_WORD = /^(none|planned)(?:\s*(?:—|–|--?)\s*(.*))?$/s;

export interface ParsedSpec {
  file: string;
  title: string | undefined;
  intent: string | undefined;
  /** Who owns the component, as an owners: line in the header declares; absent when it declares none. Declared, never routed on. */
  owners?: string[] | undefined;
  /** The spec's model: line; absent when it has none. */
  model?: ModelLine | undefined;
  /** Undefined when the spec has no trust levels section. */
  trustLevels: TrustLevel[] | undefined;
  trustLevelsLine: number | undefined;
  /** Empty when the spec has no entrances section. */
  entrances: Entrance[];
  invariants: Invariant[];
  problems: Problem[];
}

/** A scaffold placeholder: angle brackets around a lowercase lead, as `<the test>`. */
const PLACEHOLDER = /(?:^|\s)<[a-z][^<>]*>(?:$|[\s)|])/;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

const ARROW = /\s*(?:->|→)\s*/;
/** The first arrow in a value, found by position: a lazy group on either side of it backtracks quadratically. */
const ARROW_AT = /->|→/;
/** The date a refuted line ends with, anchored: no group before it, so the scan is linear in the value's length. */
const REFUTED_DATE = /\((\d{4})-(\d{2})-(\d{2})\)\s*$/;

/** Whether three digit groups name a day that exists: 2026-13-45 parses as digits and is no date. */
export function isCalendarDate(year: string, month: string, day: string): boolean {
  const text = `${year}-${month}-${day}`;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

interface Field {
  key: Key;
  value: string;
  line: number;
}

interface RawBullet {
  name: string;
  sentence: string;
  line: number;
  fields: Field[];
}

function normalizeSection(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function retiredSection(name: string): RetiredSection | undefined {
  const key = normalizeSection(name);
  return RETIRED_SECTIONS.find((entry) => entry.section === key);
}

export interface ParseOptions {
  /** The seed, when known kinds and shapes should be checked. */
  seed?: Seed | undefined;
}

export function parseSpec(text: string, file: string, options: ParseOptions = {}): ParsedSpec {
  const lines = text.split(/\r?\n/);
  const problems: Problem[] = [];
  const problem = (line: number, message: string): void => {
    problems.push({ file, line, message });
  };

  let title: string | undefined;
  let intent: string | undefined;
  let owners: string[] | undefined;
  let ownersLine: number | undefined;
  let model: ModelLine | undefined;
  let modelLine: number | undefined;
  let trustLevels: TrustLevel[] | undefined;
  let trustLevelsLine: number | undefined;
  let entrancesSeen = false;
  const entrances: Entrance[] = [];
  const bullets: RawBullet[] = [];

  type Section = "head" | "trust levels" | "entrances" | "invariants" | "skip";
  let section: Section = "head";
  let paragraph: string[] = [];
  let paragraphLine = 0;
  let prose = 0;
  let fenced = false;

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
    prose += 1;
    if (prose === 1) intent = joined;
    else problem(paragraphLine, "prose after the intent: a spec holds one intent line; rationale belongs in because: lines on invariants");
    paragraph = [];
  };

  let current: RawBullet | undefined;
  const closeBullet = (): void => {
    if (current !== undefined) bullets.push(current);
    current = undefined;
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      problem(line, "a fenced block has no place in a spec");
      return;
    }
    if (fenced) return;

    const heading = /^(#+)\s*(.*?)\s*$/.exec(raw);
    if (heading !== null) {
      closeParagraph();
      closeBullet();
      const level = heading[1]!.length;
      const name = heading[2]!;
      if (level === 1) {
        if (title === undefined && section === "head") title = name;
        else problem(line, "one # title per spec, first");
        return;
      }
      if (level > 2) {
        problem(line, `no sub-headings: ${SECTIONS_SENTENCE}`);
        section = "skip";
        return;
      }
      const key = normalizeSection(name);
      if (key === TRUST_LEVELS_SECTION) {
        if (trustLevels !== undefined) problem(line, "## trust levels given twice");
        trustLevels ??= [];
        trustLevelsLine ??= line;
        section = "trust levels";
        return;
      }
      if (key === ENTRANCES_SECTION) {
        if (entrancesSeen) problem(line, "## entrances given twice");
        entrancesSeen = true;
        section = "entrances";
        return;
      }
      if (key === INVARIANTS_SECTION) {
        section = "invariants";
        return;
      }
      const retired = retiredSection(name);
      if (retired !== undefined) {
        problem(line, `## ${retired.section} is retired; its replacement is ${retired.replacement}`);
      } else {
        problem(line, `unknown section "${name}": ${SECTIONS_SENTENCE}`);
      }
      section = "skip";
      return;
    }

    switch (section) {
      case "skip":
        return;
      case "head": {
        if (raw.trim() === "") {
          closeParagraph();
          return;
        }
        // The one header line that is not prose: who owns the component.
        const owned = /^owners:\s*(.*)$/.exec(raw.trim());
        if (owned !== null) {
          closeParagraph();
          if (ownersLine !== undefined) problem(line, "owners: given twice; one owners: line lists every owner, comma separated");
          ownersLine = line;
          const list = owned[1]!.split(",").map((owner) => owner.trim()).filter((owner) => owner !== "");
          if (list.length === 0) problem(line, "owners: names no owner; list them comma separated, or leave the line out");
          else if (!list.some(isPlaceholder)) owners = list;
          return;
        }
        // The other header line that is not prose: the component's quint model, or why there is none.
        const modelled = /^model:\s*(.*)$/.exec(raw.trim());
        if (modelled !== null) {
          closeParagraph();
          if (modelLine !== undefined) problem(line, `model: given twice; one model: line reads ${MODEL_LINE_FORM}`);
          modelLine = line;
          const value = modelled[1]!.trim();
          if (value === "") {
            problem(line, `model: names nothing; it reads ${MODEL_LINE_FORM}`);
            return;
          }
          if (isPlaceholder(value)) return;
          const word = MODEL_WORD.exec(value);
          if (word !== null) {
            const text = (word[2] ?? "").trim();
            if (text === "" || isPlaceholder(text)) problem(line, `model: ${word[1]} needs ${word[1] === "none" ? "the reason a model makes no sense here" : "what the model will describe"}: ${MODEL_LINE_FORM}`);
            else model = word[1] === "none" ? { kind: "none", reason: text, line } : { kind: "planned", what: text, line };
            return;
          }
          if (!/^[^\s]+\.qnt$/.test(value)) {
            problem(line, `model: ${value} is neither a .qnt file nor none or planned with its reason; it reads ${MODEL_LINE_FORM}`);
            return;
          }
          model = { kind: "file", file: value, line };
          return;
        }
        if (paragraph.length === 0) paragraphLine = line;
        paragraph.push(raw.trim());
        return;
      }
      case "trust levels": {
        if (raw.trim() === "") return;
        const bullet = /^[-*]\s+(.*)$/.exec(raw);
        if (bullet === null) {
          problem(line, `a trust level is one bullet: - <name>: <one-line meaning>, or - <name> ${OUTSIDE_MARKER}: <one-line meaning>`);
          return;
        }
        const colon = bullet[1]!.indexOf(":");
        if (colon <= 0) {
          problem(line, `a trust level is one bullet: - <name>: <one-line meaning>, or - <name> ${OUTSIDE_MARKER}: <one-line meaning>`);
          return;
        }
        let name = bullet[1]!.slice(0, colon).trim();
        const meaning = bullet[1]!.slice(colon + 1).trim();
        // The one marker a level may wear: it comes from outside the system's control. Any other is refused, not ignored.
        const marked = /^(.*?)\s*(\([^()]*\))$/.exec(name);
        let outside = false;
        if (marked !== null) {
          if (marked[2] === OUTSIDE_MARKER) outside = true;
          else problem(line, `trust level ${marked[1]} is marked ${marked[2]}; the one marker is ${OUTSIDE_MARKER}, for a level from outside the system's control`);
          name = marked[1]!;
        }
        if (meaning === "") problem(line, `trust level ${name} needs a one-line meaning`);
        if (trustLevels!.some((level) => level.name === name)) problem(line, `trust level ${name} declared twice`);
        trustLevels!.push({ name, meaning, outside, line });
        return;
      }
      case "entrances": {
        if (raw.trim() === "") return;
        const bullet = /^[-*]\s+(.*)$/.exec(raw);
        if (bullet !== null) {
          const colon = bullet[1]!.indexOf(":");
          if (colon <= 0) {
            problem(line, `an entrance is one bullet: - <name>: <one-line meaning>, with an indented handler: <symbol> line and optional trust: <trust level>, guard: <chokepoint> and ${NO_CONTROL_FORM} lines`);
            return;
          }
          const name = bullet[1]!.slice(0, colon).trim();
          const meaning = bullet[1]!.slice(colon + 1).trim();
          if (meaning === "") problem(line, `entrance ${name} needs a one-line meaning`);
          if (entrances.some((entrance) => entrance.name === name)) problem(line, `entrance ${name} declared twice`);
          entrances.push({ name, meaning, handler: undefined, line, handlerLine: line, trust: undefined, trustLine: undefined });
          return;
        }
        const current = entrances[entrances.length - 1];
        const field = /^\s+([a-z]+):\s*(.*)$/.exec(raw);
        if (current === undefined || field === null) {
          problem(line, "expected an entrance bullet (- <name>: <meaning>) or an indented handler:, trust:, guard: or control: line under one");
          return;
        }
        if (field[1] === "trust") {
          if (current.trustLine !== undefined) problem(line, `entrance ${current.name} names its trust twice`);
          const value = field[2]!.trim();
          // A placeholder counts as absent, as on an invariant: the trust is then derived.
          if (value === "") problem(line, `trust: on entrance ${current.name} names no trust level`);
          else if (!isPlaceholder(value)) current.trust = value;
          current.trustLine = line;
          return;
        }
        if (field[1] === "guard") {
          if (current.guardLine !== undefined) problem(line, `entrance ${current.name} names its guard twice`);
          const value = field[2]!.trim();
          if (value === "") problem(line, `guard: on entrance ${current.name} names no chokepoint`);
          else if (!isPlaceholder(value)) current.guard = value;
          current.guardLine = line;
          return;
        }
        if (field[1] === "control") {
          if (current.controlLine !== undefined) problem(line, `entrance ${current.name} names its control twice`);
          current.controlLine = line;
          const value = field[2]!.trim();
          if (value === "" || isPlaceholder(value)) return;
          const none = NO_CONTROL.exec(value);
          if (none === null) {
            problem(line, `control: on entrance ${current.name} takes only none and a reason (${NO_CONTROL_FORM}); a control is traced from the code, or named with guard:`);
            return;
          }
          const reason = (none[1] ?? "").trim();
          if (reason === "" || isPlaceholder(reason)) problem(line, `control: none on entrance ${current.name} needs a reason: ${NO_CONTROL_FORM}`);
          else current.noControl = reason;
          return;
        }
        if (field[1] !== "handler") {
          problem(line, `unknown key "${field[1]}": an entrance carries handler, trust, guard and control`);
          return;
        }
        if (current.handler !== undefined) problem(line, `entrance ${current.name} names its handler twice`);
        current.handler = field[2]!.trim();
        current.handlerLine = line;
        return;
      }
      case "invariants": {
        if (raw.trim() === "") return;
        const bullet = /^[-*]\s+(.*)$/.exec(raw);
        if (bullet !== null) {
          closeBullet();
          const head = bullet[1]!;
          const colon = head.indexOf(":");
          if (colon <= 0) {
            problem(line, "an invariant bullet starts with <name>: <sentence>");
            current = { name: head.trim(), sentence: "", line, fields: [] };
            return;
          }
          const name = head.slice(0, colon).trim();
          const sentence = head.slice(colon + 1).trim();
          if (sentence === "") problem(line, `invariant ${name} needs its sentence: the abstract behavioral requirement`);
          current = { name, sentence, line, fields: [] };
          return;
        }
        if (current === undefined || !/^\s+\S/.test(raw)) {
          problem(line, "expected an invariant bullet (- <name>: <sentence>) or an indented key: value line under one");
          return;
        }
        const body = raw.trim();
        const field = /^([a-z]+):\s*(.*)$/.exec(body);
        if (field !== null) {
          const key = field[1]!;
          if (!(KEYS as readonly string[]).includes(key)) {
            problem(line, `unknown key "${key}": an invariant carries ${KEYS.join(", ")}`);
            return;
          }
          current.fields.push({ key: key as Key, value: field[2]!.trim(), line });
          return;
        }
        // A wrapped line continues the value above it, or the sentence.
        const last = current.fields[current.fields.length - 1];
        if (last === undefined) current.sentence = `${current.sentence} ${body}`.trim();
        else last.value = `${last.value} ${body}`.trim();
        return;
      }
    }
  });
  closeParagraph();
  closeBullet();

  if (title === undefined) problem(1, "a spec starts with # <Name>");
  if (intent === undefined) problem(1, "a spec needs its intent: one line after the title");
  if (fenced) problem(lines.length, "unclosed fenced block");

  for (const entrance of entrances) {
    if (entrance.handler === undefined || entrance.handler === "" || isPlaceholder(entrance.handler)) {
      problem(entrance.line, `entrance ${entrance.name} names no handler: add handler: <symbol, symbol in file, or module file>`);
    }
    // A guard is a control: an entrance that names one cannot also say it needs none.
    if (entrance.noControl !== undefined && entrance.guardLine !== undefined) {
      problem(entrance.controlLine ?? entrance.line, `entrance ${entrance.name} names a guard: and control: none; a guard is a control, so keep one of them`);
    }
  }
  const invariants = bullets.map((bullet) => buildInvariant(bullet, problem, options.seed));
  return { file, title, intent, ...(owners === undefined ? {} : { owners }), ...(model === undefined ? {} : { model }), trustLevels, trustLevelsLine, entrances, invariants, problems };
}

function buildInvariant(bullet: RawBullet, problem: (line: number, message: string) => void, seed: Seed | undefined): Invariant {
  const single = new Map<Key, Field>();
  const many = new Map<Key, Field[]>();
  for (const field of bullet.fields) {
    if (MANY.has(field.key)) {
      const list = many.get(field.key) ?? [];
      list.push(field);
      many.set(field.key, list);
      continue;
    }
    if (single.has(field.key)) {
      problem(field.line, `${field.key}: given twice on ${bullet.name}`);
      continue;
    }
    single.set(field.key, field);
  }
  const unfilled: string[] = [];
  if (isPlaceholder(bullet.name)) unfilled.push("name");
  /** A filled value, or undefined when absent or still a placeholder (recorded as unfilled). */
  const filled = (key: Key): string | undefined => {
    const field = single.get(key);
    if (field === undefined) return undefined;
    if (field.value === "") {
      problem(field.line, `${key}: is empty on ${bullet.name}`);
      return undefined;
    }
    if (isPlaceholder(field.value)) {
      unfilled.push(key);
      return undefined;
    }
    return field.value;
  };

  const enforcements: Enforcement[] = [];
  const pair = (
    a: Key,
    b: Key,
    make: (x: string, y: string, line: number) => Enforcement,
    form: string,
  ): void => {
    const fa = single.get(a);
    const fb = single.get(b);
    if (fa === undefined && fb === undefined) return;
    if (fa === undefined || fb === undefined) {
      const present = fa ?? fb!;
      problem(present.line, `${form} on ${bullet.name} names both ${a}: and ${b}:; ${fa === undefined ? a : b}: is missing`);
      return;
    }
    const x = filled(a);
    const y = filled(b);
    if (x !== undefined && y !== undefined) enforcements.push(make(x, y, fa.line));
  };
  pair("protects", "chokepoint", (protects, chokepoint, line) => ({ form: "chokepoint", protects, chokepoint, line }), "the chokepoint form");
  pair("over", "via", (over, via, line) => ({ form: "totality oracle", over, via, line }), "the totality oracle form");

  // Which references the chokepoint governs: a from: line belongs to the chokepoint form and nothing else.
  const fromField = single.get("from");
  if (fromField !== undefined) {
    const value = filled("from");
    const chokepoint = enforcements.find((e) => e.form === "chokepoint");
    if (!single.has("protects") && !single.has("chokepoint")) problem(fromField.line, `from: on ${bullet.name} belongs to the chokepoint form (protects: and chokepoint:); it names which references the chokepoint governs`);
    else if (value !== undefined) {
      const from = parseFrom(value);
      if (from === undefined) problem(fromField.line, `from: on ${bullet.name} reads ${FROM_FORM}; "${value}" is none of them`);
      else if (chokepoint !== undefined && chokepoint.form === "chokepoint") chokepoint.from = from;
    }
  }

  const because = filled("because");

  let crossing: Crossing | undefined;
  const crossingText = filled("crossing");
  if (crossingText !== undefined) {
    const parts = crossingText.split(ARROW);
    const from = parts[0]?.trim() ?? "";
    const to = parts[1]?.trim() ?? "";
    const line = single.get("crossing")!.line;
    if (parts.length !== 2 || from === "" || to === "") problem(line, `crossing on ${bullet.name} reads <trust level> -> <trust level>`);
    else crossing = { from, to, line };
  }

  // The entrances it covers, named; the model checks each names a declared entrance. A test-backed check is credited
  // only where it is named, so a chokepoint (traced, never named) and an invariant with no crossing (checking no
  // trust) name none.
  let covered: CoveredEntrances | undefined;
  const entrancesField = single.get("entrances");
  const entrancesText = filled("entrances");
  if (entrancesField !== undefined && entrancesText !== undefined) {
    const names = entrancesText.split(",").map((name) => name.trim()).filter((name) => name !== "");
    const doubled = names.find((name, index) => names.indexOf(name) !== index);
    if (names.length === 1 && names[0] === "none") covered = { names: "none", line: entrancesField.line };
    else if (names.includes("none")) problem(entrancesField.line, `entrances on ${bullet.name}: none cannot be combined with an entrance`);
    else if (doubled !== undefined) problem(entrancesField.line, `entrances on ${bullet.name} names ${doubled} twice`);
    else if (single.has("protects") || single.has("chokepoint")) problem(entrancesField.line, `entrances on ${bullet.name}: a chokepoint's entrances are traced, never named; declare guard: <chokepoint> on an entrance whose handler is registered through it`);
    else if (!single.has("crossing")) problem(entrancesField.line, `entrances on ${bullet.name} names the entrances its crossing checks; add crossing: <trust level> -> <trust level>`);
    else covered = { names, line: entrancesField.line };
  }

  const refutations: Refutation[] = [];
  for (const field of many.get("refuted") ?? []) {
    if (isPlaceholder(field.value)) {
      unfilled.push("refuted");
      continue;
    }
    const dated = REFUTED_DATE.exec(field.value);
    if (dated !== null && !isCalendarDate(dated[1]!, dated[2]!, dated[3]!)) {
      problem(field.line, `refuted on ${bullet.name} ends with (${dated[1]}-${dated[2]}-${dated[3]}), which is not a day that exists`);
      continue;
    }
    const head = dated === null ? field.value : field.value.slice(0, dated.index);
    const arrow = ARROW_AT.exec(head);
    const broke = arrow === null ? "" : head.slice(0, arrow.index).trim();
    const saw = arrow === null ? "" : head.slice(arrow.index + arrow[0].length).trim();
    if (dated === null || arrow === null || broke === "" || saw === "") {
      problem(field.line, `refuted on ${bullet.name} reads <what was broken> -> <what was seen> (YYYY-MM-DD)`);
      continue;
    }
    refutations.push({ broke, saw, date: `${dated[1]}-${dated[2]}-${dated[3]}`, line: field.line });
  }

  let kinds: string[] | "none" | undefined;
  const kindsField = single.get("kinds");
  if (kindsField !== undefined) {
    const value = filled("kinds");
    if (value !== undefined) {
      const tags = value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
      if (tags.length === 1 && tags[0] === "none") {
        kinds = "none";
      } else if (tags.includes("none")) {
        problem(kindsField.line, `kinds on ${bullet.name}: none cannot be combined with a kind`);
      } else {
        const unknown = seed === undefined ? [] : tags.filter((tag) => !Object.hasOwn(seed.kinds, tag));
        if (unknown.length > 0) {
          problem(kindsField.line, `kinds on ${bullet.name}: unknown kind ${unknown.join(", ")}; the kinds are ${Object.keys(seed!.kinds).join(", ")}`);
        } else {
          kinds = tags;
        }
      }
    }
  }

  const checklist: ChecklistLine[] = [];
  for (const field of many.get("checklist") ?? []) {
    const declared = /^(\S+)\s+declared as\s+(.+)$/.exec(field.value);
    const dismissed = /^(\S+)\s+dismissed:\s*(.+)$/.exec(field.value);
    const shape = (declared ?? dismissed)?.[1] ?? /^(\S+)/.exec(field.value)?.[1] ?? "";
    if (seed !== undefined && shape !== "" && !isPlaceholder(shape) && seed.shapes.every((s) => s.shape !== shape)) {
      problem(field.line, `checklist on ${bullet.name}: no shape named ${shape}`);
      continue;
    }
    if (isPlaceholder(field.value)) {
      unfilled.push(`checklist ${shape}`);
      continue;
    }
    if (declared !== null) checklist.push({ shape, outcome: "declared", as: declared[2]!.trim(), line: field.line });
    else if (dismissed !== null) checklist.push({ shape, outcome: "dismissed", reason: dismissed[2]!.trim(), line: field.line });
    else problem(field.line, `checklist on ${bullet.name} reads <shape> declared as <invariant name> or <shape> dismissed: <reason>`);
  }

  return {
    name: bullet.name,
    sentence: bullet.sentence,
    line: bullet.line,
    enforcements,
    because,
    crossing,
    ...(covered === undefined ? {} : { entrances: covered }),
    refutations,
    kinds,
    checklist,
    unfilled,
  };
}
