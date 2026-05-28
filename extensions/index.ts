/**
 * OMP/Pi extension exposing a bounded native cmux browser tool set.
 *
 * Channel: local plugin repo; load explicitly with `omp -e <repo>/extensions/index.ts` or future plugin install.
 * Side effects: creates or drives cmux browser surfaces only when a registered tool is explicitly invoked.
 * Runtime state: none; no cookies, storage, downloads, scripts, or browser profiles are exported or mutated by this extension.
 * External dependencies: `cmux` CLI on PATH; OMP/Pi provides the extension runtime.
 * Validation: `bun test tests/*.test.ts` plus an owned cmux/OMP smoke against `smoke/test-page.html`.
 */

import { spawnSync } from "node:child_process";

export type ToolInput = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;
export type TextContent = { type: "text"; text: string };
export type ToolResult = { ok: boolean; content: TextContent[]; details: JsonObject; isError?: boolean; redactedText?: string };
export type ParameterSchema = { type: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
export type ToolSpec = {
	name: string;
	label: string;
	description: string;
	parameters: ParameterSchema;
	scopes?: string[];
	defaultInactive?: boolean;
	execute: (toolCallId: string, input: ToolInput) => Promise<ToolResult> | ToolResult;
};
export type PiApi = { setLabel?: (label: string) => void; registerTool?: (tool: ToolSpec) => void };
export type Env = Record<string, string | undefined>;
export type SpawnLikeResult = { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer; error?: Error };
export type CmuxRunner = (command: string, args: string[], options: { env: Env; timeoutMs: number }) => SpawnLikeResult;

const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const MAX_COMMAND_TIMEOUT_MS = 65_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_URL_CHARS = 2_048;
const MAX_TARGET_CHARS = 1_024;
const MAX_TEXT_CHARS = 4_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^surface:\d+$/;
const WORKSPACE_RE = /^workspace:\d+$/;
const WINDOW_RE = /^window:\d+$/;
const LOAD_STATES = new Set(["interactive", "complete"]);

type CmuxToolOptions = { env?: Env; runner?: CmuxRunner };

function str(description: string, maxLength?: number): Record<string, unknown> {
	return { type: "string", description, ...(maxLength ? { maxLength } : {}) };
}

function bool(description: string): Record<string, unknown> {
	return { type: "boolean", description };
}

function integer(description: string, minimum?: number, maximum?: number): Record<string, unknown> {
	return { type: "integer", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) };
}

function schema(properties: Record<string, unknown>, required?: string[]): ParameterSchema {
	return { type: "object", properties, additionalProperties: false, ...(required ? { required } : {}) };
}

