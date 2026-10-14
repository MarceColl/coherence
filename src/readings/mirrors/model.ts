/**
 * The mirror reading's model: what a reading holds, as plain data a record
 * can keep and orient can read without loading the reading itself.
 */

export type Form =
  | "array" | "set" | "keys" | "values" | "column" | "alternation" | "union" | "cases"
  | "doc-alternation" | "doc-table" | "prose"
  | "folder" | "closure" | "exports" | "reads";

export const DOC_FORMS: ReadonlySet<Form> = new Set<Form>(["doc-alternation", "doc-table", "prose"]);
/** Sets code derives: never kept by hand, so a finding needs a literal on its other side. */
export const DERIVED: ReadonlySet<Form> = new Set<Form>(["folder", "closure", "exports", "reads"]);

export type Verdict = "drifted" | "latent" | "duplicate";

/** One set as a finding names it: where it is, what it is, and what it holds. */
export interface SetRef {
  file: string;
  /** 0 for a universe, which has no line of its own. */
  line: number;
  name: string;
  form: Form;
  /** The compiler holds these to a type (`Record<Kind, …>`, an exhaustive switch): not kept by hand. */
  checked: boolean;
  members: string[];
  /** For an import closure: the files whose imports it follows, as the list spells them. */
  of?: string[];
  /** For the import closure of a list of files: where that list is, as file:line. */
  list?: string;
}

export interface Missed {
  /** The commit, abbreviated to seven characters. */
  commit: string;
  subject: string;
  member: string;
  /** Which side the commit grew alone. */
  side: "a" | "b";
}

export interface MirrorHistory {
  /** Commits that grew both sides by the same name, the birth of neither. */
  together: string[];
  /** Shared names added to each side in different commits. */
  lagged: string[];
  /** Commits that grew one side by a name now only on that side. */
  missed: Missed[];
}

export interface Finding {
  /** The hand-kept side. */
  a: SetRef;
  b: SetRef;
  verdict: Verdict;
  shared: string[];
  onlyA: string[];
  onlyB: string[];
  /** A third set that accounts for the difference: A is B together with it. */
  union?: SetRef;
  jaccard: number;
  containment: number;
  score: number;
  overlapScore: number;
  historyScore: number;
  /** The other sets equal to one side: the copies this finding stands for. */
  copies: SetRef[];
  history?: MirrorHistory;
}

/** Findings that share a cluster: one question for the reader, ranked by its strongest finding. */
export interface Group {
  rank: number;
  score: number;
  overlapScore: number;
  historyScore: number;
  findings: Finding[];
}

export interface MirrorReading {
  /** The revision as asked for (HEAD by default). */
  rev: string;
  /** The commit it resolved to. */
  commit: string;
  /** Milliseconds the reading took, and per phase. */
  ms: number;
  phases: Record<string, number>;
  sets: number;
  /** The code files the reading parsed (TypeScript and JavaScript). */
  read: number;
  /** The tracked files in a language the reading does not parse, counted by extension: `{ ".py": 4123 }`. */
  unread: Record<string, number>;
  groups: Group[];
}
