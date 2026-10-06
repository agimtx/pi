/**
 * Presentation for the `ask_user_question` tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { AskUserQuestionDetails } from "../ask-user-question.ts";
import { str } from "../render-utils.ts";

type AskRenderArgs = { question?: string };

const SUMMARY_MAX_CHARS = 80;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `Ask <question>` — the question itself is what identifies the call in a collapsed transcript. */
function formatAskCall(args: AskRenderArgs | undefined, theme: Theme): string {
	const question = str(args?.question)?.trim() ?? "";
	const summary = question ? ` ${theme.fg("muted", truncate(question, SUMMARY_MAX_CHARS))}` : "";
	return `${theme.fg("toolTitle", theme.bold("Ask"))}${summary}`;
}

function formatAskResult(
	result: { details?: AskUserQuestionDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): string {
	if (!options.expanded && !isError) return "";

	const details = result.details;
	if (!details) return "";

	if (details.answer) {
		return `\n${theme.fg("toolOutput", details.answer)}`;
	}

	const reason = details.cancelled === "timeout" ? "no answer" : "dismissed";
	return `\n${theme.fg("muted", reason)}`;
}

export const askUserQuestionRenderers: Pick<
	ToolDefinition<any, AskUserQuestionDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatAskCall(rawArgs as AskRenderArgs | undefined, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatAskResult(result, options, theme, context.isError));
		return text;
	},
};
