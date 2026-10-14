/**
 * The warm server: started for a temporary project, queried twice over the
 * socket, and the second answer arrives from a server that was already warm.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { budget } from "./test-budgets.ts";
import { CODE_SALT_ENV, QUICK_REQUEST_MS, REQUEST_MS, codeFingerprint, connectAdapter, openLineClient, serve, serverPaths, type HttpAppFactory, type Serving } from "./server.ts";
import { performRun } from "./run.ts";
import { stopWarmServers } from "./server-fixture.ts";

let root: string;
let started: Promise<Serving> | undefined;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

/** The server, started by the first test that needs it: a filtered run that selects no test here starts nothing and waits on nothing. */
function warm(): Promise<Serving> {
  started ??= serve(root, { idleMs: 60_000 });
  return started;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "coherence-server-"));
  write("tsconfig.json", `{ "compilerOptions": { "strict": true, "noEmit": true, "module": "NodeNext", "moduleResolution": "NodeNext", "allowImportingTsExtensions": true }, "include": ["src/**/*.ts"] }\n`);
  write("src/door.ts", "const KEY = 1;\nexport function open(): number {\n  return KEY;\n}\n");
  write("src/hall.ts", 'import { open } from "./door.ts";\nexport const hall = open();\n');
});

after(async () => {
  if (started !== undefined) await (await started).stop();
  rmSync(root, { recursive: true, force: true });
});

test("the server listens on the project's socket and records a pointer", async () => {
  const serving = await warm();
  const paths = serverPaths(root);
  assert.ok(existsSync(paths.pointer), "server.json is written");
  assert.ok(existsSync(serving.paths.socket), "the socket exists");
});

test("two clients ask the same questions; the second finds the server warm", async () => {
  await warm();
  const first = await connectAdapter(root, { spawn: false });
  const ready = await first.adapter.ready();
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const hint = { component: ".", testFolders: ["__tests__"] };
  const key = await first.adapter.resolve("KEY", hint);
  assert.ok(key.ok, JSON.stringify(key));
  assert.equal(key.definition.file, "src/door.ts");
  const refs = await first.adapter.references(key.definition);
  assert.deepEqual(refs.map((r) => `${r.file}:${r.line} ${r.symbol}`), ["src/door.ts:3 open"]);
  const visibility = await first.adapter.visibility(key.definition);
  assert.equal(visibility.visible, false);
  await first.adapter.close();

  const second = await connectAdapter(root, { spawn: false });
  assert.equal(second.server, "warm");
  const status = await second.adapter.status();
  assert.equal(status.language, "typescript");
  assert.equal(status.ladder.top, "visibility-choked");
  const open = await second.adapter.resolve("open", hint);
  assert.ok(open.ok);
  const refutation = await second.adapter.refute(open.definition, undefined);
  assert.equal(refutation.seen, true, refutation.account);
  await second.adapter.close();
});

