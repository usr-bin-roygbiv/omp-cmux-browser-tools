import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with status ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const pkg = readJson("package.json");
const claudePlugin = readJson(".claude-plugin/plugin.json");

if (claudePlugin.name !== pkg.name) {
  fail(`.claude-plugin/plugin.json name ${claudePlugin.name} does not match package ${pkg.name}`);
}
if (claudePlugin.version !== pkg.version) {
  fail(`.claude-plugin/plugin.json version ${claudePlugin.version} does not match package ${pkg.version}`);
}
if (claudePlugin.description !== pkg.description) {
  fail(".claude-plugin/plugin.json description does not match package.json description");
}
if (claudePlugin.homepage !== pkg.homepage.replace(/#readme$/, "")) {
  fail(".claude-plugin/plugin.json homepage does not match package.json homepage");
}
if (claudePlugin.repository !== pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")) {
  fail(".claude-plugin/plugin.json repository does not match package.json repository");
}

for (const field of ["name", "version", "description", "license", "exports", "files", "omp", "pi"]) {
  if (pkg[field] == null) fail(`package.json is missing ${field}`);
}
for (const version of Object.values(pkg.peerDependencies ?? {})) {
  if (typeof version !== "string" || !/^>=15\.5\.15 <16$/.test(version)) {
    fail(`unexpected peer dependency range: ${version}`);
  }
}

const packJson = run("npm", ["pack", "--dry-run", "--json"]);
const pack = JSON.parse(packJson)[0];
const files = new Set(pack.files.map((entry) => entry.path));
const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "extensions/index.ts",
  "tools/cmux-browser-tools/index.ts",
  "scripts/precommit.mjs",
  "scripts/check-package.mjs",
  "scripts/run-interactive-cmux-tools-smoke.mjs",
  "scripts/run-cmux-browsergym-eval.mjs",
  "evals/browsergym-action-space/tasks.json",
  "evals/browsergym-action-space/fixture.html",
  "smoke/test-page.html",
  ".claude-plugin/plugin.json",
  ".githooks/pre-commit",
];
for (const path of requiredFiles) {
  if (!files.has(path)) fail(`npm pack output is missing ${path}`);
}
for (const path of files) {
  if (path.startsWith("_artifacts") || path.includes("node_modules") || path.endsWith(".log") || basename(path) === ".DS_Store") {
    fail(`npm pack output includes forbidden runtime artifact ${path}`);
  }
}

console.log(`package check passed: ${pack.name}@${pack.version} with ${pack.files.length} files (${pack.unpackedSize} bytes unpacked)`);
