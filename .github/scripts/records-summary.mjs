// What a pull request's Coherence records hold, as markdown: the journal
// records and runs it adds, by kind, with each decision, defect, escalation and
// retraction named in one line. CI writes it to the job summary, since the
// records themselves are folded in the diff (.gitattributes). The stores it
// reads are the table in src/journal/stores.ts, imported through node's type
// stripping, so a store added there is summarized here too.
//
//   node .github/scripts/records-summary.mjs <base> <head>
import { execFileSync } from "node:child_process";
import { STORES, STORE_NAMES, recordTexts } from "../../src/journal/stores.ts";

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error("usage: records-summary.mjs <base> <head>");
  process.exit(64);
}
const folders = STORE_NAMES.map((store) => `.coherence/${STORES[store].folder}`);
const diff = execFileSync("git", ["diff", "--no-color", "--unified=0", `${base}...${head}`, "--", ...folders], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const added = Object.fromEntries(STORE_NAMES.map((store) => [store, []]));
let area;
let bytes = 0;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    area = STORE_NAMES.find((store) => line.startsWith(`+++ b/.coherence/${STORES[store].folder}/`));
    continue;
  }
  if (!line.startsWith("+") || area === undefined) continue;
  bytes += line.length;
  // A packed shard's one line holds every record it has, each ended by the record separator.
  for (const text of recordTexts(line.slice(1))) {
    if (text.trim() === "") continue;
    try {
      added[area].push(JSON.parse(text));
    } catch {
      // A text that is not one record (a torn write) is counted by bytes alone.
    }
  }
}

const count = (items, key) => Object.entries(items.reduce((acc, r) => ((acc[key(r)] = (acc[key(r)] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]);
const out = [];
const total = STORE_NAMES.reduce((sum, store) => sum + added[store].length, 0);
out.push(`### Coherence records in this pull request`);
if (total === 0) {
  out.push("", "None.");
} else {
  out.push("", `${total} records, ${(bytes / 1024).toFixed(0)} KB.`);
  const kinds = (records) => count(records, (r) => r.kind ?? "?").map(([k, n]) => `${n} ${k}`).join(", ");
  // How each store's records read; a store with no section of its own is counted by kind, never left out.
  const sections = {
    journal: (records) => {
      const lines = ["", `**Journal**: ${kinds(records)}`];
      const named = records.filter((r) => ["decision", "defect", "escalation", "retraction"].includes(r.kind));
      for (const r of named.slice(0, 25)) {
        const text = String(r.chose ?? r.what ?? r.question ?? r.because ?? "").replace(/\s+/g, " ");
        lines.push(`- \`${r.id}\` ${r.kind}${r.class ? ` (${r.class})` : ""}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`);
      }
      if (named.length > 25) lines.push(`- and ${named.length - 25} more`);
      return lines;
    },
    runs: (records) => {
      const runs = records.filter((r) => Array.isArray(r.invariants));
      const refutations = records.filter((r) => r.kind === "refutation");
      const verdicts = count(runs.flatMap((r) => r.invariants), (e) => e.verdict ?? "?").map(([k, n]) => `${n} ${k}`).join(", ");
      const lines = ["", `**Runs**: ${runs.length} runs (${verdicts || "no entries"})${refutations.length ? `, ${refutations.length} refutations` : ""}`];
      // A refutation's red is on purpose; what a reviewer needs is the verdict each enforcement is left with.
      const latest = new Map();
      for (const r of [...runs].sort((x, y) => String(x.at).localeCompare(String(y.at)))) for (const e of r.invariants) latest.set(`${e.component}/${e.name} (${e.form})`, e.verdict);
      const left = [...latest].filter(([, v]) => v !== "pass").map(([k, v]) => `${k}: ${v}`);
      lines.push(left.length ? `- left not passing by this pull request's latest runs: ${left.slice(0, 15).join("; ")}${left.length > 15 ? `; and ${left.length - 15} more` : ""}` : `- every enforcement these runs checked is left passing`);
      return lines;
    },
    work: (records) => ["", `**Work orders**: ${kinds(records)}`],
  };
  for (const store of STORE_NAMES.filter((s) => added[s].length > 0)) {
    out.push(...(sections[store] ?? ((records) => ["", `**${store}**: ${kinds(records)}`]))(added[store]));
  }
}
console.log(out.join("\n"));
