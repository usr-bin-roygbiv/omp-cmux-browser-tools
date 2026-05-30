import { describe, expect, test } from "bun:test";

import cmuxBrowserTools, {
  buildCmuxBrowserBackArgs,
  buildCmuxBrowserClickArgs,
  buildCmuxBrowserFillArgs,
  buildCmuxBrowserFindArgs,
  buildCmuxBrowserForwardArgs,
  buildCmuxBrowserGetArgs,
  buildCmuxBrowserGetUrlArgs,
  buildCmuxBrowserGotoArgs,
  buildCmuxBrowserIsArgs,
  buildCmuxBrowserOpenArgs,
  buildCmuxBrowserPressArgs,
  buildCmuxBrowserReloadArgs,
  buildCmuxBrowserScreenshotArgs,
  buildCmuxBrowserScrollArgs,
  buildCmuxBrowserSelectArgs,
  buildCmuxBrowserSnapshotArgs,
  buildCmuxBrowserToolSpecs,
  buildCmuxBrowserWaitArgs,
  buildCmuxHelpArgs,
  buildCmuxIdentifyArgs,
  buildCmuxWorkspaceNewArgs,
  buildCmuxWorkspaceTreeArgs,
  buildCmuxWorkspaceCloseArgs,
  buildCmuxSurfaceNewArgs,
  buildCmuxSurfaceCloseArgs,
  buildCmuxSurfaceReadArgs,
  buildCmuxTerminalOpenArgs,
  buildCmuxTerminalSendArgs,
  buildCmuxSidebarStateArgs,
  buildCmuxNotificationsListArgs,
  buildCmuxNotificationDismissArgs,
  buildCmuxSurfaceResumeShowArgs,
  buildCmuxSurfaceResumeClearArgs,
  buildCmuxConfigCheckArgs,
  buildCmuxReloadConfigArgs,
  buildCmuxMarkdownOpenArgs,
  runCmuxCommand,
  sanitizeToolText,
  type CmuxRunner,
} from "../extensions/index";
import { buildCmuxBrowserCustomTools } from "../tools/cmux-browser-tools/index";

function createMockPi() {
  const registeredTools = new Map<string, any>();
  return {
    registeredTools,
    pi: {
      setLabel(_label: string) {},
      registerTool(tool: { name?: string }) {
        if (!tool.name) throw new Error("registered tool is missing name");
        registeredTools.set(tool.name, tool);
      },
    },
  };
}

function recordingRunner(stdout = "{}", status = 0) {
  const calls: { command: string; args: string[]; timeoutMs: number }[] = [];
  const runner: CmuxRunner = (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return { status, stdout, stderr: "" };
  };
  return { calls, runner };
}

function createFakeZod() {
  const node = (kind: string, extra: Record<string, unknown> = {}) => {
    const schema: Record<string, unknown> = { kind, ...extra };
    schema.max = (value: number) => {
      schema.maxValue = value;
      return schema;
    };
    schema.min = (value: number) => {
      schema.minValue = value;
      return schema;
    };
    schema.int = () => {
      schema.integer = true;
      return schema;
    };
    schema.describe = (value: string) => {
      schema.description = value;
      return schema;
    };
    schema.optional = () => {
      schema.optionalValue = true;
      return schema;
    };
    schema.strict = () => {
      schema.strictValue = true;
      return schema;
    };
    return schema;
  };

  return {
    string: () => node("string"),
    number: () => node("number"),
    boolean: () => node("boolean"),
    object: (shape: Record<string, unknown>) => node("object", { shape }),
  };
}

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

