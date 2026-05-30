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
import { mkdirSync } from "node:fs";
import * as path from "node:path";

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
const DEFAULT_OPEN_SETTLE_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_URL_CHARS = 2_048;
const MAX_TARGET_CHARS = 1_024;
const MAX_TEXT_CHARS = 4_000;
const MAX_KEY_CHARS = 64;
const MAX_ATTR_CHARS = 128;
const MAX_SCREENSHOT_PATH_CHARS = 512;
const MAX_MARKDOWN_PATH_CHARS = 512;
const MAX_CWD_CHARS = 512;
const MAX_COMMAND_CHARS = 2_048;
const MAX_LAYOUT_CHARS = 8_192;
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_NOTIFICATION_ID_CHARS = 128;
const MAX_LINES = 500;
const MAX_SCROLL_DELTA = 5_000;
const MAX_FIND_INDEX = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^surface:\d+$/;
const WORKSPACE_RE = /^workspace:\d+$/;
const WINDOW_RE = /^window:\d+$/;
const PANE_RE = /^pane:\d+$/;
const LOAD_STATES = new Set(["interactive", "complete"]);
const FIND_KINDS = new Set(["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"]);
const TEXT_FIND_KINDS = new Set(["text", "label", "placeholder", "alt", "title", "testid"]);
const GET_KINDS = new Set(["url", "title", "text", "html", "value", "attr", "count", "box", "styles"]);
const IS_KINDS = new Set(["visible", "enabled", "checked"]);
const MAX_HELP_COMMAND_CHARS = 128;
const HELP_COMMAND_TOKEN_RE = /^[a-z][a-z0-9_-]*$/;

const CMUX_HELP_PREAMBLE = `cmux commands by category:

Terminal I/O:
  read-screen   Capture terminal screen content
  send          Send text input to a pane
  send-key      Send a key sequence to a pane

Layout:
  tree, list-workspaces, list-panes
  new-workspace, new-pane, new-split, close-surface

Notifications and sidebar:
  notify, set-status, clear-status, list-status

Browser automation:
  browser open/goto/back/forward/reload/url
  browser snapshot/screenshot
  browser click/fill/press/select/scroll
  browser wait/find/get/is

Markdown:
  markdown open

Session info:
  identify, info, capabilities

Call cmux_help with command "browser" or "browser wait" for detailed syntax. cmux_help is reference-only; this plugin executes only the registered cmux_* tools, not arbitrary cmux commands. Most browser subcommands accept --surface <id>, and action commands accept --snapshot-after.`;

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

type CmuxRefKind = "surface" | "workspace" | "window" | "pane";

function validateRef(value: string, kind: CmuxRefKind): string {
	const prefixed = kind === "surface" ? SURFACE_RE : kind === "workspace" ? WORKSPACE_RE : kind === "window" ? WINDOW_RE : PANE_RE;
	if (prefixed.test(value) || UUID_RE.test(value)) return value;
	throw new Error(kind + " must be " + kind + ":<number> or a UUID");
}

function optionalRef(input: ToolInput, key: CmuxRefKind, args: string[]): void {
	const value = stringInput(input, key);
	if (!value) return;
	args.push("--" + key, validateRef(value, key));
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

function workspaceInput(input: ToolInput): string {
	return validateRef(nonemptyString(input, "workspace", "workspace", 128), "workspace");
}

function notificationIdInput(input: ToolInput): string {
	const value = nonemptyString(input, "id", "id", MAX_NOTIFICATION_ID_CHARS);
	if (!UUID_RE.test(value)) throw new Error("id must be a notification UUID");
	return value;
}

function safePathInput(input: ToolInput, key: string, label: string, maxLength: number): string {
	const value = nonemptyString(input, key, label, maxLength);
	if (/[\0\r\n]/.test(value)) throw new Error(label + " must not contain control characters");
	return value;
}

function optionalSafePath(input: ToolInput, key: string, label: string, maxLength: number): string | undefined {
	const value = optionalBoundedString(input, key, label, maxLength);
	if (!value) return undefined;
	if (/[\0\r\n]/.test(value)) throw new Error(label + " must not contain control characters");
	return value;
}

function optionalSafeText(input: ToolInput, key: string, label: string, maxLength: number): string | undefined {
	const value = optionalBoundedString(input, key, label, maxLength);
	if (value === undefined) return undefined;
	if (/[\0]/.test(value)) throw new Error(label + " must not contain NUL bytes");
	return value;
}

function waitTimeoutMs(input: ToolInput): number {
	const seconds = input.timeoutSeconds === undefined ? undefined : Number(input.timeoutSeconds) * 1000;
	return clampInt(input.timeoutMs ?? seconds, DEFAULT_WAIT_TIMEOUT_MS, 100, MAX_WAIT_TIMEOUT_MS);
}
function enumInput(input: ToolInput, key: string, label: string, allowed: Set<string>, maxLength = 64): string {
	const value = nonemptyString(input, key, label, maxLength);
	if (!allowed.has(value)) throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
	return value;
}

function optionalBoundedString(input: ToolInput, key: string, label: string, maxLength: number): string | undefined {
	const value = stringInput(input, key);
	if (value === undefined) return undefined;
	return nonemptyString(input, key, label, maxLength);
}

function attrNameInput(input: ToolInput, key: string, label: string): string {
	const value = nonemptyString(input, key, label, MAX_ATTR_CHARS);
	if (!/^[A-Za-z_:-][A-Za-z0-9_.:-]*$/.test(value)) throw new Error(`${label} must be a bounded attribute/property name`);
	return value;
}

function keyInput(input: ToolInput): string {
	const value = nonemptyString(input, "key", "key", MAX_KEY_CHARS);
	if (/[\0\r\n]/.test(value)) throw new Error("key must not contain control characters");
	return value;
}

function signedIntInput(input: ToolInput, key: string): number | undefined {
	const value = input[key];
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^[+-]?\d+$/.test(value)) return Number(value);
	return undefined;
}