function stringInput(input: ToolInput, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function boolInput(input: ToolInput, key: string): boolean | undefined {
	return typeof input[key] === "boolean" ? input[key] as boolean : undefined;
}

function intInput(input: ToolInput, key: string): number | undefined {
	const value = input[key];
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	return undefined;
}

function nonemptyString(input: ToolInput, key: string, label: string, maxLength: number): string {
	const value = stringInput(input, key);
	if (value === undefined || value.trim() === "") throw new Error(`${label} is required`);
	if (value.length > maxLength) throw new Error(`${label} is too long`);
	return value;
}

function stringValue(input: ToolInput, key: string, label: string, maxLength: number): string {
	const value = stringInput(input, key);
	if (value === undefined) throw new Error(`${label} is required`);
	if (value.length > maxLength) throw new Error(`${label} is too long`);
	return value;
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : fallback;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function validateRef(value: string, kind: "surface" | "workspace" | "window"): string {
	const prefixed = kind === "surface" ? SURFACE_RE : kind === "workspace" ? WORKSPACE_RE : WINDOW_RE;
	if (prefixed.test(value) || UUID_RE.test(value)) return value;
	throw new Error(`${kind} must be ${kind}:<number> or a UUID`);
}

function optionalRef(input: ToolInput, key: "workspace" | "window", args: string[]): void {
	const value = stringInput(input, key);
	if (!value) return;
	args.push(`--${key}`, validateRef(value, key));
}

function httpUrl(input: ToolInput): string {
	const value = nonemptyString(input, "url", "url", MAX_URL_CHARS);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("url must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url protocol must be http: or https:");
	return parsed.toString();
}

function surfaceInput(input: ToolInput): string {
	return validateRef(nonemptyString(input, "surface", "surface", 128), "surface");
}

function waitTimeoutMs(input: ToolInput): number {
	const seconds = input.timeoutSeconds === undefined ? undefined : Number(input.timeoutSeconds) * 1000;
	return clampInt(input.timeoutMs ?? seconds, DEFAULT_WAIT_TIMEOUT_MS, 100, MAX_WAIT_TIMEOUT_MS);
}

export function sanitizeToolText(text: string, maxChars = MAX_OUTPUT_CHARS): string {
	const redacted = text
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
		.replace(/bearer\s+[^\s,;]+/gi, "bearer [REDACTED]")
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]")
		.replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "gh_[REDACTED]")
		.replace(/token\s+[^\s,;]+/gi, "token [REDACTED]")
		.replace(/(cookie|set-cookie):\s*[^\n\r]+/gi, "$1: [REDACTED]");
	return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[truncated ${redacted.length - maxChars} chars]` : redacted;
}

function defaultRunner(command: string, args: string[], options: { env: Env; timeoutMs: number }): SpawnLikeResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs,
		maxBuffer: 512 * 1024,
	});
	return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

function parseJsonMaybe(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function toolResult(ok: boolean, details: JsonObject, redactedText?: string): ToolResult {
	const text = redactedText || JSON.stringify(details, null, 2);
	return { ok, content: [{ type: "text", text }], details, isError: !ok, redactedText };
}

export function runCmuxCommand(args: string[], options: CmuxToolOptions & { timeoutMs?: number } = {}): ToolResult {
	const timeoutMs = clampInt(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 100, MAX_COMMAND_TIMEOUT_MS);
	const fullArgs = ["--json", ...args];
	const runner = options.runner ?? defaultRunner;
	try {
		const result = runner("cmux", fullArgs, { env: options.env ?? process.env, timeoutMs });
		const stdout = sanitizeToolText(String(result.stdout ?? ""));
		const stderr = sanitizeToolText(String(result.stderr ?? ""));
		const stdoutJson = parseJsonMaybe(stdout);
		const stderrJson = parseJsonMaybe(stderr);
		const ok = result.status === 0 && !result.error;
		const details = {
			command: "cmux",
			args: fullArgs,
			exitCode: result.status,
			stdout,
			stderr,
			...(stdoutJson !== undefined ? { stdoutJson } : {}),
			...(stderrJson !== undefined ? { stderrJson } : {}),
			...(result.error ? { error: result.error.message } : {}),
		};
		return toolResult(ok, details, [stdout, stderr].filter(Boolean).join("\n"));
	} catch (error) {
		return toolResult(false, { command: "cmux", args: fullArgs, error: error instanceof Error ? error.message : String(error) });
	}
}

export function buildCmuxBrowserOpenArgs(input: ToolInput): string[] {
	const args = ["browser", "open", httpUrl(input)];
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	args.push("--focus", String(boolInput(input, "focus") ?? false));
	return args;
}

export function buildCmuxBrowserGetUrlArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "get-url"];
}

export function buildCmuxBrowserSnapshotArgs(input: ToolInput): string[] {
	const args = ["browser", "--surface", surfaceInput(input), "snapshot", "--interactive"];
	const selector = stringInput(input, "selector");
	if (selector !== undefined) args.push("--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS));
	if (boolInput(input, "compact")) args.push("--compact");
	const maxDepth = intInput(input, "maxDepth");
	if (maxDepth !== undefined) args.push("--max-depth", String(Math.max(1, Math.min(20, maxDepth))));
	return args;
}

export function buildCmuxBrowserWaitArgs(input: ToolInput): { args: string[]; timeoutMs: number } {
	const timeoutMs = waitTimeoutMs(input);
	const args = ["browser", "--surface", surfaceInput(input), "wait"];
	const loadState = stringInput(input, "loadState");
	if (loadState !== undefined) {
		if (!LOAD_STATES.has(loadState)) throw new Error("loadState must be interactive or complete");
		args.push("--load-state", loadState);
	}
	const selector = stringInput(input, "selector");
	if (selector !== undefined) args.push("--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS));
	const text = stringInput(input, "text");
	if (text !== undefined) args.push("--text", nonemptyString(input, "text", "text", MAX_TEXT_CHARS));
	const url = stringInput(input, "url");
	if (url !== undefined) args.push("--url", nonemptyString(input, "url", "url", MAX_URL_CHARS));
	const urlContains = stringInput(input, "urlContains");
	if (urlContains !== undefined) args.push("--url-contains", nonemptyString(input, "urlContains", "urlContains", MAX_URL_CHARS));
	if (args[4] === undefined) args.push("--load-state", "complete");
	args.push("--timeout-ms", String(timeoutMs));
	return { args, timeoutMs };
}

export function buildCmuxBrowserClickArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "click", "--selector", nonemptyString(input, "target", "target", MAX_TARGET_CHARS), "--snapshot-after"];
}

export function buildCmuxBrowserFillArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "fill", "--selector", nonemptyString(input, "target", "target", MAX_TARGET_CHARS), "--text", stringValue(input, "text", "text", MAX_TEXT_CHARS), "--snapshot-after"];
}

function executeBuiltArgs(build: () => string[] | { args: string[]; timeoutMs: number }, options: CmuxToolOptions): ToolResult {
	try {
		const built = build();
		if (Array.isArray(built)) return runCmuxCommand(built, options);
		return runCmuxCommand(built.args, { ...options, timeoutMs: Math.min(MAX_COMMAND_TIMEOUT_MS, built.timeoutMs + 5_000) });
	} catch (error) {
		return toolResult(false, { error: error instanceof Error ? error.message : String(error) });
	}
}

export function buildCmuxBrowserToolSpecs(options: CmuxToolOptions = {}): ToolSpec[] {
	return [
		{
			name: "cmux_browser_open",
			label: "cmux browser open",
			description: "Open a native cmux browser surface for an http(s) URL without shell interpolation.",
			parameters: schema({ url: str("Absolute http(s) URL to open", MAX_URL_CHARS), workspace: str("Optional cmux workspace ref or UUID", 128), window: str("Optional cmux window ref or UUID", 128), focus: bool("Whether cmux should focus the new browser surface") }, ["url"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserOpenArgs(input), options),
		},
		{
			name: "cmux_browser_get_url",
			label: "cmux browser get URL",
			description: "Return the current URL for an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserGetUrlArgs(input), options),
		},
		{
			name: "cmux_browser_snapshot",
			label: "cmux browser snapshot",
			description: "Capture an interactive accessibility snapshot for an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), selector: str("Optional CSS selector/ref to scope the snapshot", MAX_TARGET_CHARS), compact: bool("Request compact snapshot output"), maxDepth: integer("Maximum snapshot depth", 1, 20) }, ["surface"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserSnapshotArgs(input), options),
		},
		{
			name: "cmux_browser_wait",
			label: "cmux browser wait",
			description: "Wait for load state, selector, text, or URL condition on an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), loadState: str("interactive or complete", 16), selector: str("Optional CSS selector/ref", MAX_TARGET_CHARS), text: str("Optional visible text", MAX_TEXT_CHARS), url: str("Optional exact URL", MAX_URL_CHARS), urlContains: str("Optional URL substring", MAX_URL_CHARS), timeoutMs: integer("Timeout in milliseconds", 100, MAX_WAIT_TIMEOUT_MS) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserWaitArgs(input), options),
		},
		{
			name: "cmux_browser_click",
			label: "cmux browser click",
			description: "Click an element ref/selector on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), target: str("Element ref or CSS selector", MAX_TARGET_CHARS) }, ["surface", "target"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserClickArgs(input), options),
		},
		{
			name: "cmux_browser_fill",
			label: "cmux browser fill",
			description: "Fill an element ref/selector on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), target: str("Element ref or CSS selector", MAX_TARGET_CHARS), text: str("Text to fill", MAX_TEXT_CHARS) }, ["surface", "target", "text"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserFillArgs(input), options),
		},
	];
}

export default function cmuxBrowserTools(pi: PiApi): void {
	pi.setLabel?.("cmux browser tools");
	for (const tool of buildCmuxBrowserToolSpecs()) pi.registerTool?.(tool);
}
