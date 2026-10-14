// A session's journal as the Journal pane tells it: each record in the
// lexicon's verb and its own words, and the files it pinged, with where the
// ping came from. Pure, so the tests hold it without an engine.
//
// A record's files come, in order, from what it names itself (a defect's
// files, an experiment's context), from what the session wrote since its
// record before (the hooks' write trace, else the branch's own commits between
// the two records' commits), and, when it has neither, from what it cites.

import type { Contact, JournalEntry } from '../types'

/** A record as `coherence journal --json` prints it: the fields the pane reads. */
export type Recorded = Record<string, unknown> & { id: string; kind: string; at: string; session: string; agent: string; commit?: string | null; cites?: string[]; files?: string[]; context?: string[] }

/** One commit of the branch's own first-parent line, newest first, and the files it changed. */
export type Committed = { commit: string; files: string[] }

/** One write line of the hooks' trace. */
export type Written = { at: string; files: string[] }

const VERBS: Record<string, string> = {
  decision: 'decided',
  defect: 'found',
  resolution: 'resolved',
  dismissal: 'dismissed',
  retraction: 'retracted',
  conjecture: 'conjectured',
  experiment: 'experiment',
  close: 'closed',
  unable: 'unable',
  escalation: 'needs you',
  acknowledgement: 'acknowledged',
  enactment: 'enacted',
}

/** The verb a record kind reads as; an escalation says it needs the person. */
export function verbOf(kind: string): string {
  return VERBS[kind] ?? kind
}

/** A record's own words: its headline, then the lines under it (what it turned down and why, the owner's words, its candidates). */
export function wordsOf(r: JournalEntry): { head: string; lines: { label: string; text: string }[] } {
  const lines: { label: string; text: string }[] = []
  const add = (label: string, text: string | undefined): void => {
    if (text !== undefined && text.trim() !== '') lines.push({ label, text })
  }
  let head = ''
  switch (r.kind) {
    case 'decision':
      head = r.chose ?? ''
      add('over', r.over?.join('; '))
      add('because', r.because)
      break
    case 'defect':
      head = r.what ?? ''
      add('evidence', r.evidence)
      break
    case 'conjecture':
      head = r.observation ?? ''
      add('could be', r.couldBe?.join(' · '))
      add('told apart by', r.discriminatedBy)
      break
    case 'experiment':
      head = r.expectation ?? ''
      break
    case 'close':
      head = `${r.outcome ?? 'closed'}${r.of === undefined ? '' : ` · ${r.of}`}`
      break
    case 'unable':
    case 'escalation':
      head = r.what ?? ''
      add('because', r.because)
      break
    case 'enactment':
      head = r.practice ?? ''
      break
    default:
      head = r.because ?? r.what ?? ''
      add('guard', r.guard)
  }
  add('you said', r.human)
  return { head, lines }
}

/** Where a record's files came from, as one word for the gutter beside its tree. */
export function sourceOf(from: readonly string[]): string {
  if (from.includes('written') || from.includes('committed')) return 'changed'
  if (from.includes('named')) return 'named'
  if (from.includes('cited')) return 'cited'
  return ''
}

/** The journal's headline: what the session recorded, and how many escalations still wait on the person. */
export function headlineOf(records: readonly JournalEntry[], waiting: number): string {
  const count = (kind: string): number => records.filter(r => r.kind === kind).length
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
  return [
    plural(count('decision'), 'decision'),
    plural(count('defect'), 'defect'),
    ...(count('conjecture') > 0 ? [plural(count('conjecture'), 'conjecture')] : []),
    ...(count('experiment') > 0 ? [plural(count('experiment'), 'experiment')] : []),
    waiting > 0 ? `${waiting} waiting on you` : 'nothing waiting on you',
  ].join(' · ')
}

/** A file of the project's own, not Coherence's records or the host's. */
const isProject = (f: string): boolean => f !== '' && !f.startsWith('.coherence/') && !f.startsWith('.claude/')

