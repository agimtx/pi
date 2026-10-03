/**
 * Wire shapes shared by the pi extension and the app's extension-UI handler.
 *
 * The payload rides on `ctx.ui.input(title, placeholder)`: `title` is a sentinel the
 * webview dispatches on, `placeholder` carries this JSON one way, and pi resolves
 * the call with the webview's JSON answer. `input` is the only blocking RPC method
 * that takes and returns a free-form string, which is what makes it usable as a
 * general request/response channel rather than a prompt.
 */

/** Sentinel `title`. Anything else is a real dialog the webview has to render. */
export const SANDBOX_REQUEST_TITLE = "agiquery:sandbox";

/** One script, on its way to the app. */
export type SandboxRequest = {
	code: string;
	timeoutMs: number;
};

export type SandboxConsoleEntry = { level: string; text: string };

export type SandboxError = { name: string; message: string };

/** What the app sends back, after running the script. */
export type SandboxResult = {
	ok: boolean;
	value?: unknown;
	console: SandboxConsoleEntry[];
	error?: SandboxError;
	durationMs: number;
	/**
	 * Which side ran the code. Recorded rather than inferred, so a result can
	 * never be attributed to the wrong executor.
	 */
	executor: string;
};

export const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000;
