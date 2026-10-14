#!/usr/bin/env node
/**
 * The command line: `node src/cli.ts <verb> ...`.
 *
 * Each area of the tool exports its verbs; this file dispatches on the first
 * word. The journal's verbs arrive as a record of synchronous commands over an
 * `Io`; the lifecycle's verbs are dispatched below them.
 *
 *   coherence lexicon                 print the compact lexicon the hook injects
 *   coherence lexicon --json          print the parsed lexicon model
 *   coherence lexicon --check [paths] run the lexicon check (--json for the report as JSON)
 *   coherence spec --check [root]      every component, its invariants with state, every problem
 *   coherence spec --json [root]       the spec model
 *   coherence scaffold component | invariant   the complete shape, cheapest to produce
 *   coherence run [--session --agent]  the chokepoint check and the totality oracle pass, appended as one run
 *   coherence run --status             the latest verdict per enforcement, a view over every run
 *   coherence refute <component>/<name> --broke "<what you changed>"   the totality oracle with the break staged; it must fail
 *   coherence serve                    the warm language server for this project
 *   coherence query <question> ...     the agent query: what Scope shows a human, as plain text
 *   coherence scope [--no-open]        open the live Scope reading from the warm server; --snapshot [--out <file>] writes one file
 *   coherence hook <event>             answer one harness event (event JSON on stdin)
 *   coherence hook-serve [--socket]    the warm hook process: answer events as JSON lines on stdin, and over a Unix socket (hook-serve.ts)
 *   coherence hooks install --host <host>           merge one entry per event into the agent host's settings
 *   coherence hooks uninstall --host <host>         remove exactly those entries; every other hook stays
 *   coherence hooks --check --host <host>           exit 1 with each event's drift from what install would write
 *   coherence hooks status             the wiring per agent host and what each event delivers for this project
 *   coherence ci install --host github --mode fail|comment [--write]   the workflow that runs Coherence on every pull request (ci.ts)
 *   coherence ci report --session <id>   the pull request report as Markdown (ci-report.ts)
 *   coherence telemetry on | off | status | show | reset-id   opt-in fleet telemetry (telemetry.ts)
 *   coherence version (--version, -v)  the running version, where it is, and the newest published one (version.ts)
 *   coherence help (--help, -h)        this usage, on stdout
 *   coherence decide | retract | conjecture | ... | journal   (see JOURNAL_USAGE)
 *   coherence work create | move | close | owner | inspect   (see WORK_USAGE)
 *
 * Exit codes: the check exits 1 with findings and 0 without; a hook exits 2
 * to refuse a stop, with the reason on stderr.
 */