function indexInput(input: ToolInput): number {
	const index = signedIntInput(input, "index");
	if (index === undefined) throw new Error("index is required");
	if (index < 0 || index > MAX_FIND_INDEX) throw new Error(`index must be between 0 and ${MAX_FIND_INDEX}`);
	return index;
}

function scrollDeltaInput(input: ToolInput, key: "dx" | "dy"): number | undefined {
	const delta = signedIntInput(input, key);
	if (delta === undefined) return undefined;
	if (delta < -MAX_SCROLL_DELTA || delta > MAX_SCROLL_DELTA) throw new Error(`${key} must be between -${MAX_SCROLL_DELTA} and ${MAX_SCROLL_DELTA}`);
	return delta;
}

function workspaceArtifactRoot(): string {
	const cwd = process.cwd();
	const base = path.basename(cwd) === "omp-cmux-browser-tools" ? path.dirname(cwd) : cwd;
	return path.resolve(base, "_artifacts-local", "omp-cmux-browser-tools-eval");
}

function isInsidePath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function screenshotOutPath(input: ToolInput): string {
	const root = workspaceArtifactRoot();
	const workspaceRoot = path.dirname(path.dirname(root));
	const provided = stringInput(input, "outPath");
	const raw = provided === undefined || provided.trim() === "" ? `screenshots/cmux-browser-${Date.now()}.png` : provided;
	if (raw.length > MAX_SCREENSHOT_PATH_CHARS) throw new Error("outPath is too long");
	if (/[\0\r\n]/.test(raw)) throw new Error("outPath must not contain control characters");
	const normalized = raw.replace(/\\/g, "/");
	const artifactPrefix = "_artifacts-local/omp-cmux-browser-tools-eval";
	const candidate = path.isAbsolute(normalized)
		? path.resolve(normalized)
		: normalized === artifactPrefix || normalized.startsWith(`${artifactPrefix}/`)
			? path.resolve(workspaceRoot, normalized)
			: path.resolve(root, normalized);
	if (!isInsidePath(root, candidate)) throw new Error("outPath must resolve inside _artifacts-local/omp-cmux-browser-tools-eval");
	mkdirSync(path.dirname(candidate), { recursive: true });
	return candidate;
}

function argAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
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

export function buildCmuxHelpArgs(input: ToolInput): string[] {
	const command = stringInput(input, "command");
	if (command === undefined || command.trim() === "") return ["help"];
	if (command.length > MAX_HELP_COMMAND_CHARS) throw new Error("command is too long");
	const tokens = command.trim().split(/\s+/);
	if (tokens.length > 4) throw new Error("command must contain at most four cmux command tokens");
	for (const token of tokens) {
		if (!HELP_COMMAND_TOKEN_RE.test(token)) throw new Error("command must contain only cmux command tokens");
	}
	return [...tokens, "--help"];
}

export function runCmuxTextCommand(args: string[], options: CmuxToolOptions & { timeoutMs?: number; preamble?: string } = {}): ToolResult {
	const timeoutMs = clampInt(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 100, MAX_COMMAND_TIMEOUT_MS);
	const runner = options.runner ?? defaultRunner;
	try {
		const result = runner("cmux", args, { env: options.env ?? process.env, timeoutMs });
		const stdout = sanitizeToolText(String(result.stdout ?? ""));
		const stderr = sanitizeToolText(String(result.stderr ?? ""));
		const ok = result.status === 0 && !result.error;
		const details = {
			command: "cmux",
			args,
			exitCode: result.status,
			stdout,
			stderr,
			...(result.error ? { error: result.error.message } : {}),
		};
		const text = [options.preamble, stdout, stderr].filter(Boolean).join("\n\n");
		return toolResult(ok, details, text);
	} catch (error) {
		return toolResult(false, { command: "cmux", args, error: error instanceof Error ? error.message : String(error) });
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
	if (stringInput(input, "function") !== undefined) throw new Error("JavaScript wait functions are not exposed");
	if (args[4] === undefined) args.push("--load-state", "complete");
	args.push("--timeout-ms", String(timeoutMs));
	return { args, timeoutMs };
}

export function buildCmuxBrowserGotoArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "goto", httpUrl(input), "--snapshot-after"];
}

export function buildCmuxBrowserBackArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "back", "--snapshot-after"];
}

export function buildCmuxBrowserForwardArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "forward", "--snapshot-after"];
}

export function buildCmuxBrowserReloadArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "reload", "--snapshot-after"];
}

export function buildCmuxBrowserClickArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "click", "--selector", nonemptyString(input, "target", "target", MAX_TARGET_CHARS), "--snapshot-after"];
}

export function buildCmuxBrowserFillArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "fill", "--selector", nonemptyString(input, "target", "target", MAX_TARGET_CHARS), "--text", stringValue(input, "text", "text", MAX_TEXT_CHARS), "--snapshot-after"];
}

export function buildCmuxBrowserFindArgs(input: ToolInput): string[] {
	const kind = enumInput(input, "kind", "find kind", FIND_KINDS);
	const args = ["browser", "--surface", surfaceInput(input), "find", kind];
	if (kind === "role") {
		const name = optionalBoundedString(input, "name", "name", MAX_TEXT_CHARS);
		if (name !== undefined) args.push("--name", name);
		if (boolInput(input, "exact")) args.push("--exact");
		args.push(nonemptyString(input, "role", "role", MAX_ATTR_CHARS));
		return args;
	}
	if (TEXT_FIND_KINDS.has(kind)) {
		if (boolInput(input, "exact")) args.push("--exact");
		args.push(nonemptyString(input, "text", "text", MAX_TEXT_CHARS));
		return args;
	}
	if (kind === "first" || kind === "last") {
		args.push("--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS));
		return args;
	}
	args.push("--index", String(indexInput(input)), "--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS));
	return args;
}

export function buildCmuxBrowserGetArgs(input: ToolInput): string[] {
	const kind = enumInput(input, "kind", "get kind", GET_KINDS);
	const args = ["browser", "--surface", surfaceInput(input), "get", kind];
	if ((kind === "url" || kind === "title") && stringInput(input, "selector") !== undefined) throw new Error(`${kind} get kind does not accept selector`);
	const selector = optionalBoundedString(input, "selector", "selector", MAX_TARGET_CHARS);
	if (selector !== undefined) args.push("--selector", selector);
	if (kind === "attr") args.push("--attr", attrNameInput(input, "attrName", "attrName"));
	const propertyName = optionalBoundedString(input, "propertyName", "propertyName", MAX_ATTR_CHARS);
	if (propertyName !== undefined) args.push("--property", attrNameInput(input, "propertyName", "propertyName"));
	return args;
}

export function buildCmuxBrowserIsArgs(input: ToolInput): string[] {
	const kind = enumInput(input, "kind", "is kind", IS_KINDS);
	return ["browser", "--surface", surfaceInput(input), "is", kind, "--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS)];
}

export function buildCmuxBrowserPressArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "press", "--key", keyInput(input), "--snapshot-after"];
}

export function buildCmuxBrowserSelectArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "select", "--selector", nonemptyString(input, "selector", "selector", MAX_TARGET_CHARS), "--value", stringValue(input, "value", "value", MAX_TEXT_CHARS), "--snapshot-after"];
}

export function buildCmuxBrowserScrollArgs(input: ToolInput): string[] {
	const dx = scrollDeltaInput(input, "dx");
	const dy = scrollDeltaInput(input, "dy");
	if (dx === undefined && dy === undefined) throw new Error("dx or dy is required");
	if ((dx ?? 0) === 0 && (dy ?? 0) === 0) throw new Error("dx or dy must be non-zero");
	const args = ["browser", "--surface", surfaceInput(input), "scroll"];
	const selector = optionalBoundedString(input, "selector", "selector", MAX_TARGET_CHARS);
	if (selector !== undefined) args.push("--selector", selector);
	if (dx !== undefined) args.push("--dx", String(dx));
	if (dy !== undefined) args.push("--dy", String(dy));
	args.push("--snapshot-after");
	return args;
}

export function buildCmuxBrowserScreenshotArgs(input: ToolInput): string[] {
	return ["browser", "--surface", surfaceInput(input), "screenshot", "--out", screenshotOutPath(input)];
}


export function buildCmuxIdentifyArgs(input: ToolInput): string[] {
	const args = ["identify"];
	optionalRef(input, "workspace", args);
	optionalRef(input, "surface", args);
	optionalRef(input, "window", args);
	if (boolInput(input, "noCaller") === true) args.push("--no-caller");
	return args;
}