/** The commits of `git log --first-parent --name-only --format=@%h`, newest first. */
export function commitsOf(log: string): Committed[] {
  const out: Committed[] = []
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) out.push({ commit: line.slice(1).trim(), files: [] })
    else if (line.trim() !== '') out.at(-1)?.files.push(line.trim())
  }
  return out
}

/** The write lines of the hooks' trace for a session. */
export function writesOf(trace: string): Written[] {
  return trace
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const line = JSON.parse(l) as { kind?: string; at?: string; files?: string[]; file?: string }
        return line.kind === 'write' && typeof line.at === 'string' ? [{ at: line.at, files: line.files ?? (line.file === undefined ? [] : [line.file]) }] : []
      } catch {
        return []
      }
    })
}

/** Whether two commit names are one commit: a short hash and a longer one agree on what they share. */
const same = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a)

/** The files the branch's own commits changed after `from` and up to `to`, on the first-parent line; none when either is off it. */
function changedBetween(chain: readonly Committed[], from: string | null | undefined, to: string | null | undefined): string[] {
  if (from == null || to == null || same(from, to)) return []
  const at = chain.findIndex(c => same(c.commit, to))
  const before = chain.findIndex(c => same(c.commit, from))
  if (at === -1 || before === -1 || at > before) return []
  return chain.slice(at, before).flatMap(c => c.files)
}

/** The records in order, each told: its fields that say something, and the files it pinged with where they came from. */
export function entriesOf(records: readonly Recorded[], chain: readonly Committed[], writes: readonly Written[]): JournalEntry[] {
  const sorted = [...records].filter(r => typeof r.at === 'string').sort((a, b) => a.at.localeCompare(b.at))
  const byId = new Map(sorted.map(r => [r.id, r]))
  const namedBy = (r: Recorded): string[] => [...(Array.isArray(r.files) ? r.files : []), ...(Array.isArray(r.context) ? r.context : [])].filter(isProject)
  return sorted.map((r, i) => {
    const before = sorted[i - 1]
    const named = [...new Set(namedBy(r))]
    const traced = writes.filter(w => (before === undefined || w.at > before.at) && w.at <= r.at).flatMap(w => w.files).filter(isProject)
    const written = [...new Set(traced.length > 0 ? traced : changedBetween(chain, before?.commit, r.commit).filter(isProject))]
    const cited = [...new Set((r.cites ?? []).flatMap(id => {
      const c = byId.get(id)
      return c === undefined ? [] : namedBy(c)
    }))]
    const pings: Contact[] = named.map(path => ({ path, kind: 'read' as const }))
    for (const path of written) if (!named.includes(path)) pings.push({ path, kind: 'edit' })
    const from = named.length > 0 || written.length > 0 ? [...(named.length > 0 ? ['named'] : []), ...(written.length > 0 ? [traced.length > 0 ? 'written' : 'committed'] : [])] : cited.length > 0 ? ['cited'] : []
    if (pings.length === 0) for (const path of cited) pings.push({ path, kind: 'read' })
    const text = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
    const list = (k: string): string[] | undefined => (Array.isArray(r[k]) ? (r[k] as string[]) : undefined)
    const entry: JournalEntry = { id: r.id, kind: r.kind, at: r.at, agent: r.agent, session: r.session, cites: r.cites ?? [], pings: pings.slice(0, 40), from }
    for (const k of ['chose', 'because', 'human', 'what', 'evidence', 'observation', 'discriminatedBy', 'expectation', 'outcome', 'of', 'guard', 'practice'] as const) {
      const v = text(k)
      if (v !== undefined) entry[k] = v
    }
    const over = list('over')
    if (over !== undefined) entry.over = over
    const couldBe = list('couldBe')
    if (couldBe !== undefined) entry.couldBe = couldBe
    return entry
  })
}

/** The session a store file's name starts with: `<session>.jsonl`, or a sealed shard's `<session>.<token>.jsonl`. */
export function sessionOfFile(name: string): string {
  return name.split('.')[0] ?? name
}