// First, before any other module loads: every spawn this process makes is counted from here on (lifecycle/work-meter.ts).
import "./lifecycle/work-meter.ts";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEXICON_WORK_USAGE, lexiconWorkCommand } from "./lifecycle/lexicon-cli.ts";
import { ECONOMY_USAGE, calibrateCommand, economyCommand, massCommand } from "./economy/cli.ts";
import { ENFORCEMENT_USAGE, refuteCommand, runCommand, serveCommand } from "./enforcement/cli.ts";
import { warmInstrument } from "./enforcement/run.ts";
import { JOURNAL_USAGE, journalVerbs, type Io } from "./journal/cli.ts";
import { formatReport, hasFindings, recordVetter, runCheck } from "./lifecycle/check.ts";
import { renderCompact, renderCompactWithin, tokenEstimate } from "./lifecycle/lexicon.ts";
import { cliName, CONTEXT_BUDGET, isHookEvent, HOOK_EVENTS, MIRROR_REFRESH, readStdinJson, runHook, STRUCTURE_REFRESH, WARM_UP } from "./lifecycle/hook.ts";
import { deliveries, formatDeliveries } from "./lifecycle/delivery.ts";
import { runHookServe } from "./lifecycle/hook-serve.ts";
import { check, formatCheck, formatStatus, formatUninstall, HOSTS, install, isHost, locatedPrefix, locate, settingsFile, settingsRoots, status, uninstall, type SettingsRoot } from "./lifecycle/install.ts";
import { isCoherenceItself, loadProjectLexicons, PACKAGE_NAME, projectRoot } from "./lifecycle/project.ts";
import { QUERY_USAGE, queryCommand } from "./readings/query/cli.ts";
import { SCOPE_USAGE, scopeCommand } from "./readings/scope/cli.ts";
import { scopeApp } from "./readings/scope/live.ts";
import { SCAFFOLD_USAGE, scaffoldCommand } from "./scaffold/cli.ts";
import { CONFORM_USAGE, conformCommand } from "./conformance/cli.ts";
import { SPEC_USAGE, specCommand } from "./spec/cli.ts";
import { nestedFolder, repositoryTop } from "./adapters/project-files.ts";
import { keepAttributes, keepIgnore } from "./lifecycle/state-files.ts";
import { installMod, modInstalled, ownModLinked, uninstallMod, MOD_ID, MOD_REPOSITORY, OWN_MOD_LINK, type ModStep } from "./lifecycle/mod-install.ts";
import { registryOf } from "./adapters/project-config.ts";
import { adopt, AdoptError, adoptText } from "./lifecycle/adopt.ts";
import { TELEMETRY_USAGE, telemetryCommand } from "./lifecycle/telemetry-cli.ts";
import { CI_USAGE, ciInstallCommand, ciSuggestion } from "./lifecycle/ci.ts";
import { ciReportCommand } from "./lifecycle/ci-report.ts";
import { startTelemetry } from "./lifecycle/telemetry.ts";
import { reachNote, refreshLatest, startUpdateCheck, versionText } from "./lifecycle/version.ts";

type CommandResult = number | Promise<number>;
type RootCommand = (argv: string[], io: Io) => CommandResult;

const commands: Record<string, RootCommand> = { ...journalVerbs, spec: specCommand, scaffold: scaffoldCommand };

const USAGE = `usage:
${LEXICON_WORK_USAGE}
  coherence lexicon [--json]
  coherence lexicon --check [--json] [paths...]
${SPEC_USAGE}
${SCAFFOLD_USAGE}
${ENFORCEMENT_USAGE}
${CONFORM_USAGE}
${ECONOMY_USAGE}
${QUERY_USAGE}
${SCOPE_USAGE}
  coherence adopt <folder>   list the folder in the registry (projects in coherence.config.json at the repository top), creating it when absent
  coherence hook <${HOOK_EVENTS.join("|")}>
  coherence hook-serve [--socket]   the warm hook process: {"op":"hook","event":...,"input":...} per line on stdin; --socket also over HTTP on a Unix socket
  coherence hooks install --host <${HOSTS.join("|")}> [--command "<prefix>"] [--local]   --local: the host's personal settings (.claude/settings.local.json), never committed
  coherence hooks install --host claude --mod [--shared]   Claude Code only: Coherence's mod answers every event through one warm process per session, in place of your personal settings hooks; --shared: for the whole team, in the committed settings, in place of the committed hooks
  coherence hooks uninstall --host <${HOSTS.join("|")}>   removes the mod too
  coherence hooks --check --host <${HOSTS.join("|")}> [--command "<prefix>"] [--local]
  coherence hooks status
${CI_USAGE}
${TELEMETRY_USAGE}
  coherence version   (or --version, -v) the running version and where it is, the newest published one, and when the registry was last asked
  coherence help      (or --help, -h) this usage
${JOURNAL_USAGE}
`;

function fail(message: string, code = 64): never {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(code);
}

interface Parsed {
  flags: Map<string, string | true>;
  positionals: string[];
}

/** `--flag`, `--flag value`, `--flag=value`, and positionals, in any order. */
function parse(args: string[], valued: Set<string>): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (valued.has(name) && i + 1 < args.length) {
      flags.set(name, args[++i]!);
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positionals };
}

