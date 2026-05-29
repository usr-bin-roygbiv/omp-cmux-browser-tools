import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCmuxBrowserToolSpecs } from "../extensions/index.ts";

const MODEL = process.env.CMUX_EVAL_MODEL || "gpt-proxy/gpt-5.5";
const PROVIDER_TOOL_NAMES = [
  "cmux_browser_snapshot",
  "cmux_browser_get",
  "cmux_browser_click",
  "cmux_browser_fill",
  "cmux_browser_screenshot",
];
const ALLOWED_TOOLS = PROVIDER_TOOL_NAMES;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repoWorkspaceRoot() {
  const cwd = process.cwd();
  return path.basename(cwd) === "omp-cmux-browser-tools" ? path.dirname(cwd) : cwd;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "model";
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseJsonEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // OMP JSON mode is expected to be line-delimited. Keep raw text as proof when a line is non-JSON.
    }
  }
  if (events.length === 0) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return [parsed];
    } catch {
      return [];
    }
  }
  return events;
}

const SURFACE_KEYS = ["surface", "surface_ref", "browser_surface_ref", "target_surface_ref", "openedSurface"];

function findSurface(value) {
  if (typeof value === "string") {
    const match = value.match(/surface:\d+/);
    return match?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSurface(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of SURFACE_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && /^surface:\d+$/.test(candidate)) return candidate;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("source_") || key === "caller" || key === "focused") continue;
      const found = findSurface(item);
      if (found) return found;
    }
  }
  return undefined;
}

function collectToolCalls(value, calls = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolCalls(item, calls);
    return calls;
  }
  if (!value || typeof value !== "object") return calls;

  const type = String(value.type ?? value.event ?? value.kind ?? "").toLowerCase();
  const candidate = value.toolName ?? value.tool_name ?? value.name ?? value.tool?.name ?? value.function?.name;
  const hasCallShape = Boolean(value.toolCallId ?? value.tool_call_id ?? value.callId ?? value.call_id ?? value.input ?? value.arguments ?? value.args);
  if (typeof candidate === "string" && candidate.startsWith("cmux_") && (type.includes("tool") || hasCallShape)) {
    calls.push({ name: candidate, type: type || undefined });
  }

  for (const item of Object.values(value)) collectToolCalls(item, calls);
  return calls;
}

function toolText(result) {
  return (result?.content ?? []).map(part => part?.text ?? "").join("\n");
}