/** The journal session a prefix names among the journal's files, or undefined when none does. */
export function sessionOf(prefix: string, names: readonly string[]): string | undefined {
  return names.filter(isRecordFile).map(sessionOfFile).find(n => n.startsWith(prefix))
}

// The live journal: the latest records across every session in the project's
// journal folder and in every git worktree of the same repository, kept up by
// listings alone. A tick lists each folder (one call that carries each file's
// size and time), reads only a file whose size or time moved, and parses only
// the bytes past what it already took from that file. A record's session is
// its own `session` field, never its file's name, so a sealed shard
// (`<session>.<token>.jsonl`) or a packed file (records on one line, each
// ended by U+001E) reads the same. A piece that is no record is counted,
// never dropped unsaid.

/** The extensions a record store's file carries: a packed store's joins this list. */
export const RECORD_FILE_EXTENSIONS: readonly string[] = ['.jsonl']
/** What ends a record: a line, or the packed form's record separator. */
const RECORD_END = /[\n\u001e]/
/** The most one `$.fs.read` copies; a file past it is read from its offset through `tail`. */
export const READ_LIMIT = 4 * 1024 * 1024
/** How long the repository's worktree list holds before it is asked again. */
export const WORKTREES_HOLD_MS = 30_000

export function isRecordFile(name: string): boolean {
  return RECORD_FILE_EXTENSIONS.some(ext => name.endsWith(ext))
}

/** What the live journal reaches the disk and git through: the engine's `$` in the pane, Node's own in a bench. */
export type JournalIo = {
  list: (dir: string) => Promise<readonly { name: string; kind: string; size: number; mtimeMs: number }[]>
  read: (path: string) => Promise<string>
  /** A file's text from a byte offset on, for one past `READ_LIMIT`. */
  tail: (path: string, fromByte: number) => Promise<string>
  exists: (path: string) => Promise<boolean>
  /** A command's stdout; '' when it fails. */
  run: (argv: string[], cwd: string) => Promise<string>
  now: () => Promise<number>
}

/** The UTF-8 bytes of one UTF-16 unit at `i`, and how many units it spans. */
function unitBytes(text: string, i: number): [number, number] {
  const c = text.charCodeAt(i)
  if (c < 0x80) return [1, 1]
  if (c < 0x800) return [2, 1]
  if (c >= 0xd800 && c < 0xdc00) return [4, 2]
  return [3, 1]
}

/** UTF-8 bytes of a string, as a file's size counts them. */
export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; ) {
    const [bytes, units] = unitBytes(text, i)
    n += bytes
    i += units
  }
  return n
}

/** The string offset at which the first `bytes` UTF-8 bytes of `text` end. */
function charsAt(text: string, bytes: number): number {
  let n = 0
  let i = 0
  while (i < text.length && n < bytes) {
    const [b, units] = unitBytes(text, i)
    n += b
    i += units
  }
  return i
}

function isRecord(v: unknown): v is Recorded {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.kind === 'string' && typeof r.at === 'string' && typeof r.session === 'string'
}

/**
 * The records in a stretch of a store file, split on lines and on the packed
 * form's separator. The piece after the last separator is a record still
 * being written unless it parses, so `consumed` stops before it; every other
 * piece that is no record is `damaged`.
 */
export function recordsIn(text: string): { records: Recorded[]; damaged: string[]; consumed: number } {
  const records: Recorded[] = []
  const damaged: string[] = []
  const pieces = text.split(RECORD_END)
  const last = pieces.pop() ?? ''
  const take = (piece: string): boolean => {
    try {
      const v: unknown = JSON.parse(piece)
      if (!isRecord(v)) return false
      records.push({ ...v, agent: typeof v.agent === 'string' ? v.agent : '' })
      return true
    } catch {
      return false
    }
  }
  for (const piece of pieces) if (piece.trim() !== '' && !take(piece)) damaged.push(piece)
  const consumed = last.trim() === '' || take(last) ? text.length : text.length - last.length
  return { records, damaged, consumed }
}