/**
 * The command prefix a hook entry uses to reach this CLI. Paths are relative
 * to the project root, which is where both hosts run hooks; Claude Code also
 * names it in CLAUDE_PROJECT_DIR, honored when set. Coherence's own checkout
 * runs its own source; an adopter's hook locates Coherence outside the
 * project and fails softly when it is not there (LOCATED_PREFIX), never
 * through npx, which would fetch a stranger's package of the same name.
 */
async function defaultCommand(root: string, sub = "", local = false): Promise<string> {
  const personal = local ? ' && [ ! -f "$dir/.claude/settings.local.json" ]' : "";
  const dir = `$(dir="\${CLAUDE_PROJECT_DIR:-$PWD}"; while [ "$dir" != "/" ] && [ ! -f "$dir/.claude/settings.json" ]${personal} && [ ! -f "$dir/.codex/hooks.json" ]; do dir=$(dirname "$dir"); done; printf "%s" "$dir")`;
  return (await isCoherenceItself(root)) ? `node "${dir}/src/cli.ts"` : locatedPrefix(sub, local);
}

/** The cli running this command, as the located command would name it once resolved: an installed package, a checkout, or Coherence's own source. */
const THIS_CLI = realpathSync(fileURLToPath(import.meta.url));

/** After an adopter's install: say which Coherence the hooks will find, named as the session start names it, or how to make them find it. */
function locateNote(root: string, sub = ""): string {
  const found = locate(root, process.env, sub);
  const reached = reachNote(root, found === undefined ? undefined : realpathSync(found), THIS_CLI);
  if (reached !== undefined) return reached;
  return (
    `note: the hooks cannot find Coherence from here; they run the project's installed ${PACKAGE_NAME}.\n` +
    `  Run npm install -D ${PACKAGE_NAME} (or pnpm add -D, yarn add -D) in the project, or its install if package.json already lists it. Until then each session start tells the agent it is missing, and the other events do nothing.\n`
  );
}

