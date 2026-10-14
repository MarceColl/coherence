import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { commitsOf, entriesOf, headlineOf, isRecordFile, recordsIn, sessionOf, sourceOf, verbOf, wordsOf, writesOf, type Recorded } from '../hooks/journal.ts'
import { treeOf } from '../hooks/tree.ts'

const SESSION = '8efd6465-4c20-4d13-9f34-c17de56799d9'
const RECORDS: Recorded[] = [
  { id: 'df-608d319a', kind: 'defect', at: '2026-10-12T11:09:25.729Z', session: SESSION, agent: 'main', commit: '95683be', what: 'Tests pay the CLI start once per call', files: ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts'] },
  { id: 'd-de52921c', kind: 'decision', at: '2026-10-12T11:15:02.039Z', session: SESSION, agent: 'main', commit: 'c9798a1', chose: 'CI runs the unit tests in two shards', over: ['one verify job running npm test'], because: 'the unit step is bound by the runner cores', cites: ['df-608d319a'] },
  { id: 'd-3af1ab42', kind: 'decision', at: '2026-10-12T11:15:22.044Z', session: SESSION, agent: 'main', commit: 'c114081', chose: 'the prefilter pass runs in the CI bench job', human: 'keep the fixtures', cites: ['df-608d319a'] },
]
// The branch's first-parent line from the newest record's commit, newest first: the records commit, the work commit, the defect's.
const LOG = ['@c114081', '.coherence/journal/x.jsonl', '', '@c9798a1', '.github/workflows/ci.yml', 'package.json', 'src/readings/scope/both-ways.ts', '', '@95683be', 'mods/coherence/hooks/register.tsx'].join('\n')

test('a record pings what it names, what the branch committed since the record before, else what it cites', async () => {
  const told = entriesOf(RECORDS, commitsOf(LOG), [])
  expect(told.map(r => [r.id, r.from, r.pings.map(p => `${p.path}${p.kind === 'edit' ? ' ✎' : ''}`)])).toEqual([
    ['df-608d319a', ['named'], ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts']],
    ['d-de52921c', ['committed'], ['.github/workflows/ci.yml ✎', 'package.json ✎', 'src/readings/scope/both-ways.ts ✎']],
    // Its range holds only Coherence's own records, which are no file of the project: it pings what it cites.
    ['d-3af1ab42', ['cited'], ['src/lifecycle/install.test.ts', 'src/readings/scope/component-interfaces.test.ts']],
  ])
  expect(sourceOf(told[1]?.from ?? [])).toBe('changed')
})

test("the hooks' write trace, when it has the session's writes, is what a record pings ahead of the commits", async () => {
  const writes = writesOf(['{"kind":"read","at":"2026-10-12T11:10:00Z","file":"a.ts"}', '{"kind":"write","at":"2026-10-12T11:12:00Z","files":["src/x.ts",".coherence/runs/r.jsonl"]}', 'not json'].join('\n'))
  expect(writes).toEqual([{ at: '2026-10-12T11:12:00Z', files: ['src/x.ts', '.coherence/runs/r.jsonl'] }])
  const told = entriesOf(RECORDS, commitsOf(LOG), writes)
  expect(told[1]?.from).toEqual(['written'])
  expect(told[1]?.pings).toEqual([{ path: 'src/x.ts', kind: 'edit' }])
})

test("a record reads in the lexicon's verb and its own words; the headline counts what waits on the person", async () => {
  const told = entriesOf(RECORDS, commitsOf(LOG), [])
  const decided = told[1]
  expect(verbOf('decision')).toBe('decided')
  expect(verbOf('escalation')).toBe('needs you')
  expect(decided === undefined ? undefined : wordsOf(decided)).toEqual({
    head: 'CI runs the unit tests in two shards',
    lines: [
      { label: 'over', text: 'one verify job running npm test' },
      { label: 'because', text: 'the unit step is bound by the runner cores' },
    ],
  })
  expect(told[2] === undefined ? [] : wordsOf(told[2]).lines).toEqual([{ label: 'you said', text: 'keep the fixtures' }])
  expect(headlineOf(told, 0)).toBe('2 decisions · 1 defect · nothing waiting on you')
  expect(headlineOf(told, 1)).toBe('2 decisions · 1 defect · 1 waiting on you')
  expect(sessionOf('8efd', [`${SESSION}.jsonl`, 'other.jsonl'])).toBe(SESSION)
  expect(treeOf(told[1]?.pings ?? []).map(l => `${l.guide}${l.text}`)).toEqual(['.github/workflows/', '└─ ci.yml', 'src/readings/scope/', '└─ both-ways.ts', 'package.json'])
})

test('a store file reads on lines and on the packed separator, counts what is no record, and holds a record still being written', async () => {
  const [a, b, c] = RECORDS.map(r => JSON.stringify(r))
  const got = recordsIn(`${a}\u001e${b}\nnot a record\n{"id":"x"}\n${c}\n{"id":"half`)
  expect(got.records.map(r => r.id)).toEqual(['df-608d319a', 'd-de52921c', 'd-3af1ab42'])
  expect(got.damaged).toEqual(['not a record', '{"id":"x"}'])
  expect(got.consumed).toBe(`${a}\u001e${b}\nnot a record\n{"id":"x"}\n${c}\n`.length)
  expect(sessionOf('8efd', [`${SESSION}.k3j9.jsonl`, 'other.jsonl', 'notes.txt'])).toBe(SESSION)
})

/** A disk in memory: each file's text and time; a file's size is its text's length. */
type Disk = Map<string, { text: string; mtimeMs: number }>
const lines = (records: readonly Recorded[]): string => records.map(r => `${JSON.stringify(r)}\n`).join('')

/** Appends to a file of the disk, moving its time on. */
function append(disk: Disk, path: string, text: string): void {
  const was = disk.get(path)
  disk.set(path, { text: `${was?.text ?? ''}${text}`, mtimeMs: (was?.mtimeMs ?? 0) + 1 })
}

type World = { ran: { argv: string[]; cwd: string }[]; opened: string[]; titles: string[]; reads: string[]; lists: string[]; disk: Disk; pane: { isOpen: boolean }; clock: ReturnType<typeof mock.clock> }

/** The engine beneath the mod: a session in /p whose journal folder holds RECORDS, read through a Coherence CLI at /coh, in a repository whose worktrees are `worktrees`. */
function engine(on: On, worktrees: string[] = ['/p']): World {
  const world: World = { ran: [], opened: [], titles: [], reads: [], lists: [], disk: new Map(), pane: { isOpen: true }, clock: mock.clock(on) }
  const { disk } = world
  disk.set(`/p/.coherence/journal/${SESSION}.jsonl`, { text: lines(RECORDS), mtimeMs: 1 })
  mock.env(on, { COHERENCE_HOME: '/coh' })
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.stat', ($, e) => {
    if (e.path === '/coh/src/cli.ts') return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: '/coh/src/cli.ts' } }
    const file = disk.get(e.path)
    return file === undefined ? Promise.reject(new Error('ENOENT')) : { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', ($, e) => {
    world.lists.push(e.path)
    const entries = [...disk.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(([path, file]) => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false }))
    return entries.length === 0 ? Promise.reject(new Error('ENOENT')) : { value: entries }
  })
  on('fs.read', ($, e) => {
    const file = disk.get(e.path)
    if (file === undefined) return Promise.reject(new Error('ENOENT'))
    world.reads.push(e.path)
    return { value: file.text }
  })
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: world.pane.isOpen ? [{ id: 'coherence-journal', title: 'Journal', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    if (e.title !== undefined) world.titles.push(e.title)
    return { value: { isPlaced: true } } as never
  })
  on('ui.scroll', () => ({}))
  on('process.spawn', async function* () {
    await new Promise(() => {})
  })
  on('process.run', ($, e) => {
    world.ran.push({ argv: [...e.argv], cwd: e.init?.cwd ?? '' })
    const argv = e.argv.join(' ')
    const stdout = argv.includes('cli.ts journal')
      ? JSON.stringify({ records: RECORDS, escalations: [] })
      : argv.startsWith('git worktree list')
        ? worktrees.map(w => `worktree ${w}\nHEAD 0000000\n`).join('\n')
        : argv.startsWith('git log')
          ? LOG
          : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SessionStart', () => ({}))
  return world
}

const PANE = { plugin: 'coherence', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'coherence-journal', props: { title: 'Journal', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never }
const OTHER = 'b0b0b0b0-1111-2222-3333-444455556666'
const cliRuns = (world: World): number => world.ran.filter(r => r.argv.join(' ').includes('cli.ts journal')).length

test('a store file is a line shard or a packed one, as the store names them, and nothing else', () => {
  expect(isRecordFile('8efd6465-4c20.a1b2c3d4.jsonl')).toBe(true)
  expect(isRecordFile('8efd6465-4c20.a1b2c3d4.jsonseq')).toBe(true)
  expect(isRecordFile('8efd6465-4c20.jsonl')).toBe(true)
  expect(isRecordFile('notes.json')).toBe(false)
})

test("the band's Journal button sits beside Scope, and a press opens the pane streaming the journal live, without the command line", async ($, on) => {
  const world = engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const band = await $.ui.mount({ plugin: 'coherence', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const buttons = JSON.stringify(await band.findAll({ type: 'Button' }))
  expect(buttons).toContain('Scope ↗')
  expect(buttons).toContain('Journal')
  await band.press({ key: 'journal' })
  expect(world.opened).toContain('coherence-journal')
  expect(cliRuns(world)).toBe(0)
  const pane = await $.ui.mount(PANE)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('live journal')
  expect(drawn).toContain('latest 3 of 3 records · 1 sessions · 1 worktrees')
  expect(drawn).toContain(' · 8efd6465')
  expect(drawn).toContain('ci.yml ✎')
  await pane.unmount()
  await band.unmount()
})

test("one session's journal tells each record over its tree, its words folded behind the verb", async ($, on) => {
  const world = engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal', session: '8efd' } as never)
  expect(world.ran.some(r => r.argv.join(' ') === `node --disable-warning=ExperimentalWarning /coh/src/cli.ts journal --session ${SESSION} --json`)).toBe(true)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('journal of 8efd6465')
  expect(drawn).toContain('2 decisions · 1 defect · nothing waiting on you')
  expect(drawn).toContain('found')
  expect(drawn).toContain('decided')
  expect(drawn).toContain('ci.yml ✎')
  expect(drawn).not.toContain('the unit step is bound by the runner cores')
  await pane.press({ key: 'rec-d-de52921c-open' })
  expect(JSON.stringify(await pane.drawn())).toContain('the unit step is bound by the runner cores')
  // `live` goes back to the live view.
  const said = await $.tool.call({ tool: 'mcp__coherence__journal', session: 'live' } as never)
  expect(JSON.stringify(said)).toContain('The Journal pane streams the latest 3 of 3 records, 1 sessions across 1 worktrees')
  expect(JSON.stringify(await pane.drawn())).toContain('live journal')
  await pane.unmount()
})

test('the agent opens a record for the person through its tool', async ($, on) => {
  engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  const said = await $.tool.call({ tool: 'mcp__coherence__journal', session: '8efd', open: ['d-3af1ab42'] } as never)
  expect(JSON.stringify(said)).toContain(`The Journal pane shows ${SESSION}: 3 records, 2 decisions · 1 defect · nothing waiting on you. opened d-3af1ab42.`)
  expect(JSON.stringify(await pane.drawn())).toContain('keep the fixtures')
  await pane.unmount()
})

test("one session's record written while the pane is open lands in it after the Bash call that wrote it", async ($, on) => {
  const world = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal', session: '8efd' } as never)
  const before = cliRuns(world)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await world.clock.settle()
  expect(cliRuns(world)).toBe(before)
  append(world.disk, `/p/.coherence/journal/${SESSION}.jsonl`, '{}\n')
  await $.tool.call({ tool: 'Bash', command: 'node src/cli.ts decide x --because y' } as never)
  for (let i = 0; i < 2000 && cliRuns(world) === before; i++) await Promise.resolve()
  expect(cliRuns(world)).toBe(before + 1)
  await pane.unmount()
})

test("another session's record, in a sealed shard, lands on the next look with no Bash call; scrolled up, the pane counts it", async ($, on) => {
  const world = engine(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal', scrollTo: 'start' } as never)
  expect(JSON.stringify(await pane.drawn())).not.toContain('the background agent chose this')
  const record = { id: 'd-0b0b0b0b', kind: 'decision', at: '2026-10-12T12:00:00.000Z', session: OTHER, agent: 'journal-live', chose: 'the background agent chose this' }
  append(world.disk, `/p/.coherence/journal/${OTHER}.q7x2.jsonl`, lines([record]))
  await world.clock.advance(2000)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('the background agent chose this')
  expect(drawn).toContain('journal-live')
  expect(drawn).toContain(' · b0b0b0b0')
  expect(world.titles.at(-1)).toContain('↓ 1 new below')
  expect(cliRuns(world)).toBe(0)
  await pane.unmount()
})

test("a record in a second worktree's journal shows, its tree from that worktree's own trace", async ($, on) => {
  const world = engine(on, ['/p', '/w2'])
  const record = { id: 'd-2c2c2c2c', kind: 'decision', at: '2026-10-12T12:05:00.000Z', session: 'a2c2c2c2c2c2c2c2c', agent: 'general-purpose', chose: 'the worktree agent decided' }
  world.disk.set('/w2/.coherence/journal/a2c2c2c2c2c2c2c2c.jsonl', { text: lines([record]), mtimeMs: 5 })
  world.disk.set('/w2/.coherence/traces/a2c2c2c2c2c2c2c2c.jsonl', { text: '{"kind":"write","at":"2026-10-12T12:04:00.000Z","files":["src/w2.ts"]}\n', mtimeMs: 5 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal' } as never)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('the worktree agent decided')
  expect(drawn).toContain(' · a2c2c2c2')
  expect(drawn).toContain('w2.ts ✎')
  expect(drawn).toContain('2 sessions · 2 worktrees')
  await pane.unmount()
})

test('a packed line of two records shows both, and a damaged line is counted in the title, never dropped unsaid', async ($, on) => {
  const world = engine(on)
  const one = { id: 'd-1e1e1e01', kind: 'decision', at: '2026-10-12T12:10:00.000Z', session: OTHER, agent: 'packer', chose: 'the first packed record' }
  const two = { id: 'd-1e1e1e02', kind: 'decision', at: '2026-10-12T12:10:01.000Z', session: OTHER, agent: 'packer', chose: 'the second packed record' }
  world.disk.set(`/p/.coherence/journal/${OTHER}.p1.jsonl`, { text: `${JSON.stringify(one)}\u001e${JSON.stringify(two)}\n`, mtimeMs: 5 })
  world.disk.set('/p/.coherence/journal/broken.jsonl', { text: 'not a record at all\n', mtimeMs: 5 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal', session: 'live' } as never)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('the first packed record')
  expect(drawn).toContain('the second packed record')
  expect(drawn).toContain('1 damaged line skipped')
  expect(world.titles.at(-1)).toContain('1 damaged line skipped')
  await pane.unmount()
})

test('an unchanged look lists the folders and reads no file, runs no command, and a closed pane stops looking', async ($, on) => {
  const world = engine(on, ['/p', '/w2'])
  world.disk.set('/w2/.coherence/journal/other.jsonl', { text: lines([{ ...RECORDS[0]!, id: 'df-w2', session: OTHER }]), mtimeMs: 5 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  const pane = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__coherence__journal' } as never)
  const reads = world.reads.length
  const ran = world.ran.length
  const lists = world.lists.length
  await world.clock.advance(2000)
  await world.clock.advance(2000)
  expect(world.reads.length).toBe(reads)
  expect(world.ran.length).toBe(ran)
  expect(world.lists.length).toBeGreaterThan(lists)
  // The worktree list holds for 30 s, then git is asked again, and still nothing is read.
  await world.clock.advance(30_000)
  expect(world.ran.filter(r => r.argv.join(' ').startsWith('git worktree list')).length).toBe(2)
  expect(world.reads.length).toBe(reads)
  // Appended bytes alone are parsed: one more read, one more record.
  append(world.disk, '/w2/.coherence/journal/other.jsonl', lines([{ ...RECORDS[1]!, id: 'd-w2', session: OTHER }]))
  await world.clock.advance(2000)
  expect(world.reads.length).toBe(reads + 1)
  expect(JSON.stringify(await pane.drawn())).toContain('latest 5 of 5 records')
  world.pane.isOpen = false
  await world.clock.advance(2000)
  const closed = world.lists.length
  await world.clock.advance(10_000)
  expect(world.lists.length).toBe(closed)
  await pane.unmount()
})