/** The worktree paths of `git worktree list --porcelain`. */
export function worktreesOf(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length).trim())
}

/** How many escalations no acknowledgement points at. */
function openEscalations(records: readonly Recorded[]): number {
  const acknowledged = new Set(records.filter(r => r.kind === 'acknowledgement').map(r => r.of))
  return records.filter(r => r.kind === 'escalation' && !acknowledged.has(r.id)).length
}

/** What one look did: the records that landed, and how many file contents it read. */
export type Scanned = { landed: string[]; read: number }

/** The live journal across the repository's worktrees: what it has taken of each store file, and every record it has seen, once each. */
export class LiveJournal {
  /** Per store file: the size and time it had when read, and how many of its bytes are taken. */
  private readonly files = new Map<string, { size: number; mtimeMs: number; bytes: number }>()
  /** `<name>\0<size>` of each copy read whole: another worktree's copy of the same name and size holds the same records. */
  private readonly readWhole = new Set<string>()
  /** Per file name, the worktrees holding a copy, and its size there. */
  private readonly copies = new Map<string, Map<string, number>>()
  private readonly records = new Map<string, { record: Recorded; file: string }>()
  private readonly damagedPieces = new Set<string>()
  private worktreeList: { at: number; roots: string[] } | undefined
  /** Each record told with its tree, computed once. */
  private readonly told = new Map<string, JournalEntry>()
  /** Per session, the worktree it ran in. */
  private readonly homes = new Map<string, string>()
  /** Per newest commit, the first-parent line from it and how deep it was asked. */
  private readonly chains = new Map<string, { depth: number; chain: Committed[] }>()

  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** The repository's worktrees, this root first, asked of git at most once per hold. */
  async worktrees(io: JournalIo): Promise<string[]> {
    const now = await io.now()
    if (this.worktreeList !== undefined && now - this.worktreeList.at < WORKTREES_HOLD_MS) return this.worktreeList.roots
    const listed = worktreesOf(await io.run(['git', 'worktree', 'list', '--porcelain'], this.root))
    const roots = [...new Set([this.root, ...listed])]
    this.worktreeList = { at: now, roots }
    return roots
  }

  /** One look: lists every worktree's journal folder and reads only the files that moved, from where it left off. */
  async scan(io: JournalIo): Promise<Scanned> {
    const landed: string[] = []
    let read = 0
    const roots = await this.worktrees(io)
    const listings = await Promise.all(roots.map(async root => ({ root, entries: await io.list(`${root}/.coherence/journal`).catch(() => []) })))
    for (const { root, entries } of listings) {
      for (const e of entries) {
        if (e.kind !== 'file' || !isRecordFile(e.name)) continue
        const path = `${root}/.coherence/journal/${e.name}`
        let copies = this.copies.get(e.name)
        if (copies === undefined) this.copies.set(e.name, (copies = new Map()))
        copies.set(root, e.size)
        const was = this.files.get(path)
        if (was !== undefined && was.size === e.size && was.mtimeMs === e.mtimeMs) continue
        if (was === undefined && this.readWhole.has(`${e.name}\0${e.size}`)) {
          this.files.set(path, { size: e.size, mtimeMs: e.mtimeMs, bytes: e.size })
          continue
        }
        // A file that shrank was rewritten: it is read from its start, and records already seen stay once.
        const from = was === undefined || e.size < was.bytes ? 0 : was.bytes
        let fresh: string
        let isWhole = true
        try {
          if (e.size > READ_LIMIT) {
            fresh = await io.tail(path, from)
            isWhole = from + utf8Length(fresh) >= e.size
          } else {
            const text = await io.read(path)
            fresh = text.slice(charsAt(text, from))
          }
        } catch {
          continue
        }
        read++
        const got = recordsIn(fresh)
        for (const piece of got.damaged) this.damagedPieces.add(`${e.name}\0${piece}`)
        for (const record of got.records) {
          if (this.records.has(record.id)) continue
          this.records.set(record.id, { record, file: e.name })
          landed.push(record.id)
        }
        const bytes = from + utf8Length(fresh.slice(0, got.consumed))
        // A read cut short is read again on the next look.
        this.files.set(path, { size: isWhole ? e.size : -1, mtimeMs: e.mtimeMs, bytes })
        if (isWhole && bytes === e.size) this.readWhole.add(`${e.name}\0${e.size}`)
      }
    }
    return { landed, read }
  }