export function buildCmuxWorkspaceNewArgs(input: ToolInput): string[] {
	const args = ["new-workspace"];
	const name = optionalSafeText(input, "name", "name", MAX_NAME_CHARS);
	const description = optionalSafeText(input, "description", "description", MAX_DESCRIPTION_CHARS);
	const cwd = optionalSafePath(input, "cwd", "cwd", MAX_CWD_CHARS);
	const command = optionalSafeText(input, "command", "command", MAX_COMMAND_CHARS);
	const layout = optionalSafeText(input, "layout", "layout", MAX_LAYOUT_CHARS);
	if (layout !== undefined) {
		try { JSON.parse(layout); } catch { throw new Error("layout must be valid JSON"); }
	}
	if (name !== undefined) args.push("--name", name);
	if (description !== undefined) args.push("--description", description);
	if (cwd !== undefined) args.push("--cwd", cwd);
	if (command !== undefined) args.push("--command", command);
	if (layout !== undefined) args.push("--layout", layout);
	optionalRef(input, "window", args);
	args.push("--focus", boolInput(input, "focus") === true ? "true" : "false");
	return args;
}

export function buildCmuxWorkspaceTreeArgs(input: ToolInput): string[] {
	const args = ["tree", "--json"];
	if (boolInput(input, "all") === true) args.push("--all");
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxWorkspaceCloseArgs(input: ToolInput): string[] {
	const args = ["close-workspace", "--workspace", workspaceInput(input)];
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxSurfaceNewArgs(input: ToolInput): string[] {
	const rawType = optionalBoundedString(input, "type", "type", 16) ?? "terminal";
	if (rawType !== "terminal" && rawType !== "browser") throw new Error("type must be terminal or browser");
	const args = ["new-surface", "--type", rawType];
	optionalRef(input, "pane", args);
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	if (rawType === "browser") {
		const url = stringInput(input, "url");
		if (url !== undefined && url.trim() !== "") args.push("--url", httpUrl(input));
	}
	args.push("--focus", boolInput(input, "focus") === true ? "true" : "false");
	return args;
}

export function buildCmuxSurfaceCloseArgs(input: ToolInput): string[] {
	const args = ["close-surface", "--surface", surfaceInput(input)];
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxSurfaceReadArgs(input: ToolInput): string[] {
	const args = ["read-screen", "--surface", surfaceInput(input), "--lines", String(clampInt(input.lines, 120, 1, MAX_LINES))];
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	if (boolInput(input, "scrollback") === true) args.push("--scrollback");
	return args;
}

export function buildCmuxTerminalOpenArgs(input: ToolInput): string[] {
	const args = ["new-workspace"];
	const name = optionalSafeText(input, "name", "name", MAX_NAME_CHARS) ?? "OMP terminal";
	args.push("--name", name);
	const cwd = optionalSafePath(input, "cwd", "cwd", MAX_CWD_CHARS);
	const command = optionalSafeText(input, "command", "command", MAX_COMMAND_CHARS);
	if (cwd !== undefined) args.push("--cwd", cwd);
	if (command !== undefined) args.push("--command", command);
	optionalRef(input, "window", args);
	args.push("--focus", boolInput(input, "focus") === true ? "true" : "false");
	return args;
}

export function buildCmuxTerminalSendArgs(input: ToolInput): string[] {
	let text = stringValue(input, "text", "text", MAX_TEXT_CHARS);
	if (boolInput(input, "enter") === true && !text.endsWith("\n")) text += "\n";
	const args = ["send", "--surface", surfaceInput(input)];
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	args.push("--", text);
	return args;
}

export function buildCmuxSidebarStateArgs(input: ToolInput): string[] {
	const args = ["sidebar-state"];
	optionalRef(input, "workspace", args);
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxNotificationsListArgs(_input: ToolInput): string[] {
	return ["list-notifications"];
}

export function buildCmuxNotificationDismissArgs(input: ToolInput): string[] {
	if (boolInput(input, "allRead") === true) return ["dismiss-notification", "--all-read"];
	return ["dismiss-notification", "--id", notificationIdInput(input)];
}

export function buildCmuxSurfaceResumeShowArgs(input: ToolInput): string[] {
	const args = ["surface", "resume", "show", "--json"];
	optionalRef(input, "workspace", args);
	optionalRef(input, "surface", args);
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxSurfaceResumeClearArgs(input: ToolInput): string[] {
	const args = ["surface", "resume", "clear"];
	optionalRef(input, "workspace", args);
	optionalRef(input, "surface", args);
	optionalRef(input, "window", args);
	return args;
}

export function buildCmuxConfigCheckArgs(input: ToolInput): string[] {
	const args = ["config", "check"];
	const configPath = optionalSafePath(input, "path", "path", MAX_MARKDOWN_PATH_CHARS);
	if (configPath !== undefined) args.push("--path", configPath);
	return args;
}

export function buildCmuxReloadConfigArgs(_input: ToolInput): string[] {
	return ["reload-config"];
}

export function buildCmuxMarkdownOpenArgs(input: ToolInput): string[] {
	const args = ["markdown", "open", safePathInput(input, "path", "path", MAX_MARKDOWN_PATH_CHARS)];
	optionalRef(input, "workspace", args);
	optionalRef(input, "surface", args);
	optionalRef(input, "window", args);
	const direction = optionalBoundedString(input, "direction", "direction", 16);
	if (direction !== undefined) {
		if (!["left", "right", "up", "down"].includes(direction)) throw new Error("direction must be left, right, up, or down");
		args.push("--direction", direction);
	}
	args.push("--focus", boolInput(input, "focus") === true ? "true" : "false");
	return args;
}

type BuiltCommand = string[] | { args: string[]; timeoutMs?: number };

function executeBuiltArgs(build: () => BuiltCommand, options: CmuxToolOptions, extraDetails?: (args: string[]) => JsonObject): ToolResult {
	try {
		const built = build();
		const args = Array.isArray(built) ? built : built.args;
		const timeoutMs = Array.isArray(built) || built.timeoutMs === undefined ? undefined : Math.min(MAX_COMMAND_TIMEOUT_MS, built.timeoutMs + 5_000);
		const result = runCmuxCommand(args, timeoutMs === undefined ? options : { ...options, timeoutMs });
		if (!extraDetails) return result;
		return { ...result, details: { ...result.details, ...extraDetails(args) } };
	} catch (error) {
		return toolResult(false, { error: error instanceof Error ? error.message : String(error) });
	}
}

function settleAfterBrowserOpen(options: CmuxToolOptions): void {
	if (options.runner) return;
	const delayMs = clampInt(process.env.CMUX_BROWSER_OPEN_SETTLE_MS, DEFAULT_OPEN_SETTLE_MS, 0, 10_000);
	if (delayMs <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function buildCmuxBrowserToolSpecs(options: CmuxToolOptions = {}): ToolSpec[] {
	return [
		{
			name: "cmux_help",
			label: "cmux help",
			description: "Look up cmux CLI reference for terminal I/O, layout, browser automation, notifications, markdown, and session commands. Call this before using unfamiliar cmux commands.",
			parameters: schema({ command: str("Optional cmux command or subcommand path, such as browser or browser wait", MAX_HELP_COMMAND_CHARS) }),
			scopes: ["cmux", "read-only"],
			execute: async (_toolCallId, input) => {
				try {
					const args = buildCmuxHelpArgs(input);
					return runCmuxTextCommand(args, { ...options, preamble: args.length === 1 && args[0] === "help" ? CMUX_HELP_PREAMBLE : undefined });
				} catch (error) {
					return toolResult(false, { error: error instanceof Error ? error.message : String(error) });
				}
			},
		},
		{
			name: "cmux_identify",
			label: "cmux identify",
			description: "Identify the caller and focused cmux workspace, window, pane, and surface refs.",
			parameters: schema({ workspace: str("Optional cmux workspace ref or UUID", 128), surface: str("Optional cmux surface ref or UUID", 128), window: str("Optional cmux window ref or UUID", 128), noCaller: bool("Omit caller metadata where cmux supports it") }),
			scopes: ["cmux", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxIdentifyArgs(input), options),
		},
		{
			name: "cmux_workspace_new",
			label: "cmux workspace new",
			description: "Create a named cmux workspace with optional cwd, layout, or terminal command; focus is false unless explicitly requested.",
			parameters: schema({ name: str("Optional workspace title", MAX_NAME_CHARS), description: str("Optional workspace description", MAX_DESCRIPTION_CHARS), cwd: str("Optional working directory", MAX_CWD_CHARS), command: str("Optional command text sent to the new terminal", MAX_COMMAND_CHARS), layout: str("Optional cmux layout JSON", MAX_LAYOUT_CHARS), window: str("Optional target window ref or UUID", 128), focus: bool("Whether cmux should focus the new workspace") }),
			scopes: ["cmux", "workspace", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxWorkspaceNewArgs(input), options),
		},
		{
			name: "cmux_workspace_tree",
			label: "cmux workspace tree",
			description: "Read cmux window/workspace/pane/surface hierarchy as structured JSON where supported.",
			parameters: schema({ all: bool("Include all windows"), workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128) }),
			scopes: ["cmux", "workspace", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxWorkspaceTreeArgs(input), options),
		},
		{
			name: "cmux_workspace_close",
			label: "cmux workspace close",
			description: "Close an explicit cmux workspace. Use only for scratch workspaces you own.",
			parameters: schema({ workspace: str("Workspace ref or UUID to close", 128), window: str("Optional window ref or UUID", 128) }, ["workspace"]),
			scopes: ["cmux", "workspace", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxWorkspaceCloseArgs(input), options),
		},
		{
			name: "cmux_surface_new",
			label: "cmux surface new",
			description: "Create a terminal or browser surface in an explicit cmux pane/workspace; focus is false unless explicitly requested.",
			parameters: schema({ type: str("terminal or browser", 16), pane: str("Optional pane ref or UUID", 128), workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128), url: str("Optional http(s) URL for browser surfaces", MAX_URL_CHARS), focus: bool("Whether cmux should focus the new surface") }),
			scopes: ["cmux", "surface", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSurfaceNewArgs(input), options),
		},
		{
			name: "cmux_surface_close",
			label: "cmux surface close",
			description: "Close an explicit cmux surface. Use only for scratch surfaces you own.",
			parameters: schema({ surface: str("Surface ref or UUID to close", 128), workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "surface", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSurfaceCloseArgs(input), options),
		},
		{
			name: "cmux_surface_read",
			label: "cmux surface read",
			description: "Read bounded text from an explicit terminal surface, optionally including scrollback.",
			parameters: schema({ surface: str("Terminal surface ref or UUID", 128), workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128), scrollback: bool("Include scrollback"), lines: integer("Maximum lines to return", 1, MAX_LINES) }, ["surface"]),
			scopes: ["cmux", "surface", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSurfaceReadArgs(input), options),
		},
		{
			name: "cmux_terminal_open",
			label: "cmux terminal open",
			description: "Open an owned cmux terminal workspace, optionally sending a bounded command string; focus is false unless explicitly requested.",
			parameters: schema({ name: str("Optional workspace title", MAX_NAME_CHARS), cwd: str("Optional working directory", MAX_CWD_CHARS), command: str("Optional command text sent to the terminal", MAX_COMMAND_CHARS), window: str("Optional target window ref or UUID", 128), focus: bool("Whether cmux should focus the terminal") }),
			scopes: ["cmux", "terminal", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxTerminalOpenArgs(input), options),
		},
		{
			name: "cmux_terminal_send",
			label: "cmux terminal send",
			description: "Send bounded text to an explicit terminal surface. Use only for surfaces you own.",
			parameters: schema({ surface: str("Terminal surface ref or UUID", 128), text: str("Text to send", MAX_TEXT_CHARS), workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128), enter: bool("Append Enter when text does not already end with newline") }, ["surface", "text"]),
			scopes: ["cmux", "terminal", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxTerminalSendArgs(input), options),
		},
		{
			name: "cmux_sidebar_state",
			label: "cmux sidebar state",
			description: "Read cmux sidebar metadata for a workspace, including cwd, status, progress, and logs.",
			parameters: schema({ workspace: str("Optional workspace ref or UUID", 128), window: str("Optional window ref or UUID", 128) }),
			scopes: ["cmux", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSidebarStateArgs(input), options),
		},
		{
			name: "cmux_notifications_list",
			label: "cmux notifications list",
			description: "List queued cmux notifications with redacted text.",
			parameters: schema({}),
			scopes: ["cmux", "notifications", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxNotificationsListArgs(input), options),
		},
		{
			name: "cmux_notification_dismiss",
			label: "cmux notification dismiss",
			description: "Dismiss one notification by UUID, or all already-read notifications.",
			parameters: schema({ id: str("Notification UUID", MAX_NOTIFICATION_ID_CHARS), allRead: bool("Dismiss all read notifications instead of one id") }),
			scopes: ["cmux", "notifications", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxNotificationDismissArgs(input), options),
		},
		{
			name: "cmux_surface_resume_show",
			label: "cmux surface resume show",
			description: "Show public cmux resume metadata for an explicit or caller surface.",
			parameters: schema({ workspace: str("Optional workspace ref or UUID", 128), surface: str("Optional surface ref or UUID", 128), window: str("Optional window ref or UUID", 128) }),
			scopes: ["cmux", "resume", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSurfaceResumeShowArgs(input), options),
		},
		{
			name: "cmux_surface_resume_clear",
			label: "cmux surface resume clear",
			description: "Clear cmux resume metadata for an explicit or caller surface.",
			parameters: schema({ workspace: str("Optional workspace ref or UUID", 128), surface: str("Optional surface ref or UUID", 128), window: str("Optional window ref or UUID", 128) }),
			scopes: ["cmux", "resume", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxSurfaceResumeClearArgs(input), options),
		},
		{
			name: "cmux_config_check",
			label: "cmux config check",
			description: "Validate cmux configuration JSONC syntax without editing it.",
			parameters: schema({ path: str("Optional config path", MAX_MARKDOWN_PATH_CHARS) }),
			scopes: ["cmux", "settings", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxConfigCheckArgs(input), options),
		},
		{
			name: "cmux_reload_config",
			label: "cmux reload config",
			description: "Reload Ghostty and cmux configuration in the running app.",
			parameters: schema({}),
			scopes: ["cmux", "settings", "write"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxReloadConfigArgs(input), options),
		},
		{
			name: "cmux_markdown_open",
			label: "cmux markdown open",
			description: "Open a Markdown file in a formatted cmux viewer panel with live reload; focus is false unless explicitly requested.",
			parameters: schema({ path: str("Markdown file path", MAX_MARKDOWN_PATH_CHARS), workspace: str("Optional workspace ref or UUID", 128), surface: str("Optional source surface ref or UUID", 128), window: str("Optional window ref or UUID", 128), direction: str("left, right, up, or down", 16), focus: bool("Whether cmux should focus the markdown panel") }, ["path"]),
			scopes: ["cmux", "markdown", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxMarkdownOpenArgs(input), options),
		},
		{
			name: "cmux_markdown_preview",
			label: "cmux markdown preview",
			description: "Alias for cmux_markdown_open, kept for agents that ask to preview Markdown.",
			parameters: schema({ path: str("Markdown file path", MAX_MARKDOWN_PATH_CHARS), workspace: str("Optional workspace ref or UUID", 128), surface: str("Optional source surface ref or UUID", 128), window: str("Optional window ref or UUID", 128), direction: str("left, right, up, or down", 16), focus: bool("Whether cmux should focus the markdown panel") }, ["path"]),
			scopes: ["cmux", "markdown", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxMarkdownOpenArgs(input), options),
		},
		{
			name: "cmux_browser_open",
			label: "cmux browser open",
			description: "Open a native cmux browser surface for an http(s) URL without shell interpolation.",
			parameters: schema({ url: str("Absolute http(s) URL to open", MAX_URL_CHARS), workspace: str("Optional cmux workspace ref or UUID", 128), window: str("Optional cmux window ref or UUID", 128), focus: bool("Whether cmux should focus the new browser surface") }, ["url"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => {
				const result = executeBuiltArgs(() => buildCmuxBrowserOpenArgs(input), options);
				if (result.ok) settleAfterBrowserOpen(options);
				return result;
			},
		},
		{
			name: "cmux_browser_get_url",
			label: "cmux browser get URL",
			description: "Return the current URL for an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserGetUrlArgs(input), options, args => ({ surface: argAfter(args, "--surface") })),
		},
		{
			name: "cmux_browser_goto",
			label: "cmux browser goto",
			description: "Navigate an existing cmux browser surface to an http(s) URL and return a post-navigation snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), url: str("Absolute http(s) URL to navigate to", MAX_URL_CHARS) }, ["surface", "url"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserGotoArgs(input), options, args => ({ surface: argAfter(args, "--surface"), url: args[4] })),
		},
		{
			name: "cmux_browser_back",
			label: "cmux browser back",
			description: "Navigate an explicit cmux browser surface backward and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserBackArgs(input), options, args => ({ surface: argAfter(args, "--surface") })),
		},
		{
			name: "cmux_browser_forward",
			label: "cmux browser forward",
			description: "Navigate an explicit cmux browser surface forward and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserForwardArgs(input), options, args => ({ surface: argAfter(args, "--surface") })),
		},
		{
			name: "cmux_browser_reload",
			label: "cmux browser reload",
			description: "Reload an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserReloadArgs(input), options, args => ({ surface: argAfter(args, "--surface") })),
		},
		{
			name: "cmux_browser_snapshot",
			label: "cmux browser snapshot",
			description: "Capture an interactive accessibility snapshot for an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), selector: str("Optional CSS selector/ref to scope the snapshot", MAX_TARGET_CHARS), compact: bool("Request compact snapshot output"), maxDepth: integer("Maximum snapshot depth", 1, 20) }, ["surface"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserSnapshotArgs(input), options, args => ({ surface: argAfter(args, "--surface"), selector: argAfter(args, "--selector") })),
		},
		{
			name: "cmux_browser_wait",
			label: "cmux browser wait",
			description: "Wait for load state, selector, text, or URL on an explicit cmux browser surface.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), loadState: str("interactive or complete", 16), selector: str("Optional CSS selector/ref", MAX_TARGET_CHARS), text: str("Optional visible text", MAX_TEXT_CHARS), url: str("Optional exact URL", MAX_URL_CHARS), urlContains: str("Optional URL substring", MAX_URL_CHARS), timeoutMs: integer("Timeout in milliseconds", 100, MAX_WAIT_TIMEOUT_MS) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserWaitArgs(input), options, args => ({ surface: argAfter(args, "--surface") })),
		},
		{
			name: "cmux_browser_find",
			label: "cmux browser find",
			description: "Find elements by bounded cmux locator kinds: role, text, label, placeholder, alt, title, testid, first, last, or nth.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), kind: str("Find kind", 16), text: str("Text/label/placeholder/alt/title/testid query", MAX_TEXT_CHARS), role: str("ARIA role for role queries", MAX_ATTR_CHARS), name: str("Optional accessible name for role queries", MAX_TEXT_CHARS), selector: str("CSS selector for first/last/nth queries", MAX_TARGET_CHARS), index: integer("Zero-based nth index", 0, MAX_FIND_INDEX), exact: bool("Request exact matching where cmux supports it") }, ["surface", "kind"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserFindArgs(input), options, args => ({ surface: argAfter(args, "--surface"), kind: args[4], selector: argAfter(args, "--selector"), target: args[args.length - 1] })),
		},
		{
			name: "cmux_browser_get",
			label: "cmux browser get",
			description: "Read bounded browser state: url, title, text, html, value, attr, count, box, or styles.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), kind: str("Get kind", 16), selector: str("Optional CSS selector", MAX_TARGET_CHARS), attrName: str("Attribute name for attr reads", MAX_ATTR_CHARS), propertyName: str("CSS property name for styles reads", MAX_ATTR_CHARS) }, ["surface", "kind"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserGetArgs(input), options, args => ({ surface: argAfter(args, "--surface"), kind: args[4], selector: argAfter(args, "--selector"), attrName: argAfter(args, "--attr"), propertyName: argAfter(args, "--property") })),
		},
		{
			name: "cmux_browser_is",
			label: "cmux browser is",
			description: "Check whether an element is visible, enabled, or checked without taking a full page snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), kind: str("visible, enabled, or checked", 16), selector: str("CSS selector to inspect", MAX_TARGET_CHARS) }, ["surface", "kind", "selector"]),
			scopes: ["cmux", "browser", "read-only"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserIsArgs(input), options, args => ({ surface: argAfter(args, "--surface"), kind: args[4], selector: argAfter(args, "--selector") })),
		},
		{
			name: "cmux_browser_click",
			label: "cmux browser click",
			description: "Click an element ref/selector on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), target: str("Element ref or CSS selector", MAX_TARGET_CHARS) }, ["surface", "target"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserClickArgs(input), options, args => ({ surface: argAfter(args, "--surface"), target: argAfter(args, "--selector") })),
		},
		{
			name: "cmux_browser_fill",
			label: "cmux browser fill",
			description: "Fill an element ref/selector on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), target: str("Element ref or CSS selector", MAX_TARGET_CHARS), text: str("Text to fill", MAX_TEXT_CHARS) }, ["surface", "target", "text"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserFillArgs(input), options, args => ({ surface: argAfter(args, "--surface"), target: argAfter(args, "--selector") })),
		},
		{
			name: "cmux_browser_press",
			label: "cmux browser press",
			description: "Press a bounded keyboard key on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), key: str("Keyboard key such as Enter, Tab, Escape, or ArrowDown", MAX_KEY_CHARS) }, ["surface", "key"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserPressArgs(input), options, args => ({ surface: argAfter(args, "--surface"), key: argAfter(args, "--key") })),
		},
		{
			name: "cmux_browser_select",
			label: "cmux browser select",
			description: "Select an option value in a bounded select control on an explicit cmux browser surface and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), selector: str("CSS selector for the select control", MAX_TARGET_CHARS), value: str("Option value to select", MAX_TEXT_CHARS) }, ["surface", "selector", "value"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserSelectArgs(input), options, args => ({ surface: argAfter(args, "--surface"), selector: argAfter(args, "--selector"), value: argAfter(args, "--value") })),
		},
		{
			name: "cmux_browser_scroll",
			label: "cmux browser scroll",
			description: "Scroll an explicit cmux browser surface by small signed deltas and return a post-action snapshot.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), selector: str("Optional CSS selector to scroll", MAX_TARGET_CHARS), dx: integer("Horizontal scroll delta", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA), dy: integer("Vertical scroll delta", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA) }, ["surface"]),
			scopes: ["cmux", "browser", "visible-ui"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserScrollArgs(input), options, args => ({ surface: argAfter(args, "--surface"), selector: argAfter(args, "--selector"), dx: argAfter(args, "--dx"), dy: argAfter(args, "--dy") })),
		},
		{
			name: "cmux_browser_screenshot",
			label: "cmux browser screenshot",
			description: "Capture a browser screenshot to the owned local eval artifact directory only.",
			parameters: schema({ surface: str("cmux browser surface ref or UUID", 128), outPath: str("Optional relative path under _artifacts-local/omp-cmux-browser-tools-eval", MAX_SCREENSHOT_PATH_CHARS) }, ["surface"]),
			scopes: ["cmux", "browser", "read-only", "visual-proof"],
			execute: async (_toolCallId, input) => executeBuiltArgs(() => buildCmuxBrowserScreenshotArgs(input), options, args => ({ surface: argAfter(args, "--surface"), outPath: argAfter(args, "--out") })),
		},
	];
}

export default function cmuxBrowserTools(pi: PiApi): void {
	pi.setLabel?.("cmux browser tools");
	for (const tool of buildCmuxBrowserToolSpecs()) pi.registerTool?.(tool);
}
