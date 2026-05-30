import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCmuxBrowserToolSpecs } from "../extensions/index.ts";

const EXPECTED_TOOL_NAMES = [
  "cmux_browser_back",
  "cmux_browser_click",
  "cmux_browser_fill",
  "cmux_browser_find",
  "cmux_browser_forward",
  "cmux_browser_get",
  "cmux_browser_get_url",
  "cmux_browser_goto",
  "cmux_browser_is",
  "cmux_browser_open",
  "cmux_browser_press",
  "cmux_browser_reload",
  "cmux_browser_screenshot",
  "cmux_browser_scroll",
  "cmux_browser_select",
  "cmux_browser_snapshot",
  "cmux_browser_wait",
  "cmux_config_check",
  "cmux_help",
  "cmux_identify",
  "cmux_markdown_open",
  "cmux_markdown_preview",
  "cmux_notification_dismiss",
  "cmux_notifications_list",
  "cmux_reload_config",
  "cmux_sidebar_state",
  "cmux_surface_close",
  "cmux_surface_new",
  "cmux_surface_read",
  "cmux_surface_resume_clear",
  "cmux_surface_resume_show",
  "cmux_terminal_open",
  "cmux_terminal_send",
  "cmux_workspace_close",
  "cmux_workspace_new",
  "cmux_workspace_tree",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repoWorkspaceRoot() {
  const cwd = process.cwd();
  return path.basename(cwd) === "omp-cmux-browser-tools" ? path.dirname(cwd) : cwd;
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toolText(result) {
  return (result?.content ?? []).map(part => part?.text ?? "").join("\n");
}

const SURFACE_KEYS = ["surface", "surface_ref", "browser_surface_ref", "target_surface_ref", "openedSurface"];
const WORKSPACE_KEYS = ["workspace", "workspace_ref", "target_workspace_ref", "openedWorkspace"];

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

function extractSurface(result) {
  return findSurface(result?.details?.stdoutJson) ?? findSurface(result?.details) ?? findSurface(toolText(result));
}

function findWorkspace(value) {
  if (typeof value === "string") {
    const match = value.match(/workspace:\d+/);
    return match?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWorkspace(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of WORKSPACE_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && /^workspace:\d+$/.test(candidate)) return candidate;
    }
    for (const item of Object.values(value)) {
      const found = findWorkspace(item);
      if (found) return found;
    }
  }
  return undefined;
}

function extractWorkspace(result) {
  return findWorkspace(result?.details?.stdoutJson) ?? findWorkspace(result?.details) ?? findWorkspace(toolText(result));
}

function extractTerminalSurfaceFromWorkspace(result, workspace) {
  const tree = result?.details?.stdoutJson;
  const windows = Array.isArray(tree?.windows) ? tree.windows : [];
  for (const window of windows) {
    const workspaces = Array.isArray(window?.workspaces) ? window.workspaces : [];
    for (const candidateWorkspace of workspaces) {
      if (candidateWorkspace?.ref !== workspace) continue;
      const panes = Array.isArray(candidateWorkspace?.panes) ? candidateWorkspace.panes : [];
      for (const pane of panes) {
        const surfaces = Array.isArray(pane?.surfaces) ? pane.surfaces : [];
        for (const candidateSurface of surfaces) {
          if (candidateSurface?.type === "terminal" && typeof candidateSurface?.tty === "string" && typeof candidateSurface?.ref === "string") return candidateSurface.ref;
        }
      }
    }
  }
  return undefined;
}

function commandFailed(name, result) {
  return `${name} failed: ${toolText(result) || JSON.stringify(result?.details ?? result)}`;
}

function summarizeResult(result) {
  return {
    ok: result.ok,
    isError: result.isError,
    details: {
      exitCode: result.details?.exitCode,
      surface: result.details?.surface,
      url: result.details?.url,
      kind: result.details?.kind,
      selector: result.details?.selector,
      target: result.details?.target,
      outPath: result.details?.outPath,
      workspace: result.details?.workspace,
      stdoutJson: result.details?.stdoutJson,
      stdout: typeof result.details?.stdout === "string" ? result.details.stdout.slice(0, 1000) : undefined,
      stderr: typeof result.details?.stderr === "string" ? result.details.stderr.slice(0, 1000) : undefined,
      error: result.details?.error,
    },
  };
}

async function serveFixture() {
  const fixture = await readFile(new URL("../evals/browsergym-action-space/fixture.html", import.meta.url), "utf8");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/fixture.html?view=home" });
      response.end();
      return;
    }
    if (url.pathname === "/fixture.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
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

async function assertNonEmptyFile(filePath) {
  const info = await stat(filePath);
  assert(info.size > 0, `expected non-empty screenshot file at ${filePath}`);
}

function closeSurface(surface) {
  if (!surface) return;
  Bun.spawnSync(["cmux", "--json", "close-surface", "--surface", surface], { stdout: "pipe", stderr: "pipe" });
}

function closeWorkspace(workspace) {
  if (!workspace) return;
  Bun.spawnSync(["cmux", "--json", "close-workspace", "--workspace", workspace], { stdout: "pipe", stderr: "pipe" });
}

function createScratchWorkspace() {
  const name = `omp-cmux-browser-tools-smoke-${Date.now()}`;
  const result = Bun.spawnSync(["cmux", "--json", "new-workspace", "--name", name, "--focus", "false"], { stdout: "pipe", stderr: "pipe" });
  assert(result.exitCode === 0, `failed to create scratch cmux workspace: ${result.stderr?.toString() ?? ""}`);
  const text = `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`;
  const workspace = text.match(/workspace:\d+/)?.[0];
  assert(workspace, `new-workspace did not return a workspace ref: ${text}`);
  return workspace;
}

async function main() {
  const cmuxCheck = Bun.spawnSync(["cmux", "--json", "identify"], { stdout: "pipe", stderr: "pipe" });
  assert(cmuxCheck.exitCode === 0, `cmux workspace is required for interactive smoke: ${cmuxCheck.stderr?.toString() ?? "cmux identify failed"}`);

  const workspaceRoot = repoWorkspaceRoot();
  const runRoot = path.join(workspaceRoot, "_artifacts-local", "omp-cmux-browser-tools-eval", `interactive-${runId()}`);
  const screenshotsDir = path.join(runRoot, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  process.env.CMUX_BROWSER_OPEN_SETTLE_MS = "0";
  const server = await serveFixture();
  const specs = buildCmuxBrowserToolSpecs();
  const tools = new Map(specs.map(spec => [spec.name, spec]));
  const actualNames = [...tools.keys()].sort();
  assert(JSON.stringify(actualNames) === JSON.stringify(EXPECTED_TOOL_NAMES), `tool list mismatch: ${JSON.stringify(actualNames)}`);

  const toolCalls = [];
  const screenshots = [];
  let surface;
  let terminalSurface;
  let scratchWorkspace;
  let terminalWorkspace;
  let notificationId;
  let sequence = 0;

  async function call(name, input) {
    const tool = tools.get(name);
    assert(tool, `missing tool ${name}`);
    const result = await tool.execute(`interactive-${++sequence}-${name}`, input);
    toolCalls.push({ name, input, result: summarizeResult(result) });
    assert(result?.ok, commandFailed(name, result));
    return result;
  }

  async function screenshot(label) {
    const outPath = path.join(screenshotsDir, `${String(screenshots.length + 1).padStart(2, "0")}-${label}.png`);
    const result = await call("cmux_browser_screenshot", { surface, outPath });
    await assertNonEmptyFile(outPath);
    screenshots.push({ label, path: outPath, result: summarizeResult(result) });
    return outPath;
  }

  try {
    const homeUrl = `${server.origin}/fixture.html?view=home`;
    const navUrl = `${server.origin}/fixture.html?view=nav-branch`;

    await call("cmux_help", { command: "browser" });
    const identified = await call("cmux_identify", {});
    const callerSurface = identified.details?.stdoutJson?.caller?.surface_ref ?? identified.details?.stdoutJson?.focused?.surface_ref;
    if (callerSurface) await call("cmux_surface_read", { surface: callerSurface, lines: 20 });

    const createdWorkspace = await call("cmux_workspace_new", { name: "omp-cmux-tools-smoke-" + Date.now(), focus: false });
    scratchWorkspace = extractWorkspace(createdWorkspace);
    assert(scratchWorkspace, "could not extract scratch workspace from " + toolText(createdWorkspace));
    await call("cmux_workspace_tree", { workspace: scratchWorkspace });
    await call("cmux_sidebar_state", { workspace: scratchWorkspace });
    await call("cmux_notifications_list", {});
    await call("cmux_config_check", {});

    const markdownPath = path.join(runRoot, "preview.md");
    await writeFile(markdownPath, "# cmux markdown smoke\n\nTyped tool preview.\n");
    await call("cmux_markdown_open", { path: markdownPath, workspace: scratchWorkspace, focus: false });
    await call("cmux_markdown_preview", { path: markdownPath, workspace: scratchWorkspace, direction: "down", focus: false });

    const inactiveTerminalOpened = await call("cmux_surface_new", { type: "terminal", workspace: scratchWorkspace, focus: false });
    terminalSurface = extractSurface(inactiveTerminalOpened);
    assert(terminalSurface, "could not extract inactive terminal surface from " + toolText(inactiveTerminalOpened));
    await call("cmux_surface_close", { workspace: scratchWorkspace, surface: terminalSurface });
    terminalSurface = undefined;

    const terminalWorkspaceOpened = await call("cmux_terminal_open", {
      name: "omp-cmux-terminal-open-smoke",
      command: "printf cmux-terminal-open-smoke",
      focus: false,
    });
    terminalWorkspace = extractWorkspace(terminalWorkspaceOpened);
    assert(terminalWorkspace, "could not extract terminal workspace from " + toolText(terminalWorkspaceOpened));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await delay(1000);
      const terminalTree = await call("cmux_workspace_tree", { workspace: terminalWorkspace });
      terminalSurface = extractTerminalSurfaceFromWorkspace(terminalTree, terminalWorkspace);
      if (terminalSurface) break;
    }
    assert(terminalSurface, "could not extract terminal surface with tty from terminal workspace");
    await call("cmux_terminal_send", { workspace: terminalWorkspace, surface: terminalSurface, text: "printf cmux-terminal-send-smoke", enter: true });
    await delay(1000);
    await call("cmux_surface_read", { workspace: terminalWorkspace, surface: terminalSurface, scrollback: true, lines: 80 });
    await call("cmux_surface_resume_show", { workspace: terminalWorkspace, surface: terminalSurface });
    await call("cmux_surface_resume_clear", { workspace: terminalWorkspace, surface: terminalSurface });
    await call("cmux_workspace_close", { workspace: terminalWorkspace });
    terminalSurface = undefined;
    terminalWorkspace = undefined;

    const notify = Bun.spawnSync(["cmux", "--json", "notify", "--title", "omp-cmux-browser-tools-smoke", "--body", "owned temporary notification"], { stdout: "pipe", stderr: "pipe" });
    assert(notify.exitCode === 0, "failed to create owned notification: " + (notify.stderr?.toString() ?? ""));
    const notificationList = await call("cmux_notifications_list", {});
    const notifications = Array.isArray(notificationList.details?.stdoutJson) ? notificationList.details.stdoutJson : [];
    notificationId = notifications.find(item => item?.title === "omp-cmux-browser-tools-smoke" && item?.body === "owned temporary notification")?.id;
    assert(typeof notificationId === "string", "could not find owned notification id in list-notifications output");
    await call("cmux_notification_dismiss", { id: notificationId });
    notificationId = undefined;
    await call("cmux_reload_config", {});

    const opened = await call("cmux_browser_open", { url: homeUrl, workspace: scratchWorkspace, focus: false });
    surface = extractSurface(opened);
    assert(surface, `could not extract opened browser surface from ${toolText(opened)}`);
    await delay(5000);

    await call("cmux_browser_wait", { surface, loadState: "complete", timeoutMs: 15000 });
    const readySnapshot = await call("cmux_browser_snapshot", { surface, selector: "body", compact: true, maxDepth: 10 });
    assert(toolText(readySnapshot).includes("Apply marker"), "ready snapshot did not include fixture controls");
    await screenshot("opened-home");

    const gotUrl = await call("cmux_browser_get_url", { surface });
    assert(toolText(gotUrl).includes(homeUrl), `get_url did not include ${homeUrl}`);
    const snapshot = await call("cmux_browser_snapshot", { surface, selector: "body", compact: true, maxDepth: 10 });
    assert(toolText(snapshot).includes("Apply marker"), "snapshot did not include form controls");

    await call("cmux_browser_find", { surface, kind: "text", text: "Apply marker", exact: true });
    await call("cmux_browser_find", { surface, kind: "role", role: "button", name: "Apply marker", exact: true });
    await call("cmux_browser_get", { surface, kind: "url" });
    const title = await call("cmux_browser_get", { surface, kind: "title" });
    assert(toolText(title).includes("BrowserGym cmux action-space fixture"), "title read did not include fixture title");
    await call("cmux_browser_get", { surface, kind: "text", selector: "body" });
    await call("cmux_browser_get", { surface, kind: "value", selector: "#marker-input" });
    const attr = await call("cmux_browser_get", { surface, kind: "attr", selector: "#marker-input", attrName: "placeholder" });
    assert(toolText(attr).includes("enter marker text"), "attr read did not include marker placeholder");
    await call("cmux_browser_get", { surface, kind: "count", selector: "button" });
    await call("cmux_browser_get", { surface, kind: "box", selector: "#result" });
    await call("cmux_browser_get", { surface, kind: "styles", selector: "#result", propertyName: "font-weight" });
    await call("cmux_browser_is", { surface, kind: "visible", selector: "#result" });
    await call("cmux_browser_is", { surface, kind: "enabled", selector: "#apply-marker" });
    await call("cmux_browser_is", { surface, kind: "checked", selector: "#ready-checkbox" });

    await call("cmux_browser_goto", { surface, url: navUrl });
    await delay(3000);
    const navGotUrl = await call("cmux_browser_get_url", { surface });
    assert(toolText(navGotUrl).includes(navUrl), `goto did not reach ${navUrl}`);
    await call("cmux_browser_wait", { surface, loadState: "complete", timeoutMs: 15000 });
    await screenshot("goto-nav");
    await call("cmux_browser_back", { surface });
    await delay(3000);
    const backGotUrl = await call("cmux_browser_get_url", { surface });
    assert(toolText(backGotUrl).includes(homeUrl), `back did not reach ${homeUrl}`);
    await screenshot("back-home");
    await call("cmux_browser_forward", { surface });
    await delay(3000);
    const forwardGotUrl = await call("cmux_browser_get_url", { surface });
    assert(toolText(forwardGotUrl).includes(navUrl), `forward did not reach ${navUrl}`);
    await call("cmux_browser_reload", { surface });
    await delay(3000);
    await call("cmux_browser_wait", { surface, loadState: "complete", timeoutMs: 15000 });

    const marker = "interactive-browsergym-marker";
    await call("cmux_browser_fill", { surface, target: "#marker-input", text: marker });
    await call("cmux_browser_click", { surface, target: "#apply-marker" });
    await call("cmux_browser_wait", { surface, text: `Applied marker: ${marker}`, timeoutMs: 15000 });
    await screenshot("marker-applied");

    await call("cmux_browser_fill", { surface, target: "#enter-input", text: "keyboard-browsergym-marker" });
    await call("cmux_browser_click", { surface, target: "#enter-input" });
    await call("cmux_browser_press", { surface, key: "Enter" });
    await call("cmux_browser_wait", { surface, text: "Keyboard marker: keyboard-browsergym-marker", timeoutMs: 15000 });

    await call("cmux_browser_select", { surface, selector: "#choice-select", value: "beta" });
    await call("cmux_browser_wait", { surface, text: "Selected choice: beta", timeoutMs: 15000 });
    await call("cmux_browser_scroll", { surface, dy: 320 });
    await screenshot("keyboard-select");

    await call("cmux_browser_scroll", { surface, dy: 1700 });
    await screenshot("scrolled-offscreen");

    await call("cmux_surface_close", { workspace: scratchWorkspace, surface });
    surface = undefined;
    await call("cmux_workspace_close", { workspace: scratchWorkspace });
    scratchWorkspace = undefined;

    const exercised = new Set(toolCalls.map(call => call.name));
    const missing = EXPECTED_TOOL_NAMES.filter(name => !exercised.has(name));
    assert(missing.length === 0, `interactive smoke did not exercise tools: ${missing.join(", ")}`);
    assert(screenshots.length >= 5, "expected screenshots for opened/navigation/form/scroll proof");

    const summary = {
      ok: true,
      runRoot,
      fixtureOrigin: server.origin,
      scratchWorkspace,
      surface,
      tools: EXPECTED_TOOL_NAMES,
      exercisedTools: [...exercised].sort(),
      screenshots,
      toolCallCount: toolCalls.length,
      closedOwnedSurface: true,
      closedOwnedWorkspace: true,
    };
    await writeFile(path.join(runRoot, "tool-calls.json"), JSON.stringify(toolCalls, null, 2) + "\n");
    await writeFile(path.join(runRoot, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (notificationId) Bun.spawnSync(["cmux", "--json", "dismiss-notification", "--id", notificationId], { stdout: "pipe", stderr: "pipe" });
    closeSurface(surface);
    closeSurface(terminalSurface);
    closeWorkspace(terminalWorkspace);
    closeWorkspace(scratchWorkspace);
    await server.close();
  }
}

await main();