  /** How many pieces of the store files are no record. */
  get damaged(): number {
    return this.damagedPieces.size
  }

  /** How many records it has seen. */
  get total(): number {
    return this.records.size
  }

  /** How many escalations among every record seen still wait on the person. */
  get waiting(): number {
    return openEscalations([...this.records.values()].map(r => r.record))
  }

  /** The latest `n` records, oldest first. */
  latest(n: number): Recorded[] {
    return [...this.records.values()]
      .map(r => r.record)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .slice(-n)
  }

  /** The worktree a session ran in: the one holding its hooks' trace (transient, never committed), else the one with the largest copy of its file. */
  private async homeOf(io: JournalIo, session: string, file: string): Promise<string> {
    const known = this.homes.get(session)
    if (known !== undefined) return known
    const copies = [...(this.copies.get(file) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])
    let home: string | undefined
    for (const [root] of [...copies].sort((a, b) => (a[0] === this.root ? -1 : b[0] === this.root ? 1 : 0))) {
      if (await io.exists(`${root}/.coherence/traces/${session}.jsonl`).catch(() => false)) {
        home = root
        break
      }
    }
    home ??= copies[0]?.[0] ?? this.root
    this.homes.set(session, home)
    return home
  }

  /**
   * The records told, each with its tree: computed once per record, from its
   * own session's records and the trace and commits of the worktree it ran in.
   */
  async entries(io: JournalIo, records: readonly Recorded[]): Promise<JournalEntry[]> {
    const bySession = new Map<string, Recorded[]>()
    for (const r of records) if (!this.told.has(r.id)) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r])
    if (bySession.size > 0) {
      const all = [...this.records.values()].map(r => r.record)
      await Promise.all(
        [...bySession].map(async ([session, untold]) => {
          const home = await this.homeOf(io, session, this.records.get(untold[0]?.id ?? '')?.file ?? '')
          const own = all.filter(r => r.session === session)
          const commits = own.map(r => r.commit).filter((c): c is string => typeof c === 'string')
          const newest = [...own].sort((a, b) => b.at.localeCompare(a.at)).map(r => r.commit).find((c): c is string => typeof c === 'string')
          const depth = Math.min(2000, commits.length + 400)
          // The worktrees share one object store, so a commit's first-parent line is the same from any of them; one at least as deep serves again.
          const held = newest === undefined ? undefined : this.chains.get(newest)
          let chain = held !== undefined && held.depth >= depth ? held.chain : undefined
          if (chain === undefined) {
            // The branch's own first-parent line from the newest record's commit, asked in the worktree the session ran in.
            const log = newest === undefined ? '' : await io.run(['git', 'log', '--first-parent', '--name-only', '--format=@%h', '-n', String(depth + 200), newest], home)
            chain = commitsOf(log)
            if (newest !== undefined) this.chains.set(newest, { depth: depth + 200, chain })
          }
          const trace = await io.read(`${home}/.coherence/traces/${session}.jsonl`).catch(() => '')
          const wanted = new Set(untold.map(r => r.id))
          for (const entry of entriesOf(own, chain, writesOf(trace))) if (wanted.has(entry.id)) this.told.set(entry.id, entry)
        }),
      )
    }
    return records.flatMap(r => {
      const entry = this.told.get(r.id)
      return entry === undefined ? [] : [entry]
    })
  }
}