async function serveFixture() {
  const fixture = await readFile(new URL("../evals/browsergym-action-space/fixture.html", import.meta.url), "utf8");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/fixture.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixture);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not expose a TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function openBrowserSurface(workspace, url) {
  const result = spawnSync("cmux", ["--json", "browser", "open", url, "--workspace", workspace, "--focus", "false"], { encoding: "utf8", timeout: 15000 });
  assert(result.status === 0, `failed to open browser surface: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert(typeof parsed.surface_ref === "string", `browser open did not return surface_ref: ${result.stdout}`);
  return parsed.surface_ref;
}

function closeSurface(surface) {
  if (!surface) return;
  spawnSync("cmux", ["--json", "close-surface", "--surface", surface], { encoding: "utf8", timeout: 15000 });
}

function closeWorkspace(workspace) {
  if (!workspace) return;
  spawnSync("cmux", ["--json", "close-workspace", "--workspace", workspace], { encoding: "utf8", timeout: 15000 });
}

function createScratchWorkspace() {
  const name = `omp-cmux-browsergym-eval-${Date.now()}`;
  const result = spawnSync("cmux", ["--json", "new-workspace", "--name", name, "--focus", "false"], { encoding: "utf8", timeout: 15000 });
  assert(result.status === 0, `failed to create scratch cmux workspace: ${result.stderr || ""}`);
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const workspace = text.match(/workspace:\d+/)?.[0];
  assert(workspace, `new-workspace did not return a workspace ref: ${text}`);
  return workspace;
}

async function assertNonEmptyFile(filePath) {
  const info = await stat(filePath);
  assert(info.size > 0, `expected non-empty screenshot file at ${filePath}`);
}

async function validateBrowserState(surface, expectedText, screenshotPath) {
  const tools = new Map(buildCmuxBrowserToolSpecs().map(spec => [spec.name, spec]));
  const wait = await tools.get("cmux_browser_wait").execute("eval-validate-wait", { surface, text: expectedText, timeoutMs: 15000 });
  assert(wait.ok, `final browser state did not include ${expectedText}: ${toolText(wait)}`);
  const screenshot = await tools.get("cmux_browser_screenshot").execute("eval-validate-screenshot", { surface, outPath: screenshotPath });
  assert(screenshot.ok, `validation screenshot failed: ${toolText(screenshot)}`);
  await assertNonEmptyFile(screenshotPath);
  return { wait: wait.details, screenshot: screenshot.details };
}

function buildPrompt(task, url, screenshotPath, workspace, surface) {
  return `You are running a local deterministic BrowserGym-action-space eval through OMP cmux browser tools.\n\nTask: ${task.prompt}\n\nURL already opened by the eval harness: ${url}\nScratch cmux workspace: ${workspace}\nBrowser surface to use for every tool call: ${surface}\nExpected visible text after the action: ${task.expectedText}\nScreenshot outPath to use with cmux_browser_screenshot: ${screenshotPath}\n\nUse this exact tool sequence and do not add other tools:\n1. cmux_browser_snapshot on surface ${surface} with selector "body".\n2. cmux_browser_fill on surface ${surface}, target #marker-input, text ${task.marker}.\n3. cmux_browser_click on surface ${surface}, target #apply-marker.\n4. cmux_browser_get on surface ${surface} with kind "text" and selector "body" to verify ${task.expectedText}.\n5. cmux_browser_screenshot on surface ${surface} with outPath ${screenshotPath}.\n\nDo not call cmux_browser_open. Do not use shell, files, network interception, cookies, storage, browser eval, wait, todo_write, or non-cmux browser tools. Return only compact JSON: {"surface":"${surface}","applied":true}. Proceed now?`;
}

async function main() {
  const cmuxCheck = spawnSync("cmux", ["--json", "identify"], { encoding: "utf8", timeout: 15000 });
  assert(cmuxCheck.status === 0, `cmux workspace is required for OMP eval: ${cmuxCheck.stderr || "cmux identify failed"}`);

  const tasks = JSON.parse(await readFile(new URL("../evals/browsergym-action-space/tasks.json", import.meta.url), "utf8"));
  assert(Array.isArray(tasks) && tasks.length > 0, "tasks.json must contain at least one task");
  const workspaceRoot = repoWorkspaceRoot();
  const runRoot = path.join(workspaceRoot, "_artifacts-local", "omp-cmux-browser-tools-eval", `omp-${safeName(MODEL)}-${runId()}`);
  const screenshotsDir = path.join(runRoot, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const server = await serveFixture();
  const summaries = [];
  const ownedSurfaces = new Set();
  const ownedWorkspaces = new Set();

  try {
    for (const task of tasks) {
      const taskDir = path.join(runRoot, task.id);
      await mkdir(taskDir, { recursive: true });
      const scratchWorkspace = createScratchWorkspace();
      ownedWorkspaces.add(scratchWorkspace);
      const url = `${server.origin}${task.path}`;
      const surface = openBrowserSurface(scratchWorkspace, url);
      ownedSurfaces.add(surface);
      await delay(5000);
      const providerScreenshot = path.join(screenshotsDir, `${task.id}-provider.png`);
      const validationScreenshot = path.join(screenshotsDir, `${task.id}-validated.png`);
      const prompt = buildPrompt(task, url, providerScreenshot, scratchWorkspace, surface);
      await writeFile(path.join(taskDir, "prompt.txt"), prompt);

      const args = [
        "--mode=json",
        "--model", MODEL,
        "--thinking", "minimal",
        "--plugin-dir", process.cwd(),
        "--auto-approve",
        "--no-session",
        "--no-title",
        "--no-skills",
        "--no-rules",
        "--tools", ALLOWED_TOOLS.join(","),
        "-p",
        prompt,
      ];
      const startedAt = new Date().toISOString();
      const result = spawnSync("omp", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: Number(process.env.CMUX_EVAL_TIMEOUT_MS || 180000),
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, CMUX_OMP_RESUME_BINDING_DISABLED: "1", CMUX_WORKSPACE_ID: scratchWorkspace },
      });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      await writeFile(path.join(taskDir, "omp-events.jsonl"), stdout);
      await writeFile(path.join(taskDir, "omp-stderr.txt"), stderr);
      assert(result.status === 0, `omp eval failed for ${task.id} with status ${result.status}: ${stderr || stdout.slice(-4000)}`);
      assert(stdout.trim().length > 0, `omp eval produced no JSON event stream for ${task.id}`);

      const events = parseJsonEvents(stdout);
      const rawToolCalls = collectToolCalls(events);
      const uniqueToolCalls = [...new Set(rawToolCalls.map(call => call.name))];
      const rawCombined = `${stdout}\n${stderr}`;
      const fallbackNames = [...new Set([...rawCombined.matchAll(/cmux_[a-zA-Z0-9_-]+/g)].map(match => match[0]))];
      const actualToolNames = uniqueToolCalls.length > 0 ? uniqueToolCalls : fallbackNames.filter(name => PROVIDER_TOOL_NAMES.includes(name));
      assert(actualToolNames.some(name => name.startsWith(task.requiredToolPrefix)), `task ${task.id} did not record an actual ${task.requiredToolPrefix} tool call`);

      const eventSurface = findSurface(events) ?? findSurface(rawCombined);
      assert(!eventSurface || eventSurface === surface, `task ${task.id} used unexpected surface ${eventSurface}; expected ${surface}`);
      const validation = await validateBrowserState(surface, task.expectedText, validationScreenshot);
      if (providerScreenshot.startsWith(runRoot)) await assertNonEmptyFile(providerScreenshot);

      const summary = {
        id: task.id,
        model: MODEL,
        startedAt,
        completedAt: new Date().toISOString(),
        url,
        status: result.status,
        eventCount: events.length,
        toolCalls: actualToolNames,
        surface,
        expectedText: task.expectedText,
        screenshots: [providerScreenshot, validationScreenshot],
        artifacts: {
          prompt: path.join(taskDir, "prompt.txt"),
          events: path.join(taskDir, "omp-events.jsonl"),
          stderr: path.join(taskDir, "omp-stderr.txt"),
        },
        validation,
      };
      await writeFile(path.join(taskDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      summaries.push(summary);
    }

    const summary = {
      ok: true,
      model: MODEL,
      runRoot,
      fixtureOrigin: server.origin,
      tasks: summaries,
      closedOwnedSurfaces: [...ownedSurfaces],
      closedOwnedWorkspaces: [...ownedWorkspaces],
    };
    await writeFile(path.join(runRoot, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const surface of ownedSurfaces) closeSurface(surface);
    for (const workspace of ownedWorkspaces) closeWorkspace(workspace);
    await server.close();
  }
}

await main();
