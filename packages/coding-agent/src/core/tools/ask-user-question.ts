/**
 * The `ask_user_question` built-in tool: the model asks the person at the app a question and waits
 * for the answer before it continues.
 *
 * It is a built-in rather than an extension for the same reason `aq` is: it activates the way
 * `read` and `bash` do, and a host that cannot answer degrades to a plain failure instead of a
 * tool the model cannot discover. A plain terminal pi has nobody to ask, which is that failure.
 *
 * pi never draws the question. The request goes out on the host's own transport — the same
 * extension-UI channel `aq` uses — and the answer comes back the same way, so this tool needs no
 * URL, no port, and no token. What the question looks like is the host's business.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	ASK_USER_QUESTION_TITLE,
	type AskUserQuestionOption,
	type AskUserQuestionRequest,
	DEFAULT_ASK_TIMEOUT_MS,
} from "./ask-user-question-protocol.ts";
import { askUserQuestionRenderers } from "./renderers/ask-user-question.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const optionSchema = Type.Object({
	label: Type.String({ description: "The choice as the user reads it, which is also what is returned." }),
	description: Type.Optional(
		Type.String({ description: "One line of context shown under the choice. Omit when the label is enough." }),
	),
});

const askSchema = Type.Object({
	question: Type.String({ description: "The question, phrased so it can be answered on its own." }),
	options: Type.Optional(
		Type.Array(optionSchema, {
			description:
				"Choices to pick from. Omit for a question the user answers in their own words. " +
				"Two to four choices; add one only when the answer might be none of them.",
		}),
	),
	multi_select: Type.Optional(
		Type.Boolean({
			description: "Whether the user may pick more than one choice. Ignored when there are no choices.",
		}),
	),
});

export const askUserQuestionSystemPromptContribution = {
	snippet: "Ask the user a question with `ask_user_question` and wait for the answer",
	guidelines: [
		"Use `ask_user_question` when you cannot proceed without a decision only the user can make. Do not use it for anything you can look up yourself.",
		"Ask one question at a time. Give two to four choices when the answer is one of a known set, and omit them when the user should answer in their own words.",
		"The call blocks until the user answers or dismisses it, so ask only when the answer changes what you do next, and then do that.",
	],
} as const;

export type AskUserQuestionInput = {
	question: string;
	options?: AskUserQuestionOption[];
	multi_select?: boolean;
};

export type AskUserQuestionDetails = {
	question: string;
	/** The answer, or `null` when the user dismissed the question or nobody answered. */
	answer: string | null;
	/** Why there is no answer. Absent when there is one. */
	cancelled?: "dismissed" | "timeout" | "no-host";
};

/** What the model is told when a question produced no answer. */
const CANCELLED_TEXT: Record<NonNullable<AskUserQuestionDetails["cancelled"]>, string> = {
	dismissed:
		"The user dismissed the question without answering. Do not ask it again; decide yourself or proceed with what you have.",
	timeout: "The user did not answer in time. Do not ask it again; decide yourself or proceed with what you have.",
	"no-host":
		"This pi process has no Agile Query host attached, so there is nobody to ask. Decide yourself or proceed with what you have.",
};

function cancelled(
	question: string,
	reason: NonNullable<AskUserQuestionDetails["cancelled"]>,
): { content: { type: "text"; text: string }[]; details: AskUserQuestionDetails } {
	return {
		content: [{ type: "text", text: CANCELLED_TEXT[reason] }],
		details: { question, answer: null, cancelled: reason },
	};
}

/**
 * The choices worth offering.
 *
 * A choice without a label is not one, and two choices with the same label would hand the user a
 * question they cannot answer unambiguously. Both are dropped rather than rejected: a model that
 * sent a blank choice still asked something, and the host can render what remains.
 */
function usableOptions(options: AskUserQuestionOption[] | undefined): AskUserQuestionOption[] {
	const seen = new Set<string>();
	const usable: AskUserQuestionOption[] = [];

	for (const option of options ?? []) {
		const label = option.label.trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		usable.push({ label, ...(option.description?.trim() ? { description: option.description.trim() } : {}) });
	}

	return usable;
}

export function createAskUserQuestionToolDefinition(): ToolDefinition<typeof askSchema, AskUserQuestionDetails> {
	return {
		name: "ask_user_question",
		label: "Ask",
		description:
			"Ask the user one question and wait for the answer. " +
			"Give choices when the answer is one of a known set; leave them out when the user should answer in their own words. " +
			"Use it only for a decision you cannot make yourself, because the user has to stop and answer before you can continue.",
		promptSnippet: askUserQuestionSystemPromptContribution.snippet,
		promptGuidelines: [...askUserQuestionSystemPromptContribution.guidelines],
		parameters: askSchema,
		// Asking changes nothing and can be asked again, but it does reach the person using the app.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		// One question at a time: a second one asked alongside the first would race the same dialog.
		executionMode: "sequential",
		async execute(_toolCallId, params: AskUserQuestionInput, signal, _onUpdate, ctx?: ExtensionContext) {
			const question = params.question.trim();
			if (!question) {
				return cancelled("", "dismissed");
			}

			// A host that cannot answer returns undefined. Reporting that as a cancellation keeps the
			// tool usable in a plain terminal pi, where it is declared but nobody is there to ask.
			if (!ctx?.ui) {
				return cancelled(question, "no-host");
			}

			const options = usableOptions(params.options);
			const request: AskUserQuestionRequest = {
				question,
				...(options.length > 0 ? { options } : {}),
				...(params.multi_select && options.length > 0 ? { multi_select: true } : {}),
			};

			// `timeout` makes pi resolve the call itself when the host never answers, so a closed or
			// unresponsive app cannot hang the turn. The host reads the request from the free-form
			// string: the option list for a choice, the placeholder for free text.
			const payload = JSON.stringify(request);
			const answer =
				options.length > 0
					? await ctx.ui.select(ASK_USER_QUESTION_TITLE, [payload], { signal, timeout: DEFAULT_ASK_TIMEOUT_MS })
					: await ctx.ui.input(ASK_USER_QUESTION_TITLE, payload, { signal, timeout: DEFAULT_ASK_TIMEOUT_MS });

			const trimmed = answer?.trim();
			if (!trimmed) {
				// pi resolves a timed-out dialog and a dismissed one the same way, so the two cannot be
				// told apart from here. A dismissal is what the user did; a timeout is what the app did.
				return cancelled(question, signal?.aborted ? "timeout" : "dismissed");
			}

			return {
				content: [{ type: "text", text: trimmed }],
				details: { question, answer: trimmed },
			};
		},
		...askUserQuestionRenderers,
	};
}

export function createAskUserQuestionTool(): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskUserQuestionToolDefinition());
}
