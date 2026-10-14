// The Journal pane: the project's Coherence journal told as it happens and
// after the fact. Each record reads in the lexicon's verb (decided, found,
// conjectured, needs you…) and its own words, which fold; under it, always,
// a small tree of the files it pinged, so the person feels where the work went
// without reading it.
//
// Live, its default, it streams the latest records across every session in
// the project's journal folder and in every git worktree of the repository,
// each under its agent and its session's start, so a background agent's
// decisions land beside the main session's as they are written; the store
// files are read straight (journal.ts's LiveJournal), a look every ~2 s while
// the pane is open and after each Bash call. One session's journal
// (`/journal <session>`) is read through the project's own Coherence
// (`coherence journal --session <id> --json`). The pings come from the hooks'
// write trace and the branch's own commits, of the worktree the session ran in.
//
// The band's Journal button and `/journal [live|session]` open it; the agent
// drives it through one tool, `mcp__coherence__journal`. At the end it follows
// what lands, scrolled up it holds still and counts what landed below.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, On, Timer } from 'claude-code'
import type { Contact, JournalEntry, JournalShown } from '../types'
import { LiveJournal, commitsOf, entriesOf, headlineOf, isRecordFile, sessionOf, sessionOfFile, sourceOf, verbOf, wordsOf, writesOf, type JournalIo, type Recorded } from './journal.ts'
import { place } from './place.ts'
import { treeOf } from './tree.ts'

export const JOURNAL_PANE = 'coherence-journal'
const NODE = ['node', '--disable-warning=ExperimentalWarning']
/** How many of a journal's latest records the pane draws. */
const RECORDS = 60
/** The width of the grid's gutter: time, verb, labels. */
const GUTTER = 20
/** How often the open pane looks at the journal's files. */
const TICK_MS = 2000

const shownJournal = atom({ plugin: 'coherence', key: 'journal' } as const, null as JournalShown | null)
const opened = atom({ plugin: 'coherence', key: 'journalOpened' } as const, [] as string[])
const view = atom({ plugin: 'coherence', key: 'journalView' } as const, { following: true, unseen: 0 })

/** The module's own: one session's journal files last read, by their sizes and times, so an unchanged journal is not read again. */
const seen = { session: '', signature: '' }
/** The module's own: the live journal, what it has read of each file, and the open pane's timer. */
const held: { live: LiveJournal | undefined; timer: Timer | undefined; isLooking: boolean } = { live: undefined, timer: undefined, isLooking: false }

/** The disk and git, through the engine. */
function ioOf($: Engine): JournalIo {
  return {
    list: dir => $.fs.list(dir),
    read: path => $.fs.read(path),
    tail: async (path, fromByte) => (await $.process.run(['tail', '-c', `+${fromByte + 1}`, path], { cwd: place.root })).stdout,
    exists: path => $.fs.exists(path),
    run: async (argv, cwd) => {
      const ran = await $.process.run(argv, { cwd, timeoutMs: 30_000 }).catch(() => undefined)
      return ran?.exitCode === 0 ? ran.stdout : ''
    },
    now: () => $.clock.now(),
  }
}

/** The live journal for this session's project, made on first use. */
function liveJournal(): LiveJournal {
  if (held.live?.root !== place.root) held.live = new LiveJournal(place.root)
  return held.live
}

