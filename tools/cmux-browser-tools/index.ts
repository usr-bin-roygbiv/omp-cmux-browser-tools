import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

import { buildCmuxBrowserToolSpecs, type CmuxRunner, type ToolInput } from "../../extensions/index";

type ZodStringLike = {
	max(value: number): ZodStringLike;
	describe(value: string): ZodStringLike;
	optional(): ZodStringLike;
};

type ZodNumberLike = {
	int(): ZodNumberLike;
	min(value: number): ZodNumberLike;
	max(value: number): ZodNumberLike;
	describe(value: string): ZodNumberLike;
	optional(): ZodNumberLike;
};

type ZodBooleanLike = {
	describe(value: string): ZodBooleanLike;
	optional(): ZodBooleanLike;
};

type ZodObjectLike = {
	strict(): ZodObjectLike;
};

type ZodApi = {
	string(): ZodStringLike;
	number(): ZodNumberLike;
	boolean(): ZodBooleanLike;
	object(shape: Record<string, unknown>): ZodObjectLike;
};

type CmuxBrowserCustomToolApi = {
	zod: ZodApi;
};

type CmuxBrowserCustomToolOptions = {
	env?: Record<string, string | undefined>;
	runner?: CmuxRunner;
};

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
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_FIND_INDEX = 1_000;
const MAX_SCROLL_DELTA = 5_000;
const MAX_HELP_COMMAND_CHARS = 128;

function requiredString(zod: ZodApi, description: string, maxLength: number): ZodStringLike {
	return zod.string().max(maxLength).describe(description);
}

function optionalString(zod: ZodApi, description: string, maxLength: number): ZodStringLike {
	return requiredString(zod, description, maxLength).optional();
}

function optionalBoolean(zod: ZodApi, description: string): ZodBooleanLike {
	return zod.boolean().describe(description).optional();
}

function optionalInteger(zod: ZodApi, description: string, min: number, max: number): ZodNumberLike {
	return zod.number().int().min(min).max(max).describe(description).optional();
}

