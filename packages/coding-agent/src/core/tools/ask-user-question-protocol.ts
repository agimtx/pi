/**
 * Wire shapes for the `ask_user_question` built-in tool.
 *
 * The payload rides on pi's `ctx.ui.select(title, options)` and `ctx.ui.input(title, placeholder)`:
 * `title` is a sentinel the host dispatches on, and the request itself travels as JSON in the
 * dialog's free-form string — the option list for `select`, the placeholder for `input`. The host
 * answers with the chosen text, which pi resolves the call with.
 *
 * The AgiQuery app owns the other end of these shapes and cannot import them from here, so the two
 * copies drift unless they are changed together.
 */

/** Sentinel `title`. Anything else is a real dialog the host has to render itself. */
export const ASK_USER_QUESTION_TITLE = "agiquery:ask-user-question";

/** How long the tool waits for an answer before reporting that nobody did. */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** One option the user can pick, on its way to the host. */
export type AskUserQuestionOption = {
	label: string;
	description?: string;
};

/**
 * One question, on its way to the host.
 *
 * `options` is absent for a free-text question, which is the difference between a `select` and an
 * `input`. `multi_select` is reported rather than enforced: pi's `select` returns one string, so a
 * question that wants several answers is answered as free text the host joins.
 */
export type AskUserQuestionRequest = {
	question: string;
	options?: AskUserQuestionOption[];
	multi_select?: boolean;
};
