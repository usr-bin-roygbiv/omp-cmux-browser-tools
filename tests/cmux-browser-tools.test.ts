import { describe, expect, test } from "bun:test";

import cmuxBrowserTools, {
  buildCmuxBrowserClickArgs,
  buildCmuxBrowserFillArgs,
  buildCmuxBrowserGetUrlArgs,
  buildCmuxBrowserOpenArgs,
  buildCmuxBrowserSnapshotArgs,
  buildCmuxBrowserToolSpecs,
  buildCmuxBrowserWaitArgs,
  buildCmuxHelpArgs,
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
  "cmux_browser_click",
  "cmux_browser_fill",
  "cmux_browser_get_url",
  "cmux_browser_open",
  "cmux_browser_snapshot",
  "cmux_browser_wait",
  "cmux_help",
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
    expect(() => buildCmuxBrowserGetUrlArgs({ surface: "pane:1" })).toThrow("surface:<number> or a UUID");
    expect(() => buildCmuxBrowserOpenArgs({ url: "https://example.com", workspace: "../bad" })).toThrow("workspace:<number> or a UUID");
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
  });

  test("builds bounded wait commands", () => {
    expect(buildCmuxBrowserWaitArgs({ surface: "surface:3", loadState: "interactive", selector: "#marker-input", timeoutMs: 999_999 })).toEqual({
      args: ["browser", "--surface", "surface:3", "wait", "--load-state", "interactive", "--selector", "#marker-input", "--timeout-ms", "60000"],
      timeoutMs: 60_000,
    });
    expect(buildCmuxBrowserWaitArgs({ surface: "surface:3", function: "document.readyState === 'complete'" })).toEqual({
      args: ["browser", "--surface", "surface:3", "wait", "--function", "document.readyState === 'complete'", "--timeout-ms", "5000"],
      timeoutMs: 5_000,
    });
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
