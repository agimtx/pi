/**
 * The `aq_script` tool: the model writes a script, the host app runs it.
 *
 * pi never reaches the app. The script goes out as an `extension_ui_request` on the
 * host's own transport and the answer comes back the same way, so this extension needs
 * no URL, no port, and no token: it hands the work to whichever process is hosting it
 * and waits.
 *
 * That also means this file holds no domain knowledge and cannot widen the script's
 * reach. What the script may touch is decided by the host, next to its own API facade,
 * and the answer is the only thing that comes back.
 *
 * Registered as a built-in but inactive: pi enables it with `--tools aq_script`, so an
 * ordinary pi install never sees a tool that only an AgiQuery-shaped host can answer.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "../../core/extensions/types.ts";
import {
	DEFAULT_SANDBOX_TIMEOUT_MS,
	SANDBOX_REQUEST_TITLE,
	type SandboxConsoleEntry,
	type SandboxResult,
} from "./protocol.ts";

const parameters = Type.Object({
	code: Type.String({
		description:
			"JavaScript to run in the AgiQuery app. Top-level await and `return` are allowed: " +
			"the body runs as an async function, so `return` is how you hand a value back.",
	}),
	timeout_ms: Type.Optional(Type.Number({ description: "Execution deadline in milliseconds. Default 30000." })),
});

export type AqScriptDetails = {
	ok: boolean;
	durationMs: number;
	console: SandboxConsoleEntry[];
	error?: { name: string; message: string };
};

function formatConsole(entries: SandboxConsoleEntry[]): string {
	if (entries.length === 0) return "(no console output)";
	return entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: AqScriptDetails } {
	return {
		content: [{ type: "text", text: message }],
		details: { ok: false, durationMs: 0, console: [] },
	};
}

export function createAqScriptTool() {
	return defineTool({
		name: "aq_script",
		label: "AgiQuery script",
		description:
			"Run JavaScript in the AgiQuery app and return its result. Use this to read or change " +
			"the open project through the app's own API facade. Report only what the script actually " +
			"returned, and keep console output short.",
		promptSnippet: "aq_script — run JavaScript in the AgiQuery app",
		parameters,
		// The script reaches the app's API facade, so it is neither read-only nor safe
		// to repeat.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		defaultActive: false,
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
			const timeoutMs = params.timeout_ms ?? DEFAULT_SANDBOX_TIMEOUT_MS;

			// `timeout` makes pi resolve the call itself when the host never answers, so a
			// closed or unresponsive app cannot hang the turn.
			const answer = await ctx.ui.input(SANDBOX_REQUEST_TITLE, JSON.stringify({ code: params.code, timeoutMs }), {
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

			const details: AqScriptDetails = {
				ok: result.ok,
				durationMs: result.durationMs,
				console: result.console ?? [],
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
	});
}