test("a client with spawning off fails plainly when nothing listens", async () => {
  const other = mkdtempSync(join(tmpdir(), "coherence-noserver-"));
  try {
    await assert.rejects(connectAdapter(other, { spawn: false }), /no warm server listening/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("the run keeps the instrument alive across the test pass, and a run whose instrument died exits non-zero with the reason", async (t) => {
  budget(t, 15, "d-4d6efcf9");
  // The totality pass runs the whole suite before the first question, and the warm server's idle timer only
  // resets on a request line. Reviewer A: a suite longer than the idle killed the instrument, every chokepoint
  // recorded not run, and the run exited 0.
  const other = mkdtempSync(join(tmpdir(), "coherence-idle-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(other, path)), { recursive: true });
    writeFileSync(join(other, path), text, "utf8");
  };
  put("tsconfig.json", `{ "compilerOptions": { "strict": true, "noEmit": true, "module": "NodeNext", "moduleResolution": "NodeNext", "allowImportingTsExtensions": true }, "include": ["src/**/*.ts"] }\n`);
  put("src/door.ts", "const KEY = 1;\nexport function open(): number {\n  return KEY;\n}\n");
  // A runner that holds the floor for longer than the server's idle timeout, then writes a passing report.
  const slow = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ testResults: [{ assertionResults: [{ ancestorTitles: [], title: "door holds", fullName: "door holds", status: "passed" }] }] })), 2500);';
  put("coherence.config.json", JSON.stringify({ language: "typescript", testDir: "__tests__", testJson: ["node", "-e", slow, "{out}", "{filter}"] }));
  put(
    "Idle.spec.md",
    ["# Idle", "", "One door.", "", "## invariants", "- key held: The key is read through open.", "  protects: KEY", "  chokepoint: open", "  over: every read of the key", "  via: door holds", "  because: one door", "  kinds: none", ""].join("\n"),
  );

  const idle = await serve(other, { idleMs: 1_200 });
  try {
    // No heartbeat: the instrument is gone by the time the first chokepoint is asked.
    const died = await performRun(other, { session: "idle-1", agent: "server", heartbeatMs: 10 * 60 * 1000 });
    const chokepoint = died.record.invariants.find((e) => e.form === "chokepoint")!;
    assert.equal(chokepoint.verdict, "not run");
    assert.equal(died.instrumentDied, true, "a run that proved nothing says so");
    assert.match(died.instrumentReason ?? "", /did not survive the test pass/);
    assert.match(chokepoint.reason, /instrument unavailable/);
  } finally {
    await idle.stop();
  }

  const alive = await serve(other, { idleMs: 1_200 });
  try {
    // The heartbeat keeps the instrument's idle timer awake while the runner holds the floor.
    const kept = await performRun(other, { session: "idle-2", agent: "server", heartbeatMs: 400 });
    const chokepoint = kept.record.invariants.find((e) => e.form === "chokepoint")!;
    assert.equal(kept.instrumentDied, false, kept.instrumentReason ?? "");
    assert.equal(chokepoint.verdict, "pass", chokepoint.reason);
    assert.equal(chokepoint.grade, "visibility-choked", chokepoint.reason);
    assert.equal(kept.record.invariants.find((e) => e.form === "totality oracle")!.verdict, "pass");
  } finally {
    await alive.stop();
    rmSync(other, { recursive: true, force: true });
  }
});

/* ------------------------------------------- one server per root, current code */

const SERVER_TS = new URL("./server.ts", import.meta.url).href;

/** A throwaway TypeScript project the warm server can load. */
function project(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), `{ "compilerOptions": { "strict": true, "noEmit": true, "module": "NodeNext", "moduleResolution": "NodeNext", "allowImportingTsExtensions": true }, "include": ["src/**/*.ts"] }\n`, "utf8");
  writeFileSync(join(dir, "src/door.ts"), "const KEY = 1;\nexport function open(): number {\n  return KEY;\n}\n", "utf8");
  return dir;
}

/** The pids of every `serve` process started for this root, read from the process table. */
function servePids(dir: string): number[] {
  const marker = `--root ${realpathSync(dir)}`;
  const table = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  return table
    .split("\n")
    .filter((line) => line.includes("cli.ts serve") && (line.endsWith(marker) || line.includes(`${marker} `)))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return condition();
}

/** Stop every server this test started for the root, politely and then by signal. */
async function stopAll(dir: string): Promise<void> {
  try {
    const connected = await connectAdapter(dir, { spawn: false });
    await connected.adapter.stopServer();
    await connected.adapter.close();
  } catch {
    // Nothing listening, or a server running other code than this client, which refuses to stop it.
  }
  // What is left gets SIGTERM, its clean shutdown, before a kill, and a killed server's socket is removed.
  await stopWarmServers(dir);
}