/** The journal sessions on disk, newest file first. */
async function sessions($: Engine, root: string): Promise<{ name: string; size: number; mtimeMs: number }[]> {
  const entries = await $.fs.list(`${root}/.coherence/journal`).catch(() => [])
  return entries.filter(e => e.kind === 'file' && isRecordFile(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The session a prefix names: this session's own when none is given and it has records, else the journal's latest. */
async function chosen($: Engine, prefix: string): Promise<string | undefined> {
  const files = await sessions($, place.root)
  if (prefix !== '') return sessionOf(prefix, files.map(f => f.name))
  const mine = await $.session.id()
  return files.some(f => sessionOfFile(f.name) === mine) ? mine : sessionOf('', files.map(f => f.name))
}

/** A session's store files in the project's journal folder, as one signature of their names, sizes and times. */
async function signatureOf($: Engine, session: string): Promise<string> {
  const files = await sessions($, place.root)
  return files
    .filter(f => sessionOfFile(f.name) === session)
    .map(f => `${f.name}:${f.size}:${f.mtimeMs}`)
    .sort()
    .join('|')
}

/** Reads one session's journal through Coherence and tells it; why not, when it cannot. */
async function told($: Engine, session: string): Promise<JournalShown | string> {
  const cli = place.cli
  if (cli === undefined) return 'no Coherence command line'
  const root = place.root
  const ran = await $.process.run([...NODE, cli, 'journal', '--session', session, '--json'], { cwd: root, timeoutMs: 60_000 })
  if (ran.exitCode !== 0) return ran.stderr.trim().split('\n').at(-1) ?? `exit ${ran.exitCode}`
  const said = JSON.parse(ran.stdout) as { records?: Recorded[]; escalations?: unknown[] }
  const records = said.records ?? []
  const commits = records.map(r => r.commit).filter((c): c is string => typeof c === 'string')
  const newest = [...records].sort((a, b) => b.at.localeCompare(a.at)).map(r => r.commit).find((c): c is string => typeof c === 'string')
  // The branch's own first-parent line from the newest record's commit: a merge brings in other people's work, which no record here is about.
  const log = newest === undefined ? '' : (await $.process.run(['git', 'log', '--first-parent', '--name-only', '--format=@%h', '-n', String(Math.min(2000, commits.length + 400)), newest], { cwd: root }).catch(() => undefined))?.stdout ?? ''
  const trace = await $.fs.read(`${root}/.coherence/traces/${session}.jsonl`).catch(() => '')
  return { session, records: entriesOf(records, commitsOf(log), writesOf(typeof trace === 'string' ? trace : '')), waiting: (said.escalations ?? []).length }
}

/** The live view: the latest records across every session and worktree, each told with its tree. */
async function toldLive($: Engine): Promise<JournalShown> {
  const io = ioOf($)
  const live = liveJournal()
  const latest = live.latest(RECORDS)
  const records = await live.entries(io, latest)
  const worktrees = (await live.worktrees(io)).length
  return { session: 'live', records, waiting: live.waiting, live: { total: live.total, sessions: new Set(latest.map(r => r.session)).size, worktrees, damaged: live.damaged } }
}

/** The journal's headline as the title and the agent read it. */
function headOf(shown: JournalShown): string {
  const damaged = shown.live === undefined || shown.live.damaged === 0 ? '' : ` · ${shown.live.damaged} damaged line${shown.live.damaged === 1 ? '' : 's'} skipped`
  return `${shown.live === undefined ? shown.session.slice(0, 8) : 'live'} · ${headlineOf(shown.records, shown.waiting)}${damaged}`
}

/** Whether the pane is open. */
async function isOpen($: Engine): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some(p => p.id === JOURNAL_PANE)
}

/** The pane's title: the journal's headline, and what landed below while the person read further up. */
async function retitle($: Engine): Promise<void> {
  if (!(await isOpen($))) return
  const shown = await read($, shownJournal)
  const { unseen } = await read($, view)
  await $.ui.open({ id: JOURNAL_PANE, title: `Journal${shown === null ? '' : ` · ${headOf(shown)}`}${unseen === 0 ? '' : ` · ↓ ${unseen} new below`}` }).catch(() => undefined)
}

/** Back to the journal's end: the window follows again and what landed below counts as seen. */
async function toEnd($: Engine): Promise<void> {
  await update($, view, () => ({ following: true, unseen: 0 }))
  await $.ui.scroll({ in: JOURNAL_PANE, to: 'end' }).catch(() => undefined)
  await retitle($)
}

/** While the pane is open, a look every TICK_MS; the look ends the timer once the pane is closed. */
function startLooking($: Engine): void {
  if (held.timer !== undefined) return
  held.timer = $.clock.every(TICK_MS, () => void look($).catch(() => undefined))
}

/** Opens the pane on the live journal and says what it shows. */
async function openLive($: Engine): Promise<string> {
  await liveJournal().scan(ioOf($))
  const shown = await toldLive($)
  await update($, shownJournal, () => shown)
  await $.ui.open({ id: JOURNAL_PANE, title: 'Journal' })
  startLooking($)
  await toEnd($)
  const live = shown.live
  return `The Journal pane streams the latest ${shown.records.length} of ${live?.total ?? 0} records, ${live?.sessions ?? 0} sessions across ${live?.worktrees ?? 1} worktrees: ${headOf(shown).replace(/^live · /, '')}.`
}

/** Opens the pane: live when no session is named (or `live` is), else on that session's journal; says what it shows. */
async function openJournal($: Engine, prefix = ''): Promise<string> {
  if (place.root === '') return 'Coherence is still starting; try again in a moment.'
  if (prefix === '' || prefix === 'live') return openLive($)
  const session = await chosen($, prefix)
  if (session === undefined) return `No journal session starts ${prefix}.`
  const shown = await told($, session)
  if (typeof shown === 'string') return `The journal could not be read: ${shown}`
  await update($, shownJournal, () => shown)
  Object.assign(seen, { session, signature: await signatureOf($, session) })
  await $.ui.open({ id: JOURNAL_PANE, title: 'Journal' })
  startLooking($)
  await toEnd($)
  return `The Journal pane shows ${session}: ${shown.records.length} records, ${headlineOf(shown.records, shown.waiting)}.`
}

/** What lands: at the end the pane follows it, scrolled up it counts what landed below. */
async function land($: Engine, before: JournalShown, next: JournalShown): Promise<void> {
  const had = new Set(before.records.map(r => r.id))
  const last = before.records.at(-1)?.at ?? ''
  const landed = next.records.filter(r => !had.has(r.id) && r.at >= last).length
  await update($, shownJournal, () => next)
  if ((await read($, view)).following) await $.ui.scroll({ in: JOURNAL_PANE, to: 'end' }).catch(() => undefined)
  else if (landed > 0) await update($, view, v => ({ ...v, unseen: v.unseen + landed }))
  await retitle($)
}

/**
 * One look while the pane is open. Live: list the worktrees' journal folders
 * and read what moved, never the command line. One session's: its files'
 * signature, and the command line only when it moved. A closed pane ends the timer.
 */
async function look($: Engine): Promise<void> {
  if (held.isLooking) return
  held.isLooking = true
  try {
    if (!(await isOpen($))) {
      held.timer?.cancel()
      held.timer = undefined
      return
    }
    const shown = await read($, shownJournal)
    if (shown === null) return
    if (shown.live !== undefined) {
      const live = liveJournal()
      const damaged = live.damaged
      const { landed } = await live.scan(ioOf($))
      if (landed.length === 0 && live.damaged === damaged) return
      await land($, shown, await toldLive($))
      return
    }
    const signature = await signatureOf($, shown.session)
    if (signature === '' || (seen.session === shown.session && seen.signature === signature)) return
    Object.assign(seen, { session: shown.session, signature })
    const next = await told($, shown.session)
    if (typeof next !== 'string') await land($, shown, next)
  } finally {
    held.isLooking = false
  }
}

type Asked = { session?: string; open?: string[]; fold?: string[]; scrollTo?: string }

/** The agent's hand on the pane: which journal, which records to open or fold, where to scroll. */
async function drive($: Engine, asked: Asked): Promise<string> {
  const said: string[] = []
  if (asked.session !== undefined || (await read($, shownJournal)) === null) said.push(await openJournal($, asked.session ?? ''))
  const ids = (list: string[] | undefined): string[] => (list ?? []).flatMap(id => [`rec:${id}`, `tree:${id}`])
  if ((asked.open ?? []).length > 0 || (asked.fold ?? []).length > 0) {
    const folding = new Set(ids(asked.fold))
    await update($, opened, now => [...new Set([...now.filter(x => !folding.has(x)), ...ids(asked.open)])])
    said.push([...(asked.open?.length ? [`opened ${asked.open.join(', ')}`] : []), ...(asked.fold?.length ? [`folded ${asked.fold.join(', ')}`] : [])].join('; '))
  }
  if (asked.scrollTo !== undefined) {
    const to = asked.scrollTo === 'end' || asked.scrollTo === 'start' ? asked.scrollTo : { key: `rec-${asked.scrollTo}` }
    await update($, view, v => ({ ...v, following: asked.scrollTo === 'end' }))
    const moved = await $.ui.scroll({ in: JOURNAL_PANE, to, block: 'start' }).catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    said.push(moved.deny === undefined ? `scrolled to ${asked.scrollTo}` : `could not scroll to ${asked.scrollTo}: ${moved.deny}`)
  }
  return said.length === 0 ? 'Nothing asked of the pane.' : `${said.map(s => s.replace(/\.$/, '')).join('. ')}.`
}

/** A time of day, 24-hour. */
function clockOf(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The /journal command, as the mod registers it at the session's start. */
export const JOURNAL_COMMAND = { name: 'journal', description: "Open the Journal pane: the latest records live across every session and worktree, or one session's journal by its id's start (/journal live goes back)" }

/** The agent's hand on the pane, as the mod registers it at the session's start; served here as mcp__coherence__journal. */
export const JOURNAL_TOOL = {
  name: 'journal',
  description:
    "Controls the person's Journal pane, which tells them the Coherence journal: each record (decided, found, conjectured, needs you…) under its agent and session, with a small tree of the files it touched. By default it streams the latest records live across every session and git worktree of the repository. session: an id's start shows that one session's journal; 'live' goes back to the live view; left out, the pane keeps what it shows (live when nothing is open). open / fold: record ids (d-…, df-…, c-…) whose words to open or fold. scrollTo: 'end', 'start' or a record id. Use it to show the person the record you are talking about.",
  inputSchema: {
    type: 'object',
    properties: {
      session: { type: 'string', description: "a session id or its start, or 'live' for the latest records across every session and worktree" },
      open: { type: 'array', items: { type: 'string' } },
      fold: { type: 'array', items: { type: 'string' } },
      scrollTo: { type: 'string', description: "'end', 'start' or a record id" },
    },
    additionalProperties: false,
  },
  isDeferred: false as const,
}

/** The pane's hooks: /journal, the agent's tool, the pane's opening, the looks, the person's scrolling, and the drawing. */
export function journalPane(on: On): void {
  on('command.run', { command: 'journal' }, async ($, e) => ({ text: await openJournal($, e.args.trim()) }))

  on('tool.call', { tool: /^mcp__coherence__journal$/ }, async ($, e) => ({ result: await drive($, e as unknown as Asked) }))

  // The band's Journal button: its own $.ui.open never reaches this plugin's ui.open hook, so the press itself loads the journal.
  on('ui.press', { plugin: 'coherence', component: 'AbovePrompt', element: 'journal' }, async ($, e) => {
    await openJournal($)
    return { element: e.element }
  })

  // Opened by another plugin or the host: it streams the live journal when nothing is shown, and looks again either way.
  on('ui.open', { id: JOURNAL_PANE }, async ($, e, next) => {
    const answer = await next(e)
    if ((await read($, shownJournal)) === null) void openJournal($).catch(() => undefined)
    else startLooking($)
    return answer
  })

  // A record is written through the command line, so a Bash call is when the journal may well have grown: a look then, besides the timer's.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    void look($).catch(() => undefined)
    return ran
  })

  // The person's own scrolling decides whether the pane follows: at the end it does, and what landed below is seen.
  on('ui.scroll', { component: 'Pane', requestId: JOURNAL_PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (e.origin.kind === 'person') {
      const atEnd = e.offset + e.bodyRows >= e.contentRows - 1
      if (atEnd !== (await read($, view)).following) {
        await update($, view, v => ({ following: atEnd, unseen: atEnd ? 0 : v.unseen }))
        if (atEnd) await retitle($)
      }
    }
    return moved
  })

  on('ui.render', { component: 'Pane', requestId: JOURNAL_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, shownJournal)
    const unfolded = new Set(await read($, opened))
    const window = await read($, view)
    const toggle = (id: string) => () => void update($, opened, now => (now.includes(id) ? now.filter(x => x !== id) : [...now, id]))
    const contentWidth = Math.max(20, (e.props.bodyColumns ?? 80) - GUTTER - 1)

    // A reload starts the module over with the pane still drawn: its drawing starts the looks again.
    if (shown !== null) startLooking($)
    if (shown === null) return <Text dimColor>No journal is open. /journal streams the latest records live, or one session's by its id's start.</Text>

    // The grid: a gutter of fixed width and a content column that wraps inside itself.
    const row = (left: unknown, content: unknown) => (
      <Box flexDirection="row">
        <Box width={GUTTER} flexShrink={0}>
          {left as never}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {content as never}
        </Box>
      </Box>
    )
    const cut = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)

    // A record's ping: dim guides, folders in the text's own tone, files dim, a changed file bright; its folds open on press.
    const tree = (contacts: readonly Contact[], id: string) => {
      const isOpen = unfolded.has(`tree:${id}`)
      const drawn = treeOf(contacts, isOpen ? Number.POSITIVE_INFINITY : 8)
      const canFold = isOpen && treeOf(contacts, 8).length < drawn.length
      return (
        <Box flexDirection="column">
          {drawn.map((line, i) =>
            line.kind === 'more' ? (
              <Box>
                <Text dimColor>{line.guide}</Text>
                <Button key={`fold-${id}-${i}`} label={line.text} plain dimColor onPress={toggle(`tree:${id}`)} />
              </Box>
            ) : (
              <Text wrap="truncate-end">
                <Text dimColor>{line.guide}</Text>
                <Text dimColor={line.kind !== 'dir' && !line.isEdited} bold={line.isEdited}>{`${line.text}${line.isEdited ? ' ✎' : ''}`}</Text>
              </Text>
            ),
          )}
          {canFold && <Button key={`fewer-${id}`} label="fewer" plain dimColor onPress={toggle(`tree:${id}`)} />}
        </Box>
      )
    }

    // A record pings: its verb and words fold, its tree stays, so where the work went is always felt.
    const record = (r: JournalEntry, time: string, isNewAgent: boolean, isNewDay: boolean) => {
      const { head, lines } = wordsOf(r)
      const isOpen = unfolded.has(`rec:${r.id}`)
      const canOpen = lines.length > 0 || head.length > contentWidth
      const color = r.kind === 'escalation' || r.kind === 'unable' ? 'warning' : r.kind === 'defect' ? 'error' : r.kind === 'decision' ? 'claude' : undefined
      const verb = canOpen ? (
        <Button key={`rec-${r.id}-open`} plain onPress={toggle(`rec:${r.id}`)}>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text bold color={color}>
            {verbOf(r.kind)}
          </Text>
        </Button>
      ) : (
        <Text bold={r.kind !== 'enactment'} dimColor={r.kind === 'enactment'} color={color}>{`  ${verbOf(r.kind)}`}</Text>
      )
      return (
        <Box key={`rec-${r.id}`} flexDirection="column" marginTop={r.kind === 'enactment' ? 0 : 1}>
          {isNewDay && <Text dimColor>{`${new Date(r.at).toDateString()}\n`}</Text>}
          {isNewAgent && (
            <Text>
              <Text bold>{r.agent === '' ? 'unnamed agent' : r.agent}</Text>
              {r.session !== undefined && <Text dimColor>{` · ${r.session.slice(0, 8)}`}</Text>}
            </Text>
          )}
          {row(
            <Box flexDirection="row">
              <Text dimColor>{time.padEnd(7)}</Text>
              {verb}
            </Box>,
            isOpen ? <Text wrap="wrap">{head}</Text> : <Text dimColor={r.kind === 'enactment'}>{cut(head, contentWidth)}</Text>,
          )}
          {isOpen && lines.map(l => row(<Text dimColor>{`${''.padEnd(9)}${l.label}`}</Text>, <Text wrap="wrap" dimColor={l.label !== 'you said'}>{l.text}</Text>))}
          {r.pings.length > 0 && row(<Text dimColor>{`${''.padEnd(9)}${sourceOf(r.from)}`}</Text>, tree(r.pings, r.id))}
        </Box>
      )
    }

    const records = shown.records.slice(-RECORDS)
    const day = (iso: string): string => new Date(iso).toDateString()
    return (
      <Box flexDirection="column">
        <Text wrap="wrap">
          <Text bold>{shown.live === undefined ? `journal of ${shown.session.slice(0, 8)}` : 'live journal'}</Text>
          <Text dimColor>{` · ${headlineOf(shown.records, shown.waiting)}`}</Text>
        </Text>
        {shown.live !== undefined && (
          <Text dimColor wrap="wrap">{`latest ${shown.records.length} of ${shown.live.total} records · ${shown.live.sessions} sessions · ${shown.live.worktrees} worktrees${shown.live.damaged === 0 ? '' : ` · ${shown.live.damaged} damaged line${shown.live.damaged === 1 ? '' : 's'} skipped`}`}</Text>
        )}
        {shown.live === undefined && shown.records.length > records.length && <Text dimColor>{`${shown.records.length - records.length} earlier records`}</Text>}
        {records.map((r, i) => {
          const before = records[i - 1]
          // A cluster of records in one minute shows its time once.
          const time = before !== undefined && clockOf(before.at) === clockOf(r.at) && day(before.at) === day(r.at) ? '' : clockOf(r.at)
          return record(r, time, before === undefined || before.agent !== r.agent || before.session !== r.session, before === undefined || day(before.at) !== day(r.at))
        })}
        {/* Scrolled up with news below: a bar on the window's own bottom row, painted over the journal, that jumps to the end. */}
        {!window.following && window.unseen > 0 && e.props.scroll !== undefined && (
          <Box position="absolute" top={e.props.scroll.offset + e.props.scroll.bodyRows - 1} left={0} width={e.props.bodyColumns ?? 80} backgroundColor="claude">
            <Button key="to-end" plain onPress={() => void toEnd($)}>
              <Text color="inverseText">{` ↓ ${window.unseen} new below · jump to latest `}</Text>
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
