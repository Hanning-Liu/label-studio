// Run in an isolated development checkout with rebuilt web dependencies.
// Restores the sole changed source file even if a task fails.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "web");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const source = join(root, "hanning/README.md");
const original = readFileSync(source);
const cached = /\[local cache\]|\[existing outputs match the cache\]|read the output from the cache/i;
const report = [];
function run(args, name, environment) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["node_modules/nx/bin/nx.js", "run", ...args], {
    cwd: web,
    env: { ...process.env, NODE_ENV: environment, NX_DAEMON: "false", NX_TASKS_RUNNER_DYNAMIC_OUTPUT: "false" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const log = `${result.stdout || ""}\n${result.stderr || ""}`;
  writeFileSync(join(output, `${name}.log`), log);
  assert.equal(result.status, 0, `${name} failed; inspect its log`);
  const entry = { name, seconds: (Date.now() - started) / 1000, cacheHit: cached.test(log) };
  report.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}
try {
  for (const [name, args, environment] of [
    ["unit", ["editor:unit", "--testPathPatterns=boundary.test", "--runInBand"], "test"],
    ["build", ["labelstudio:build:production"], "production"],
  ]) {
    writeFileSync(source, original);
    run(args, `${name}-initial`, environment);
    assert.equal(run(args, `${name}-repeat`, environment).cacheHit, true, `${name} did not exercise a cache hit`);
    writeFileSync(source, Buffer.concat([original, Buffer.from(`\n<!-- isolated ${name} cache verification -->\n`)]));
    assert.equal(run(args, `${name}-custom-only-change`, environment).cacheHit, false, `${name} reused stale custom source`);
  }
} finally {
  writeFileSync(source, original);
  writeFileSync(join(output, "cache-verification.json"), `${JSON.stringify(report, null, 2)}\n`);
}