/** One client in its own process: connects (spawning when nothing listens) and prints the pid that answered. */
function clientProcess(dir: string): Promise<{ pid: number; server: string }> {
  const script = `import { connectAdapter } from ${JSON.stringify(SERVER_TS)};\nconst c = await connectAdapter(process.argv[1], { idleMs: 60_000 });\nconst s = await c.adapter.status();\nconsole.log(JSON.stringify({ pid: s.pid, server: c.server }));\nawait c.adapter.close();\n`;
  return new Promise((answered, reject) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, dir], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${error.message}\n${stderr}`));
      else answered(JSON.parse(stdout.trim()) as { pid: number; server: string });
    });
  });
}

test("ten concurrent clients for one root are served by exactly one server process", async () => {
  const dir = project("coherence-race-");
  try {
    const answers = await Promise.all(Array.from({ length: 10 }, () => clientProcess(dir)));
    const pids = new Set(answers.map((a) => a.pid));
    assert.equal(pids.size, 1, `every client is answered by one server: ${[...pids].join(", ")}`);
    // A client that lost the race waited for the winner; none spawned a second server that lingers.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(servePids(dir), [...pids], "exactly one serve process runs for the root");
  } finally {
    await stopAll(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock whose owner is dead is reclaimed by the next client", async () => {
  const dir = project("coherence-deadowner-");
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    assert.equal(running(dead), false);
    const paths = serverPaths(dir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, JSON.stringify({ pid: dead, at: new Date().toISOString() }) + "\n", "utf8");
    const connected = await connectAdapter(dir, { idleMs: 60_000 });
    const status = await connected.adapter.status();
    await connected.adapter.close();
    assert.notEqual(status.pid, dead);
    assert.equal((JSON.parse(readFileSync(paths.lock, "utf8")) as { pid: number }).pid, status.pid, "the lock names the new owner");
  } finally {
    await stopAll(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve refuses a root a live server holds and never unlinks that server's socket", async () => {
  const dir = project("coherence-owner-");
  const first = await serve(dir, { idleMs: 60_000 });
  try {
    await assert.rejects(serve(dir, { idleMs: 60_000 }), /holds this root/);
    // A serve process of its own is refused the same way, and exits rather than lingering.
    const cli = new URL("../cli.ts", import.meta.url).pathname;
    const other = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "serve", "--root", dir], { encoding: "utf8", timeout: 30_000 });
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, /holds this root/);
    assert.ok(existsSync(first.paths.socket), "the owner's socket is still there");
    const connected = await connectAdapter(dir, { spawn: false });
    assert.equal((await connected.adapter.status()).pid, process.pid);
    await connected.adapter.close();
  } finally {
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server running other code is replaced by a fresh process", async () => {
  const dir = project("coherence-stale-");
  const saved = process.env[CODE_SALT_ENV];
  try {
    process.env[CODE_SALT_ENV] = "before the edit";
    const old = await connectAdapter(dir, { idleMs: 60_000 });
    const oldStatus = await old.adapter.status();
    await old.adapter.close();
    assert.equal(oldStatus.fingerprint, codeFingerprint());

    process.env[CODE_SALT_ENV] = "after the edit";
    const fresh = await connectAdapter(dir, { idleMs: 60_000 });
    const freshStatus = await fresh.adapter.status();
    await fresh.adapter.close();
    assert.notEqual(freshStatus.pid, oldStatus.pid, "a new process answers");
    assert.equal(freshStatus.fingerprint, codeFingerprint(), "the new process runs the client's code");
    assert.equal(fresh.server, "cold");
    assert.ok(await until(() => !running(oldStatus.pid), 5_000), "the stale server exited");
  } finally {
    if (saved === undefined) delete process.env[CODE_SALT_ENV];
    else process.env[CODE_SALT_ENV] = saved;
    await stopAll(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server whose root is deleted exits", async () => {
  const dir = project("coherence-gone-");
  const serving = await serve(dir, { idleMs: 60_000, checkMs: 100 });
  let exited = false;
  void serving.done.then(() => (exited = true));
  rmSync(dir, { recursive: true, force: true });
  const gone = await until(() => exited, 5_000);
  if (!gone) await serving.stop();
  // A server that lost its root leaves the socket to a next owner; one too long for the root lives in the temp folder.
  rmSync(serving.paths.socket, { force: true });
  assert.ok(gone, "the server shut down once its root was removed");
});

/* ------------------------------------------- authenticated socket, bounded waits, guarded HTTP */

/** The token the pointer carries, as a client reads it. */
function pointerToken(dir: string): string {
  return (JSON.parse(readFileSync(serverPaths(dir).pointer, "utf8")) as { token: string }).token;
}

/** Send one raw line on the socket and read what comes back until the server closes the connection or 3 s pass. */
function rawLine(socketPath: string, line: string): Promise<{ answer: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let answer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ answer, closed: false });
    }, 3_000);
    socket.on("data", (chunk) => (answer += chunk.toString("utf8")));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ answer, closed: true });
    });
    // A refused connection is ended by the server; this side's own end can then meet the closed peer as EPIPE or
    // ECONNRESET, which is the close the test asks for, not a failure of it.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") reject(error);
    });
    socket.on("connect", () => socket.write(line + "\n"));
  });
}

test("a socket client without the root's token is refused, and the token lives only in files this user can read", async () => {
  const dir = project("coherence-auth-");
  const serving = await serve(dir, { idleMs: 60_000 });
  try {
    const paths = serverPaths(dir);
    for (const file of [paths.pointer, paths.http, serving.paths.socket]) {
      assert.equal(statSync(file).mode & 0o777, 0o600, `${file} is readable and writable by this user alone`);
    }
    const token = pointerToken(dir);
    assert.match(token, /^[0-9a-f]{64}$/, "the token is 32 random bytes");
    const bare = await rawLine(serving.paths.socket, JSON.stringify({ id: 1, method: "status", params: [] }));
    assert.match(bare.answer, /unauthenticated/, "a line without the token is refused");
    assert.doesNotMatch(bare.answer, /"result"/, "and answered nothing");
    assert.equal(bare.closed, true, "and its connection closed");
    const wrong = await rawLine(serving.paths.socket, JSON.stringify({ id: 1, method: "status", params: [], token: "0".repeat(64) }));
    assert.match(wrong.answer, /unauthenticated/, "a wrong token is refused");
    const client = await openLineClient(serving.paths.socket, token);
    const status = await client.request<{ pid: number }>("status");
    assert.equal(status.pid, process.pid, "the token from the pointer is accepted");
    client.end();
    const connected = await connectAdapter(dir, { spawn: false });
    assert.equal((await connected.adapter.status()).pid, process.pid, "connectAdapter reads the token from the pointer");
    await connected.adapter.close();
  } finally {
    await serving.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client request the server never answers fails after its timeout, naming the method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coherence-mute-"));
  const path = join(dir, "mute.sock");
  const held: Socket[] = [];
  const mute = createServer((socket) => void held.push(socket));
  await new Promise<void>((r) => mute.listen(path, () => r()));
  try {
    const client = await openLineClient(path, "token");
    const started = Date.now();
    const outcome = await Promise.race([
      client.request("status", [], 300).then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((r) => setTimeout(() => r("still waiting after 3 s"), 3_000).unref()),
    ]);
    assert.match(outcome, /did not answer status within 0.3 s/, "the request failed at its timeout, naming the method");
    assert.ok(Date.now() - started < 2_000, "the client gave up at its timeout");
    client.end();
    assert.ok(QUICK_REQUEST_MS > 0 && QUICK_REQUEST_MS <= 30_000, "a quick question waits seconds, not forever");
    assert.ok(Number.isFinite(REQUEST_MS), "an instrument question waits a bounded time");
  } finally {
    for (const socket of held) socket.destroy();
    mute.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTP request with any headers (fetch will not set Host), to the loopback port. */
function ask(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A stand-in reading: answers every admitted request with ok, and records it. */
function stubApp(seen: string[]): HttpAppFactory {
  return () => ({
    handle(request, response, url) {
      seen.push(`${request.method ?? ""} ${url.pathname}`);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    },
    close() {},
  });
}

function refusedConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

test("HTTP answers on loopback alone and refuses a request without the token, addressed to another server or sent from another site, or not a GET, and sends no CORS header", async () => {
  const dir = project("coherence-http-");
  const seen: string[] = [];
  const serving = await serve(dir, { idleMs: 60_000, http: stubApp(seen) });
  try {
    const connected = await connectAdapter(dir, { spawn: false });
    const { port, url } = await connected.adapter.openHttp();
    await connected.adapter.close();
    const token = pointerToken(dir);
    assert.equal(new URL(url).hostname, "127.0.0.1", "the address the launcher opens is loopback");
    assert.equal(new URL(url).searchParams.get("token"), token, "and carries the root's token");
    assert.equal((JSON.parse(readFileSync(serverPaths(dir).http, "utf8")) as { port: number }).port, port, "the port is recorded beside the pointer");
    // Loopback alone: nothing answers on IPv6 loopback or on any other interface of this machine.
    assert.equal(await refusedConnection("::1", port), true, "nothing listens on ::1");
    for (const address of Object.values(networkInterfaces()).flat()) {
      if (address === undefined || address.internal || address.family !== "IPv4") continue;
      assert.equal(await refusedConnection(address.address, port), true, `nothing listens on ${address.address}`);
    }
    const bearer = { authorization: `Bearer ${token}` };
    const own = `127.0.0.1:${port}`;
    const cases: { name: string; path: string; method?: string; headers: Record<string, string>; status: number }[] = [
      { name: "the page with its token", path: `/?token=${token}`, headers: { host: own }, status: 200 },
      { name: "the page by localhost", path: `/?token=${token}`, headers: { host: `localhost:${port}` }, status: 200 },
      { name: "an API path with the token as a header", path: "/api/state", headers: { host: own, ...bearer }, status: 200 },
      { name: "the page without a token", path: "/", headers: { host: own }, status: 401 },
      { name: "the page with a wrong token", path: `/?token=${"0".repeat(64)}`, headers: { host: own }, status: 401 },
      { name: "an API path with the token in the query", path: `/api/state?token=${token}`, headers: { host: own }, status: 401 },
      { name: "an API path with a wrong bearer", path: "/api/state", headers: { host: own, authorization: `Bearer ${"1".repeat(64)}` }, status: 401 },
      { name: "a foreign Host (DNS rebinding)", path: `/?token=${token}`, headers: { host: `attacker.example:${port}`, ...bearer }, status: 421 },
      { name: "loopback on another port", path: `/?token=${token}`, headers: { host: `127.0.0.1:${port + 1}` }, status: 421 },
      { name: "a foreign Origin", path: "/api/state", headers: { host: own, origin: "http://attacker.example", ...bearer }, status: 403 },
      { name: "a cross-site fetch", path: "/api/state", headers: { host: own, "sec-fetch-site": "cross-site", ...bearer }, status: 403 },
      { name: "this server's own Origin", path: "/api/state", headers: { host: own, origin: `http://${own}`, ...bearer }, status: 200 },
      { name: "a POST", path: "/api/state", method: "POST", headers: { host: own, origin: `http://${own}`, ...bearer }, status: 405 },
      { name: "a PUT", path: "/api/state", method: "PUT", headers: { host: own, ...bearer }, status: 405 },
      { name: "a DELETE", path: "/api/state", method: "DELETE", headers: { host: own, ...bearer }, status: 405 },
      { name: "a CORS preflight", path: "/api/state", method: "OPTIONS", headers: { host: own, origin: "http://attacker.example", "access-control-request-method": "GET" }, status: 405 },
    ];
    for (const c of cases) {
      const answer = await ask(port, c.path, { method: c.method ?? "GET", headers: c.headers });
      assert.equal(answer.status, c.status, `${c.name}: ${answer.status} ${answer.body}`);
      const cors = Object.keys(answer.headers).filter((name) => name.toLowerCase().startsWith("access-control-"));
      assert.deepEqual(cors, [], `${c.name}: no CORS header`);
      assert.equal(answer.headers["cache-control"], "no-store", `${c.name}: nothing is cached`);
    }
    assert.deepEqual(seen, ["GET /", "GET /", "GET /api/state", "GET /api/state"], "the reading saw only the requests the guard admitted");
  } finally {
    await serving.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an HTTP client that never finishes its headers is cut off", async () => {
  const dir = project("coherence-slow-");
  const serving = await serve(dir, { idleMs: 60_000, http: stubApp([]), httpHeadersMs: 500 });
  try {
    const connected = await connectAdapter(dir, { spawn: false });
    const { port } = await connected.adapter.openHttp();
    await connected.adapter.close();
    const started = Date.now();
    const outcome = await new Promise<{ closed: boolean; answer: string }>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let answer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ closed: false, answer });
      }, 5_000);
      socket.on("data", (chunk) => (answer += chunk.toString("utf8")));
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ closed: true, answer });
      });
      socket.on("error", () => {});
      // A request line and one header, then nothing: a slow client holding a connection open.
      socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`));
    });
    const took = Date.now() - started;
    assert.equal(outcome.closed, true, "the server closed the connection");
    assert.ok(took < 4_000, `within its header timeout (${took} ms)`);
    assert.doesNotMatch(outcome.answer, /200 OK/, "and answered nothing but the timeout");
  } finally {
    await serving.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