function schemaForTool(zod: ZodApi, name: string): ZodObjectLike {
	switch (name) {
		case "cmux_help":
			return zod.object({
				command: optionalString(zod, "Optional cmux command or subcommand path, such as browser or browser wait", MAX_HELP_COMMAND_CHARS),
			}).strict();
		case "cmux_identify":
			return zod.object({
				workspace: optionalString(zod, "Optional cmux workspace ref or UUID", 128),
				surface: optionalString(zod, "Optional cmux surface ref or UUID", 128),
				window: optionalString(zod, "Optional cmux window ref or UUID", 128),
				noCaller: optionalBoolean(zod, "Omit caller metadata where cmux supports it"),
			}).strict();
		case "cmux_workspace_new":
			return zod.object({
				name: optionalString(zod, "Optional workspace title", MAX_NAME_CHARS),
				description: optionalString(zod, "Optional workspace description", MAX_DESCRIPTION_CHARS),
				cwd: optionalString(zod, "Optional working directory", MAX_CWD_CHARS),
				command: optionalString(zod, "Optional command text sent to the new terminal", MAX_COMMAND_CHARS),
				layout: optionalString(zod, "Optional cmux layout JSON", MAX_LAYOUT_CHARS),
				window: optionalString(zod, "Optional target window ref or UUID", 128),
				focus: optionalBoolean(zod, "Whether cmux should focus the new workspace"),
			}).strict();
		case "cmux_workspace_tree":
			return zod.object({
				all: optionalBoolean(zod, "Include all windows"),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
			}).strict();
		case "cmux_workspace_close":
			return zod.object({
				workspace: requiredString(zod, "Workspace ref or UUID to close", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
			}).strict();
		case "cmux_surface_new":
			return zod.object({
				type: optionalString(zod, "terminal or browser", 16),
				pane: optionalString(zod, "Optional pane ref or UUID", 128),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
				url: optionalString(zod, "Optional http(s) URL for browser surfaces", MAX_URL_CHARS),
				focus: optionalBoolean(zod, "Whether cmux should focus the new surface"),
			}).strict();
		case "cmux_surface_close":
			return zod.object({
				surface: requiredString(zod, "Surface ref or UUID to close", 128),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
			}).strict();
		case "cmux_surface_read":
			return zod.object({
				surface: requiredString(zod, "Terminal surface ref or UUID", 128),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
				scrollback: optionalBoolean(zod, "Include scrollback"),
				lines: optionalInteger(zod, "Maximum lines to return", 1, MAX_LINES),
			}).strict();
		case "cmux_terminal_open":
			return zod.object({
				name: optionalString(zod, "Optional workspace title", MAX_NAME_CHARS),
				cwd: optionalString(zod, "Optional working directory", MAX_CWD_CHARS),
				command: optionalString(zod, "Optional command text sent to the terminal", MAX_COMMAND_CHARS),
				window: optionalString(zod, "Optional target window ref or UUID", 128),
				focus: optionalBoolean(zod, "Whether cmux should focus the terminal"),
			}).strict();
		case "cmux_terminal_send":
			return zod.object({
				surface: requiredString(zod, "Terminal surface ref or UUID", 128),
				text: requiredString(zod, "Text to send", MAX_TEXT_CHARS),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
				enter: optionalBoolean(zod, "Append Enter when text does not already end with newline"),
			}).strict();
		case "cmux_sidebar_state":
			return zod.object({
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
			}).strict();
		case "cmux_notifications_list":
			return zod.object({}).strict();
		case "cmux_notification_dismiss":
			return zod.object({
				id: optionalString(zod, "Notification UUID", MAX_NOTIFICATION_ID_CHARS),
				allRead: optionalBoolean(zod, "Dismiss all read notifications instead of one id"),
			}).strict();
		case "cmux_surface_resume_show":
		case "cmux_surface_resume_clear":
			return zod.object({
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				surface: optionalString(zod, "Optional surface ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
			}).strict();
		case "cmux_config_check":
			return zod.object({
				path: optionalString(zod, "Optional config path", MAX_MARKDOWN_PATH_CHARS),
			}).strict();
		case "cmux_reload_config":
			return zod.object({}).strict();
		case "cmux_markdown_open":
		case "cmux_markdown_preview":
			return zod.object({
				path: requiredString(zod, "Markdown file path", MAX_MARKDOWN_PATH_CHARS),
				workspace: optionalString(zod, "Optional workspace ref or UUID", 128),
				surface: optionalString(zod, "Optional source surface ref or UUID", 128),
				window: optionalString(zod, "Optional window ref or UUID", 128),
				direction: optionalString(zod, "left, right, up, or down", 16),
				focus: optionalBoolean(zod, "Whether cmux should focus the markdown panel"),
			}).strict();
		case "cmux_browser_open":
			return zod.object({
				url: requiredString(zod, "Absolute http(s) URL to open", MAX_URL_CHARS),
				workspace: optionalString(zod, "Optional cmux workspace ref or UUID", 128),
				window: optionalString(zod, "Optional cmux window ref or UUID", 128),
				focus: optionalBoolean(zod, "Whether cmux should focus the new browser surface"),
			}).strict();
		case "cmux_browser_get_url":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
			}).strict();
		case "cmux_browser_goto":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				url: requiredString(zod, "Absolute http(s) URL to navigate to", MAX_URL_CHARS),
			}).strict();
		case "cmux_browser_back":
		case "cmux_browser_forward":
		case "cmux_browser_reload":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
			}).strict();
		case "cmux_browser_snapshot":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				selector: optionalString(zod, "Optional CSS selector/ref to scope the snapshot", MAX_TARGET_CHARS),
				compact: optionalBoolean(zod, "Request compact snapshot output"),
				maxDepth: optionalInteger(zod, "Maximum snapshot depth", 1, 20),
			}).strict();
		case "cmux_browser_wait":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				loadState: optionalString(zod, "interactive or complete", 16),
				selector: optionalString(zod, "Optional CSS selector/ref", MAX_TARGET_CHARS),
				text: optionalString(zod, "Optional visible text", MAX_TEXT_CHARS),
				url: optionalString(zod, "Optional exact URL", MAX_URL_CHARS),
				urlContains: optionalString(zod, "Optional URL substring", MAX_URL_CHARS),
				timeoutMs: optionalInteger(zod, "Timeout in milliseconds", 100, MAX_WAIT_TIMEOUT_MS),
			}).strict();
		case "cmux_browser_find":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				kind: requiredString(zod, "Find kind", 16),
				text: optionalString(zod, "Text/label/placeholder/alt/title/testid query", MAX_TEXT_CHARS),
				role: optionalString(zod, "ARIA role for role queries", MAX_ATTR_CHARS),
				name: optionalString(zod, "Optional accessible name for role queries", MAX_TEXT_CHARS),
				selector: optionalString(zod, "CSS selector for first/last/nth queries", MAX_TARGET_CHARS),
				index: optionalInteger(zod, "Zero-based nth index", 0, MAX_FIND_INDEX),
				exact: optionalBoolean(zod, "Request exact matching where cmux supports it"),
			}).strict();
		case "cmux_browser_get":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				kind: requiredString(zod, "Get kind", 16),
				selector: optionalString(zod, "Optional CSS selector", MAX_TARGET_CHARS),
				attrName: optionalString(zod, "Attribute name for attr reads", MAX_ATTR_CHARS),
				propertyName: optionalString(zod, "CSS property name for styles reads", MAX_ATTR_CHARS),
			}).strict();
		case "cmux_browser_is":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				kind: requiredString(zod, "visible, enabled, or checked", 16),
				selector: requiredString(zod, "CSS selector to inspect", MAX_TARGET_CHARS),
			}).strict();
		case "cmux_browser_click":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				target: requiredString(zod, "Element ref or CSS selector", MAX_TARGET_CHARS),
			}).strict();
		case "cmux_browser_fill":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				target: requiredString(zod, "Element ref or CSS selector", MAX_TARGET_CHARS),
				text: requiredString(zod, "Text to fill", MAX_TEXT_CHARS),
			}).strict();
		case "cmux_browser_press":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				key: requiredString(zod, "Keyboard key such as Enter, Tab, Escape, or ArrowDown", MAX_KEY_CHARS),
			}).strict();
		case "cmux_browser_select":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				selector: requiredString(zod, "CSS selector for the select control", MAX_TARGET_CHARS),
				value: requiredString(zod, "Option value to select", MAX_TEXT_CHARS),
			}).strict();
		case "cmux_browser_scroll":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				selector: optionalString(zod, "Optional CSS selector to scroll", MAX_TARGET_CHARS),
				dx: optionalInteger(zod, "Horizontal scroll delta", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
				dy: optionalInteger(zod, "Vertical scroll delta", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
			}).strict();
		case "cmux_browser_screenshot":
			return zod.object({
				surface: requiredString(zod, "cmux browser surface ref or UUID", 128),
				outPath: optionalString(zod, "Optional relative path under _artifacts-local/omp-cmux-browser-tools-eval", MAX_SCREENSHOT_PATH_CHARS),
			}).strict();
		default:
			throw new Error(`Unknown cmux tool: ${name}`);
	}
}

export function buildCmuxBrowserCustomTools(api: CmuxBrowserCustomToolApi, options: CmuxBrowserCustomToolOptions = {}) {
	return buildCmuxBrowserToolSpecs(options).map(spec => ({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		strict: true,
		parameters: schemaForTool(api.zod, spec.name),
		execute: async (toolCallId: string, params: ToolInput) => spec.execute(toolCallId, params),
	}));
}

const factory: CustomToolFactory = api => buildCmuxBrowserCustomTools(api as CmuxBrowserCustomToolApi);

export default factory;
