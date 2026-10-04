/**
 * The `aq` built-in tool: the model writes a script, the AgiQuery app runs it.
 *
 * pi never reaches the app. The script goes out on the host's own transport and the
 * answer comes back the same way, so this tool needs no URL, no port, and no token:
 * it hands the work to whichever process is hosting it and waits.
 *
 * That also means this file holds no domain knowledge and cannot widen the script's
 * reach. What the script may touch is decided by the host, next to its own API facade,
 * and the answer is the only thing that comes back.
 *
 * It is a built-in rather than an extension so it activates the way `read` and `bash`
 * do — a host that cannot answer is the only thing that changes, and it degrades to a
 * plain failure instead of a tool the model cannot discover.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	AQ_REQUEST_TITLE,
	DEFAULT_SANDBOX_TIMEOUT_MS,
	type SandboxConsoleEntry,
	type SandboxResult,
} from "./aq-protocol.ts";
import { aqRenderers } from "./renderers/aq.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const aqSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript to run in the AgiQuery app. Top-level await and `return` are allowed: " +
			"the body runs as an async function, so `return` is how you hand a value back.",
	}),
	timeout_ms: Type.Optional(Type.Number({ description: "Execution deadline in milliseconds. Default 30000." })),
});

export const aqToolSystemPromptContribution = {
	snippet: "Run JavaScript in the AgiQuery app",
	guidelines: [
		"Use aq to read or change the open project through the app's own API facade; it is the only tool that reaches the app itself.",
		"Report only what the script actually returned, and keep console output short.",
	],
} as const;

export type AqToolInput = {
	code: string;
	timeout_ms?: number;
};

export type AqToolDetails = {
	ok: boolean;
	durationMs: number;
	console: SandboxConsoleEntry[];
	/**
	 * What the script returned, as the app reported it.
	 *
	 * The model reads the same answer from `content`; this copy is for whoever
	 * displays the call, so a renderer never has to take a return value apart out of
	 * the prose the model was sent. The app reports a script that returned nothing as
	 * `null`, which is also what a script returning `null` looks like — the same
	 * ambiguity the word result carries.
	 */
	value: unknown;
	error?: { name: string; message: string };
};

function formatConsole(entries: SandboxConsoleEntry[]): string {
	if (entries.length === 0) return "(no console output)";
	return entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
}

function failure(message: string): {
	content: { type: "text"; text: string }[];
	details: AqToolDetails;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { ok: false, durationMs: 0, console: [], value: null },
	};
}

export function createAqToolDefinition(): ToolDefinition<typeof aqSchema, AqToolDetails> {
	return {
		name: "aq",
		label: "AgiQuery script",
		description:
			"Run JavaScript in the AgiQuery app and return its result. Use this to read or change " +
			"the open project through the app's own API facade. Report only what the script actually " +
			"returned, and keep console output short.",
		promptSnippet: aqToolSystemPromptContribution.snippet,
		promptGuidelines: [...aqToolSystemPromptContribution.guidelines],
		parameters: aqSchema,
		// The script reaches the app's API facade, so it is neither read-only nor safe
		// to repeat.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		async execute(_toolCallId, params: AqToolInput, signal, _onUpdate, ctx?: ExtensionContext) {
			const timeoutMs = params.timeout_ms ?? DEFAULT_SANDBOX_TIMEOUT_MS;

			// A host that cannot answer the request returns undefined. Reporting that as a
			// failure keeps the tool usable in a plain terminal pi, where it is declared but
			// nobody is there to run anything.
			if (!ctx?.ui) {
				return failure(
					"This pi process has no AgiQuery host attached, so there is nothing to run the script in. " +
						"Continue with the file and shell tools instead.",
				);
			}

			// `timeout` makes pi resolve the call itself when the host never answers, so a
			// closed or unresponsive app cannot hang the turn.
			const answer = await ctx.ui.input(AQ_REQUEST_TITLE, JSON.stringify({ code: params.code, timeoutMs }), {
				signal,
				timeout: timeoutMs + 5_000,
			});

			if (answer === undefined) {
				return failure(
					"The AgiQuery app did not answer within the timeout, or the request was cancelled. " +
						"Check that the app window is still open, then retry.",
				);
			}

			let result: SandboxResult;
			try {
				result = JSON.parse(answer) as SandboxResult;
			} catch {
				return failure("The AgiQuery app returned something that is not a sandbox result.");
			}

			const details: AqToolDetails = {
				ok: result.ok,
				durationMs: result.durationMs,
				console: result.console ?? [],
				value: result.value ?? null,
				...(result.error ? { error: result.error } : {}),
			};

			if (!result.ok) {
				const { name, message } = result.error ?? { name: "Error", message: "unknown failure" };
				return {
					content: [
						{ type: "text", text: `script threw ${name}: ${message}` },
						{ type: "text", text: `console:\n${formatConsole(result.console ?? [])}` },
					],
					details,
				};
			}

			const returned =
				result.value === undefined || result.value === null ? "undefined" : JSON.stringify(result.value, null, 2);
			return {
				content: [
					{ type: "text", text: `console:\n${formatConsole(result.console ?? [])}` },
					{ type: "text", text: `returned:\n${returned}` },
				],
				details,
			};
		},
		...aqRenderers,
	};
}

export function createAqTool(): AgentTool<typeof aqSchema> {
	return wrapToolDefinition(createAqToolDefinition());
}
