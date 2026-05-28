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
const MAX_WAIT_TIMEOUT_MS = 60_000;

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
		default:
			throw new Error(`Unknown cmux browser tool: ${name}`);
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