describe("cmux browser command builders", () => {
  test("builds open args for http(s) URLs with bounded refs", () => {
    expect(buildCmuxBrowserOpenArgs({ url: "https://example.com/path?q=1", workspace: "workspace:2", window: "window:3", focus: true })).toEqual([
      "browser",
      "open",
      "https://example.com/path?q=1",
      "--workspace",
      "workspace:2",
      "--window",
      "window:3",
      "--focus",
      "true",
    ]);

    expect(buildCmuxBrowserOpenArgs({ url: "http://127.0.0.1:8765/test-page.html" })).toEqual([
      "browser",
      "open",
      "http://127.0.0.1:8765/test-page.html",
      "--focus",
      "false",
    ]);
  });

  test("rejects non-http navigation and invalid refs", () => {
    expect(() => buildCmuxBrowserOpenArgs({ url: "file:///tmp/test.html" })).toThrow("http: or https:");
    expect(() => buildCmuxBrowserOpenArgs({ url: "javascript:alert(1)" })).toThrow("http: or https:");
    expect(() => buildCmuxBrowserGotoArgs({ surface: "surface:7", url: "file:///tmp/test.html" })).toThrow("http: or https:");
    expect(() => buildCmuxBrowserGetUrlArgs({ surface: "pane:1" })).toThrow("surface:<number> or a UUID");
    expect(() => buildCmuxBrowserOpenArgs({ url: "https://example.com", workspace: "../bad" })).toThrow("workspace:<number> or a UUID");
  });

  test("builds explicit-surface navigation commands", () => {
    expect(buildCmuxBrowserGotoArgs({ surface: "surface:7", url: "https://example.com/next" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "goto",
      "https://example.com/next",
      "--snapshot-after",
    ]);
    expect(buildCmuxBrowserBackArgs({ surface: "surface:7" })).toEqual(["browser", "--surface", "surface:7", "back", "--snapshot-after"]);
    expect(buildCmuxBrowserForwardArgs({ surface: "surface:7" })).toEqual(["browser", "--surface", "surface:7", "forward", "--snapshot-after"]);
    expect(buildCmuxBrowserReloadArgs({ surface: "surface:7" })).toEqual(["browser", "--surface", "surface:7", "reload", "--snapshot-after"]);
  });

  test("builds explicit-surface read and action commands", () => {
    expect(buildCmuxBrowserGetUrlArgs({ surface: "surface:7" })).toEqual(["browser", "--surface", "surface:7", "get-url"]);
    expect(buildCmuxBrowserSnapshotArgs({ surface: "surface:7", selector: "#app", compact: true, maxDepth: 99 })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "snapshot",
      "--interactive",
      "--selector",
      "#app",
      "--compact",
      "--max-depth",
      "20",
    ]);
    expect(buildCmuxBrowserClickArgs({ surface: "surface:7", target: "#apply-marker" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "click",
      "--selector",
      "#apply-marker",
      "--snapshot-after",
    ]);
    expect(buildCmuxBrowserFillArgs({ surface: "surface:7", target: "#marker-input", text: "modified-by-omp-cmux-tool" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "fill",
      "--selector",
      "#marker-input",
      "--text",
      "modified-by-omp-cmux-tool",
      "--snapshot-after",
    ]);
    expect(buildCmuxBrowserPressArgs({ surface: "surface:7", key: "Enter" })).toEqual(["browser", "--surface", "surface:7", "press", "--key", "Enter", "--snapshot-after"]);
    expect(buildCmuxBrowserSelectArgs({ surface: "surface:7", selector: "#choice", value: "beta" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "select",
      "--selector",
      "#choice",
      "--value",
      "beta",
      "--snapshot-after",
    ]);
    expect(buildCmuxBrowserScrollArgs({ surface: "surface:7", dx: -30, dy: 420 })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "scroll",
      "--dx",
      "-30",
      "--dy",
      "420",
      "--snapshot-after",
    ]);
  });



  test("builds workspace and surface cmux commands", () => {
    expect(buildCmuxIdentifyArgs({ workspace: "workspace:2", surface: "surface:7", window: "window:3", noCaller: true })).toEqual([
      "identify",
      "--workspace",
      "workspace:2",
      "--surface",
      "surface:7",
      "--window",
      "window:3",
      "--no-caller",
    ]);
    expect(buildCmuxWorkspaceNewArgs({ name: "Scratch", cwd: ".", command: "echo ok", focus: false })).toEqual([
      "new-workspace",
      "--name",
      "Scratch",
      "--cwd",
      ".",
      "--command",
      "echo ok",
      "--focus",
      "false",
    ]);
    expect(buildCmuxWorkspaceTreeArgs({ all: true, workspace: "workspace:2" })).toEqual(["tree", "--json", "--all", "--workspace", "workspace:2"]);
    expect(buildCmuxWorkspaceCloseArgs({ workspace: "workspace:2", window: "window:1" })).toEqual(["close-workspace", "--workspace", "workspace:2", "--window", "window:1"]);
    expect(buildCmuxSurfaceNewArgs({ type: "browser", pane: "pane:4", url: "https://example.com", focus: true })).toEqual([
      "new-surface",
      "--type",
      "browser",
      "--pane",
      "pane:4",
      "--url",
      "https://example.com/",
      "--focus",
      "true",
    ]);
    expect(buildCmuxSurfaceCloseArgs({ surface: "surface:7" })).toEqual(["close-surface", "--surface", "surface:7"]);
    expect(buildCmuxSurfaceReadArgs({ surface: "surface:7", lines: 9999, scrollback: true })).toEqual(["read-screen", "--surface", "surface:7", "--lines", "500", "--scrollback"]);
  });

  test("builds diagnostics, notification, resume, terminal, and markdown commands", () => {
    expect(buildCmuxTerminalOpenArgs({ name: "Term", cwd: ".", command: "pwd", focus: true })).toEqual([
      "new-workspace",
      "--name",
      "Term",
      "--cwd",
      ".",
      "--command",
      "pwd",
      "--focus",
      "true",
    ]);
    expect(buildCmuxTerminalSendArgs({ workspace: "workspace:2", surface: "surface:7", text: "echo ok", enter: true })).toEqual(["send", "--surface", "surface:7", "--workspace", "workspace:2", "--", "echo ok\n"]);
    expect(buildCmuxSidebarStateArgs({ workspace: "workspace:2" })).toEqual(["sidebar-state", "--workspace", "workspace:2"]);
    expect(buildCmuxNotificationsListArgs({})).toEqual(["list-notifications"]);
    expect(buildCmuxNotificationDismissArgs({ id: "2792A2F9-D330-4DD9-BCBB-1FEEFB0790F3" })).toEqual(["dismiss-notification", "--id", "2792A2F9-D330-4DD9-BCBB-1FEEFB0790F3"]);
    expect(buildCmuxNotificationDismissArgs({ allRead: true })).toEqual(["dismiss-notification", "--all-read"]);
    expect(buildCmuxSurfaceResumeShowArgs({ surface: "surface:7" })).toEqual(["surface", "resume", "show", "--json", "--surface", "surface:7"]);
    expect(buildCmuxSurfaceResumeClearArgs({ surface: "surface:7" })).toEqual(["surface", "resume", "clear", "--surface", "surface:7"]);
    expect(buildCmuxConfigCheckArgs({ path: ".cmux/cmux.json" })).toEqual(["config", "check", "--path", ".cmux/cmux.json"]);
    expect(buildCmuxReloadConfigArgs({})).toEqual(["reload-config"]);
    expect(buildCmuxMarkdownOpenArgs({ path: "README.md", direction: "down", focus: false })).toEqual(["markdown", "open", "README.md", "--direction", "down", "--focus", "false"]);
    expect(() => buildCmuxWorkspaceNewArgs({ layout: "{bad" })).toThrow("valid JSON");
    expect(() => buildCmuxSurfaceNewArgs({ type: "browser", url: "file:///tmp/x" })).toThrow("http: or https:");
    expect(() => buildCmuxTerminalSendArgs({ surface: "workspace:2", text: "x" })).toThrow("surface:<number> or a UUID");
  });

  test("builds read-only inspection commands", () => {
    expect(buildCmuxBrowserFindArgs({ surface: "surface:7", kind: "text", text: "Apply marker", exact: true })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "find",
      "text",
      "--exact",
      "Apply marker",
    ]);
    expect(buildCmuxBrowserFindArgs({ surface: "surface:7", kind: "role", role: "button", name: "Apply marker", exact: true })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "find",
      "role",
      "--name",
      "Apply marker",
      "--exact",
      "button",
    ]);
    expect(buildCmuxBrowserFindArgs({ surface: "surface:7", kind: "nth", selector: "button", index: 1 })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "find",
      "nth",
      "--index",
      "1",
      "--selector",
      "button",
    ]);
    expect(buildCmuxBrowserGetArgs({ surface: "surface:7", kind: "attr", selector: "#marker-input", attrName: "placeholder" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "get",
      "attr",
      "--selector",
      "#marker-input",
      "--attr",
      "placeholder",
    ]);
    expect(buildCmuxBrowserGetArgs({ surface: "surface:7", kind: "styles", selector: "#result", propertyName: "font-weight" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "get",
      "styles",
      "--selector",
      "#result",
      "--property",
      "font-weight",
    ]);
    expect(buildCmuxBrowserIsArgs({ surface: "surface:7", kind: "enabled", selector: "#apply-marker" })).toEqual([
      "browser",
      "--surface",
      "surface:7",
      "is",
      "enabled",
      "--selector",
      "#apply-marker",
    ]);
  });

  test("builds screenshot paths only inside the owned artifact directory", () => {
    const args = buildCmuxBrowserScreenshotArgs({ surface: "surface:7", outPath: "unit/proof.png" });
    expect(args.slice(0, 5)).toEqual(["browser", "--surface", "surface:7", "screenshot", "--out"]);
    expect(args[5]).toContain("_artifacts-local/omp-cmux-browser-tools-eval/unit/proof.png");
    expect(() => buildCmuxBrowserScreenshotArgs({ surface: "surface:7", outPath: "../proof.png" })).toThrow("inside _artifacts-local/omp-cmux-browser-tools-eval");
    expect(() => buildCmuxBrowserScreenshotArgs({ surface: "surface:7", outPath: "/tmp/proof.png" })).toThrow("inside _artifacts-local/omp-cmux-browser-tools-eval");
  });

  test("rejects invalid inspection enums and unsafe action inputs", () => {
    expect(() => buildCmuxBrowserFindArgs({ surface: "surface:7", kind: "eval", text: "x" })).toThrow("find kind");
    expect(() => buildCmuxBrowserFindArgs({ surface: "surface:7", kind: "nth", selector: "button", index: -1 })).toThrow("index");
    expect(() => buildCmuxBrowserGetArgs({ surface: "surface:7", kind: "cookies" })).toThrow("get kind");
    expect(() => buildCmuxBrowserGetArgs({ surface: "surface:7", kind: "attr", selector: "#x" })).toThrow("attrName");
    expect(() => buildCmuxBrowserIsArgs({ surface: "surface:7", kind: "selected", selector: "#x" })).toThrow("is kind");
    expect(() => buildCmuxBrowserPressArgs({ surface: "surface:7", key: "Enter\n" })).toThrow("key");
    expect(() => buildCmuxBrowserScrollArgs({ surface: "surface:7" })).toThrow("dx or dy");
  });

  test("builds bounded wait commands", () => {
    expect(buildCmuxBrowserWaitArgs({ surface: "surface:3", loadState: "interactive", selector: "#marker-input", timeoutMs: 999_999 })).toEqual({
      args: ["browser", "--surface", "surface:3", "wait", "--load-state", "interactive", "--selector", "#marker-input", "--timeout-ms", "60000"],
      timeoutMs: 60_000,
    });
    expect(() => buildCmuxBrowserWaitArgs({ surface: "surface:3", function: "document.readyState === 'complete'" })).toThrow("JavaScript wait functions are not exposed");
    expect(buildCmuxBrowserWaitArgs({ surface: "surface:3" })).toEqual({
      args: ["browser", "--surface", "surface:3", "wait", "--load-state", "complete", "--timeout-ms", "5000"],
      timeoutMs: 5_000,
    });
    expect(() => buildCmuxBrowserWaitArgs({ surface: "surface:3", loadState: "networkidle" })).toThrow("interactive or complete");
  });

  test("builds read-only cmux help commands", () => {
    expect(buildCmuxHelpArgs({})).toEqual(["help"]);
    expect(buildCmuxHelpArgs({ command: "browser wait" })).toEqual(["browser", "wait", "--help"]);
    expect(() => buildCmuxHelpArgs({ command: "browser; touch /tmp/owned" })).toThrow("cmux command tokens");
  });
});

describe("cmux command execution", () => {
  test("uses argv arrays with global json flag and preserves unsafe-looking input as data", async () => {
    const { calls, runner } = recordingRunner('{"surface":"surface:12"}');
    const open = buildCmuxBrowserToolSpecs({ runner }).find((spec) => spec.name === "cmux_browser_open")!;
    const unsafeUrl = "https://example.com/a;touch%20/tmp/owned";
    const result = await open.execute("call-1", { url: unsafeUrl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("cmux");
    expect(calls[0].args).toEqual(["--json", "browser", "open", unsafeUrl, "--focus", "false"]);
  });

  test("cmux_help executes without the global json flag", async () => {
    const { calls, runner } = recordingRunner("browser help output");
    const help = buildCmuxBrowserToolSpecs({ runner }).find((spec) => spec.name === "cmux_help")!;

    const result = await help.execute("call-help", { command: "browser" });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("cmux");
    expect(calls[0].args).toEqual(["browser", "--help"]);
    expect(result.content[0].text).toBe("browser help output");
  });

  test("parses JSON stdout and falls back to redacted text", () => {
    const jsonRunner: CmuxRunner = () => ({ status: 0, stdout: '{"url":"https://example.com"}', stderr: "" });
    const jsonResult = runCmuxCommand(["browser", "status"], { runner: jsonRunner });
    expect(jsonResult.ok).toBe(true);
    expect(jsonResult.details.stdoutJson).toEqual({ url: "https://example.com" });
    expect(jsonResult.content).toEqual([{ type: "text", text: '{"url":"https://example.com"}' }]);
    expect(jsonResult.isError).toBe(false);

    const textRunner: CmuxRunner = () => ({ status: 0, stdout: "plain text output", stderr: "" });
    const textResult = runCmuxCommand(["browser", "status"], { runner: textRunner });
    expect(textResult.ok).toBe(true);
    expect(textResult.details.stdout).toBe("plain text output");
    expect(textResult.details).not.toHaveProperty("stdoutJson");
    expect(textResult.content).toEqual([{ type: "text", text: "plain text output" }]);
  });

  test("normalizes screenshot and inspection result details", async () => {
    const { runner: screenshotRunner } = recordingRunner('{"path":"ignored"}');
    const screenshot = buildCmuxBrowserToolSpecs({ runner: screenshotRunner }).find((spec) => spec.name === "cmux_browser_screenshot")!;
    const screenshotResult = await screenshot.execute("call-screenshot", { surface: "surface:7", outPath: "unit/result.png" });
    expect(screenshotResult.ok).toBe(true);
    expect(screenshotResult.details.surface).toBe("surface:7");
    expect(screenshotResult.details.outPath).toContain("_artifacts-local/omp-cmux-browser-tools-eval/unit/result.png");

    const { runner: getRunner } = recordingRunner('{"text":"Applied marker"}');
    const get = buildCmuxBrowserToolSpecs({ runner: getRunner }).find((spec) => spec.name === "cmux_browser_get")!;
    const getResult = await get.execute("call-get", { surface: "surface:7", kind: "text", selector: "#result" });
    expect(getResult.ok).toBe(true);
    expect(getResult.details.kind).toBe("text");
    expect(getResult.details.selector).toBe("#result");

    const { runner: isRunner } = recordingRunner('{"ok":true}');
    const is = buildCmuxBrowserToolSpecs({ runner: isRunner }).find((spec) => spec.name === "cmux_browser_is")!;
    const isResult = await is.execute("call-is", { surface: "surface:7", kind: "visible", selector: "#result" });
    expect(isResult.ok).toBe(true);
    expect(isResult.details.kind).toBe("visible");
    expect(isResult.details.selector).toBe("#result");
  });

  test("redacts sensitive-looking output", () => {
    const redacted = sanitizeToolText("token secret-value, bearer abc123, dev@example.com, sk-1234567890abcdef, cookie: sid=secret");
    expect(redacted).toContain("token [REDACTED]");
    expect(redacted).toContain("bearer [REDACTED]");
    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).toContain("sk-[REDACTED]");
    expect(redacted).toContain("cookie: [REDACTED]");
  });
});

describe("tool registration", () => {
  test("registers the cmux help and browser tools", () => {
    const specs = buildCmuxBrowserToolSpecs();
    expect(specs.map((spec) => spec.name).sort()).toEqual(EXPECTED_TOOL_NAMES);

    const mock = createMockPi();
    cmuxBrowserTools(mock.pi as any);
    expect([...mock.registeredTools.keys()].sort()).toEqual(specs.map((spec) => spec.name).sort());
  });

  test("tool validation errors are returned without invoking cmux", async () => {
    const { calls, runner } = recordingRunner();
    const specs = buildCmuxBrowserToolSpecs({ runner });
    const fill = specs.find((spec) => spec.name === "cmux_browser_fill")!;
    const result = await fill.execute("call-2", { surface: "bad", target: "#marker-input", text: "x" });
    expect(result.ok).toBe(false);
    expect(String(result.details.error)).toContain("surface:<number> or a UUID");
    expect(result.content[0].text).toContain("surface:<number> or a UUID");
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("custom-tool wrapper", () => {
  test("exposes the same cmux help and browser tools as custom tools", () => {
    const specs = buildCmuxBrowserToolSpecs();
    const tools = buildCmuxBrowserCustomTools({ zod: createFakeZod() as any });

    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
    expect(tools.every((tool) => tool.strict === true)).toBe(true);

    const open = tools.find((tool) => tool.name === "cmux_browser_open")!;
    expect((open.parameters as any).strictValue).toBe(true);
    expect((open.parameters as any).shape.url.kind).toBe("string");
    expect((open.parameters as any).shape.url.maxValue).toBe(2048);

    const help = tools.find((tool) => tool.name === "cmux_help")!;
    expect((help.parameters as any).strictValue).toBe(true);
    expect((help.parameters as any).shape.command.kind).toBe("string");

    const find = tools.find((tool) => tool.name === "cmux_browser_find")!;
    expect((find.parameters as any).strictValue).toBe(true);
    expect((find.parameters as any).shape.kind.kind).toBe("string");
    expect((find.parameters as any).shape.exact.kind).toBe("boolean");

    const screenshot = tools.find((tool) => tool.name === "cmux_browser_screenshot")!;
    expect((screenshot.parameters as any).shape.outPath.maxValue).toBe(512);
  });

  test("uses the shared cmux argv builders for custom-tool execution", async () => {
    const { calls, runner } = recordingRunner('{"surface":"surface:12"}');
    const tools = buildCmuxBrowserCustomTools({ zod: createFakeZod() as any }, { runner });
    const open = tools.find((tool) => tool.name === "cmux_browser_open")!;
    const unsafeUrl = "https://example.com/a;touch%20/tmp/owned";

    const result = await open.execute("call-3", { url: unsafeUrl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("cmux");
    expect(calls[0].args).toEqual(["--json", "browser", "open", unsafeUrl, "--focus", "false"]);
  });
});