async function lexiconCommand(args: string[], root: string): Promise<number> {
  const io: Io = {
    cwd: root,
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
  if (args[0] === "--help") return lexiconWorkCommand(["help"], io);
  if (args[0] && !args[0].startsWith("--")) return lexiconWorkCommand(args, io);
  const { flags, positionals } = parse(args, new Set());
  const unknown = [...flags.keys()].find((flag) => flag !== "check" && flag !== "json");
  if (unknown !== undefined) {
    process.stderr.write(`lexicon: unknown flag --${unknown}\n`);
    return 1;
  }
  const { coherence, project } = await loadProjectLexicons(root);
  if (flags.has("check")) {
    const report = await runCheck({ root, paths: positionals, coherence, project });
    process.stdout.write(flags.has("json") ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
    return hasFindings(report) ? 1 : 0;
  }
  if (flags.has("json")) {
    process.stdout.write(JSON.stringify({ coherence, project: project ?? null }, null, 2) + "\n");
    return 0;
  }
  const compact = renderCompact(coherence, project);
  process.stdout.write(compact);
  const estimate = tokenEstimate(compact);
  let note = "";
  if (project !== undefined) {
    const within = renderCompactWithin(coherence, project, CONTEXT_BUDGET);
    if (within.detail !== "full") {
      note = `; the hook injects the project layer at detail "${within.detail}" (~${tokenEstimate(within.text).tokens} tokens) to stay under ${CONTEXT_BUDGET} characters`;
    }
  }
  process.stderr.write(`~${estimate.tokens} tokens (${estimate.bytes} bytes / 4)${note}\n`);
  return 0;
}

/** Write to stdout and settle only once the bytes were accepted, so what follows records an effect that happened. */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.once("error", reject);
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/** The exit code for output the host never received (sysexits EX_IOERR). */
const OUTPUT_LOST_EXIT = 74;

async function hookCommand(args: string[], root: string): Promise<number> {
  const event = args[0];
  if (event === undefined || !isHookEvent(event)) fail(`hook: expected one of ${HOOK_EVENTS.join(", ")}\n${USAGE}`);
  const input = await readStdinJson(process.stdin);
  const result = await runHook(event, input, root, { ...HOOK_STARTS, startedAt: Math.round(performance.timeOrigin) });
  if (result.stderr !== "") process.stderr.write(result.stderr);
  if (result.stdout !== "") {
    try {
      await writeStdout(result.stdout);
    } catch (error) {
      // The host has nothing, so nothing is committed: an unprinted feed is shown again next time.
      process.stderr.write(`hook ${event}: the output never reached the host (${error instanceof Error ? error.message : String(error)}); nothing was committed\n`);
      return OUTPUT_LOST_EXIT;
    }
  }
  result.commit?.();
  return result.exit;
}

/** hook-serve [--socket]: the warm hook process for one agent-host session; it runs until stdin closes (or, with a socket, its parent is gone). */
async function hookServeCommand(args: string[], root: string): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--socket");
  if (unknown.length > 0) fail(`hook-serve: unexpected ${unknown.join(" ")}\n${USAGE}`);
  const code = await runHookServe(root, { socket: args.includes("--socket"), hook: HOOK_STARTS });
  // Stdin and the socket hold the event loop open; the process is done once the server says so.
  process.exit(code);
}

/** The flags each hooks verb takes; anything else is a usage error rather than silently ignored. */
/**
 * What a hook starts in the background once its answer is made, given alike
 * to the per-event hook and to the warm hook process, so both paths start the
 * same work and keep the same records.
 */
const HOOK_STARTS = { refresh: STRUCTURE_REFRESH, warm: WARM_UP, telemetry: startTelemetry, updateCheck: startUpdateCheck, mirrors: MIRROR_REFRESH } as const;

const HOOKS_FLAGS: Record<string, ReadonlySet<string>> = {
  install: new Set(["host", "command", "local", "mod", "shared"]),
  uninstall: new Set(["host"]),
  check: new Set(["check", "host", "command", "local"]),
  status: new Set(),
};

/** adopt <folder>: one folder, relative to where the command runs; never the project root the other commands resolve to. */
async function adoptCommand(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("--")) fail(`adopt: one folder\n${USAGE}`);
  try {
    const adopted = adopt(process.cwd(), args[0]!);
    process.stdout.write(adoptText(adopted, await cliName(resolve(dirname(adopted.path), adopted.folder))));
    return 0;
  } catch (error) {
    if (!(error instanceof AdoptError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function hooksCommand(args: string[], root: string): Promise<number> {
  const { flags, positionals } = parse(args, new Set(["host", "command"]));
  // The check is the noun's --check, as lexicon --check and spec --check are; the other actions are verbs.
  const verb = flags.has("check") && positionals.length === 0 ? "check" : positionals[0];
  const allowed = verb === undefined ? undefined : HOOKS_FLAGS[verb];
  if (allowed === undefined || positionals.length > (verb === "check" ? 0 : 1)) fail(USAGE);
  const unknown = [...flags.keys()].filter((flag) => !allowed.has(flag));
  if (unknown.length > 0) fail(`hooks ${verb}: unknown flag${unknown.length === 1 ? "" : "s"} ${unknown.map((f) => `--${f}`).join(", ")}\n${USAGE}`);
  const local = flags.get("local") === true;
  // A project nested below its repository's top keeps its hooks at the top too, where a host launched at the repository root reads them.
  // Personal settings are one file at the repository top, which the host reads launched there or in any folder below.
  const shared = settingsRoots(root);
  const personal: SettingsRoot[] = [{ dir: repositoryTop(root) ?? root, sub: nestedFolder(root) ?? "" }];
  const places = local ? personal : shared;
  if (verb === "status") {
    const statuses = [
      ...(await Promise.all(shared.map((place) => Promise.all(HOSTS.map((host) => status(place.dir, host)))))).flat(),
      ...(await Promise.all(personal.map((place) => Promise.all(HOSTS.filter((host) => settingsFile(host, true) !== undefined).map((host) => status(place.dir, host, true)))))).flat(),
    ];
    const modLines = [...shared.filter((place) => modInstalled(place.dir, "project")).map(() => `claude: ${MOD_ID} enabled in the committed settings\n`), ...personal.filter((place) => modInstalled(place.dir)).map(() => `claude: ${MOD_ID} enabled in the personal settings\n`)].join("");
    process.stdout.write(formatStatus(statuses) + modLines + "\n" + formatDeliveries(await deliveries(root), statuses));
    return 0;
  }
  const host = flags.get("host");
  const label = verb === "check" ? "hooks --check" : `hooks ${verb}`;
  if (typeof host !== "string" || !isHost(host)) fail(`${label}: --host must be one of ${HOSTS.join(", ")}\n${USAGE}`);
  if (local && settingsFile(host, true) === undefined) fail(`${label} --local: ${host} keeps no personal settings file Coherence knows of; install without --local`);
  const given = flags.get("command");
  if (given === true) fail(`${label}: --command needs a value\n${USAGE}`);
  if (verb === "uninstall") {
    // The mod first: while it is installed, the files .coherence keeps for git stay, since a host still runs Coherence.
    if (host === "claude") {
      for (const place of shared) if (modInstalled(place.dir, "project")) process.stdout.write(modSteps(uninstallMod(place.dir, undefined, "project")));
      for (const place of personal) if (modInstalled(place.dir)) process.stdout.write(modSteps(uninstallMod(place.dir)));
    }
    // Ours leave both the shared and the personal settings, wherever install put them.
    for (const place of shared) process.stdout.write(formatUninstall(host, await uninstall(place.dir, host)));
    if (settingsFile(host, true) !== undefined) {
      for (const place of personal) {
        const result = await uninstall(place.dir, host, true);
        if (result.removed.length > 0 || result.removedIgnore) process.stdout.write(formatUninstall(host, result));
      }
    }
    return 0;
  }
  const commandAt = async (sub: string): Promise<string> => given ?? (await defaultCommand(root, sub, local));
  if (verb === "check") {
    let drifted = false;
    for (const place of places) {
      if (host === "claude" && !local && (await isCoherenceItself(place.dir))) {
        // Coherence's own repository runs the tree's own mod from its skills folder, in place of hooks and of an installed copy.
        const linked = ownModLinked(place.dir);
        const shadowed = modInstalled(place.dir) || modInstalled(place.dir, "project");
        process.stdout.write(!linked ? `claude: ${OWN_MOD_LINK} does not link this tree's mods/coherence, so no mod runs here\n` : shadowed ? `claude: ${MOD_ID} is installed for this repository and takes the name before ${OWN_MOD_LINK}, so the installed copy runs instead of this tree's mod; hooks uninstall --host claude removes it\n` : `claude: this tree's own mod runs from ${OWN_MOD_LINK} and reloads when a file of it is saved\n`);
        drifted ||= !linked || shadowed;
        continue;
      }
      if (host === "claude" && modInstalled(place.dir, local ? "local" : "project")) {
        // The mod answers every event in place of the settings hooks at this scope.
        process.stdout.write(local ? `claude: ${MOD_ID} is enabled in the personal settings and answers every event the committed hooks leave to it\n` : `claude: ${MOD_ID} is enabled in the committed settings and answers every event\n`);
        continue;
      }
      let result;
      try {
        result = await check(place.dir, host, await commandAt(place.sub), local);
      } catch (error) {
        process.stderr.write(`hooks --check: ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      }
      process.stdout.write(formatCheck(result));
      drifted ||= result.drift.length > 0;
    }
    return drifted ? 1 : 0;
  }
  if (flags.get("shared") === true && flags.get("mod") !== true) fail(`hooks install --shared: --shared applies to --mod alone\n${USAGE}`);
  if (flags.get("mod") === true && (await isCoherenceItself(root))) fail(`hooks install --mod: Coherence's own repository runs each tree's own mod from ${OWN_MOD_LINK}; an installed copy would take its name and run instead\n${USAGE}`);
  if (flags.get("mod") === true) return flags.get("shared") === true ? sharedModInstallCommand(root, host, shared, given !== undefined || local) : modInstallCommand(root, host, personal[0]!, shared, given !== undefined || local);
  for (const place of places) {
    const command = await commandAt(place.sub);
    const registry = registryOf(root);
    const result = await install({ root: place.dir, host, command, ignoreRoots: registry === undefined ? [root] : registry.leaves, local });
    process.stdout.write(`${result.changed ? "wrote" : "unchanged"} ${result.path}: ${result.events.join(", ")}\n`);
    if (command === locatedPrefix(place.sub, local)) process.stdout.write(locateNote(place.dir, place.sub));
  }
  // The pull request side: offered once, only while no workflow runs Coherence.
  process.stdout.write(await ciSuggestion(root));
  return 0;
}

/** Each `claude plugin` step, one line each, with what Claude Code said. */
function modSteps(steps: readonly ModStep[]): string {
  return steps.map((s) => `${s.args[0] === "plugin" ? "claude " : ""}${s.args.filter((a) => a !== "--json").join(" ")}: ${s.ok ? "" : "failed: "}${s.said}\n`).join("");
}

/**
 * hooks install --host claude --mod: Coherence's marketplace and its mod at
 * the personal scope, then Coherence's personal settings hooks out, since the
 * mod stands aside for every event a settings hook of Coherence's covers. The
 * committed hooks are the team's: kept, and named while they hold the mod back.
 */
async function modInstallCommand(root: string, host: string, personal: SettingsRoot, shared: readonly SettingsRoot[], flagged: boolean): Promise<number> {
  if (host !== "claude") fail(`hooks install --mod: the mod is Claude Code's; ${host} keeps its settings hooks\n${USAGE}`);
  if (flagged) fail(`hooks install --mod: the mod is always personal and finds Coherence itself; --local and --command do not apply\n${USAGE}`);
  const steps = installMod(personal.dir);
  process.stdout.write(modSteps(steps));
  if (!steps.every((s) => s.ok) || steps.length < 2) {
    process.stderr.write(`hooks install --mod: Claude Code did not install the mod; your settings hooks are unchanged\n`);
    return 1;
  }
  const removed = await uninstall(personal.dir, "claude", true);
  if (removed.removed.length > 0) process.stdout.write(formatUninstall("claude", removed));
  const registry = registryOf(root);
  for (const dir of registry === undefined ? [root] : registry.leaves) {
    keepIgnore(dir, true);
    keepAttributes(dir);
  }
  for (const place of shared) {
    const held = (await status(place.dir, "claude")).installed;
    if (held.length > 0) process.stdout.write(`claude: ${resolve(place.dir, settingsFile("claude")!)} still runs Coherence for ${[...new Set(held.map((h) => h.event))].join(", ")}; the mod answers none of those events while it does. Those hooks are committed and the team's: \`hooks uninstall --host claude\` removes them for everyone.\n`);
  }
  process.stdout.write(`The mod comes from ${MOD_REPOSITORY} and runs this project's own Coherence; it loads in Claude Code sessions started here from now on, and /reload-plugins loads it into one already running.\n`);
  return 0;
}

/**
 * hooks install --host claude --mod --shared: the mod for the whole team.
 * Coherence's marketplace and its mod in the committed settings, then the
 * committed Claude Code hooks of Coherence's out, which the mod replaces for
 * everyone; another host's hooks stay. A personal hook of Coherence's would
 * hold the mod back for its owner, so each is named.
 */
async function sharedModInstallCommand(root: string, host: string, shared: readonly SettingsRoot[], flagged: boolean): Promise<number> {
  if (host !== "claude") fail(`hooks install --mod --shared: the mod is Claude Code's; ${host} keeps its settings hooks\n${USAGE}`);
  if (flagged) fail(`hooks install --mod --shared: the mod finds Coherence itself; --local and --command do not apply\n${USAGE}`);
  for (const place of shared) {
    const steps = installMod(place.dir, undefined, "project");
    process.stdout.write(modSteps(steps));
    if (!steps.every((s) => s.ok) || steps.length < 2) {
      process.stderr.write(`hooks install --mod --shared: Claude Code did not install the mod in ${place.dir}; the committed hooks are unchanged\n`);
      return 1;
    }
    const removed = await uninstall(place.dir, "claude");
    if (removed.removed.length > 0) process.stdout.write(formatUninstall("claude", removed));
    const personalHeld = (await status(place.dir, "claude", true)).installed;
    if (personalHeld.length > 0) process.stdout.write(`claude: your personal settings still run Coherence for ${[...new Set(personalHeld.map((h) => h.event))].join(", ")}; the mod answers none of those events for you while they do: \`hooks uninstall --host claude\` removes them.\n`);
  }
  const registry = registryOf(root);
  for (const dir of registry === undefined ? [root] : registry.leaves) {
    keepIgnore(dir, true);
    keepAttributes(dir);
  }
  process.stdout.write(`The mod comes from ${MOD_REPOSITORY} and runs this project's own Coherence. Commit ${settingsFile("claude")}: Claude Code asks each teammate to install the marketplace and the mod when they next start a session here.\n`);
  return 0;
}

/** version: what runs and what is published; `--refresh` (which a session start runs detached) asks the registry first. */
async function versionCommand(args: string[], root: string): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--refresh");
  if (unknown.length > 0) fail(`version: unexpected ${unknown.join(" ")}\n${USAGE}`);
  if (args.includes("--refresh")) await refreshLatest();
  process.stdout.write(versionText(root, await isCoherenceItself(root)));
  return 0;
}

/** The journal's check before a write: a rejected name that binds here, named with what it was rejected for. */
async function journalVet(root: string): Promise<(record: object) => string[]> {
  const { coherence, project } = await loadProjectLexicons(root);
  const vet = await recordVetter(root, coherence, project);
  return (record) => vet(record).map((f) => `"${f.text}" is rejected for ${f.concept}: ${f.because}`);
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // Every command acts on the project, wherever in it the command was run.
  const root = projectRoot(process.cwd());
  const command = verb === undefined ? undefined : commands[verb];
  if (command !== undefined) {
    const io: Io = {
      cwd: root,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      ...(verb !== undefined && verb in journalVerbs ? { vet: await journalVet(root) } : {}),
    };
    return command(rest, io);
  }
  const io: Io = {
    cwd: root,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  switch (verb) {
    case "lexicon":
      return lexiconCommand(rest, root);
    case "run":
      return runCommand(rest, io);
    case "refute":
      return refuteCommand(rest, io);
    case "conform":
      return conformCommand(rest, io);
    case "warm":
      // Internal: the hook starts this detached so the instrument is loaded before the stop that needs it.
      await warmInstrument(root);
      return 0;
    case "serve":
      // The warm server answers the live Scope reading over HTTP besides the instrument over its socket.
      return serveCommand(rest, io, { http: scopeApp() });
    case "scope":
      return scopeCommand(rest, io);
    case "economy":
      return economyCommand(rest, io);
    case "calibrate":
      return calibrateCommand(rest, io);
    case "adopt":
      return adoptCommand(rest);
    case "mass":
      return massCommand(rest, io);
    case "query":
      return queryCommand(rest, io);
    case "hook":
      return hookCommand(rest, root);
    case "hook-serve":
      return hookServeCommand(rest, root);
    case "hooks":
      return hooksCommand(rest, root);
    case "telemetry":
      return telemetryCommand(rest, io);
    case "ci":
      if (rest[0] === "install") return ciInstallCommand(rest.slice(1), io);
      if (rest[0] === "report") return ciReportCommand(rest.slice(1), io);
      fail(`ci: install or report\n${CI_USAGE}`);
    case "version":
    case "--version":
    case "-v":
      return versionCommand(rest, root);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      fail(verb === undefined ? USAGE : `unknown verb "${verb}"\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    fail(error instanceof Error ? error.message : String(error), 70);
  },
);
