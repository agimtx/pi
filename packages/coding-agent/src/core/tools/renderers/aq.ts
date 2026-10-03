/**
 * Presentation for the `aq` tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `aq.ts` spreads these into its definition,
 * so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { AqToolDetails } from "../aq.ts";
import { getTextOutput, str } from "../render-utils.ts";

type AqRenderArgs = { code?: string };

const SUMMARY_MAX_CHARS = 60;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first non-blank line of the script, which identifies the call in a collapsed transcript. */
function firstLine(code: string | undefined): string {
  return (
    (code ?? "")
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? ""
  );
}

function formatAqCall(args: AqRenderArgs | undefined, theme: Theme): string {
  const head = firstLine(str(args?.code) ?? undefined);
  const summary = head ? ` ${theme.fg("muted", truncate(head, SUMMARY_MAX_CHARS))}` : "";
  return `${theme.fg("toolTitle", theme.bold("aq"))}${summary}`;
}

function formatAqResult(
  result: { content: { type: string; text?: string }[]; details?: AqToolDetails },
  options: ToolRenderResultOptions,
  theme: Theme,
  isError: boolean,
): string {
  if (!options.expanded && !isError) return "";

  const output = getTextOutput(result, false);
  const lines = output.split("\n");
  const maxLines = options.expanded ? lines.length : 10;
  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
  }

  const details = result.details;
  if (details?.error) {
    text += `\n${theme.fg("warning", `${details.error.name}: ${details.error.message}`)}`;
  }
  if (details) {
    text += `\n${theme.fg("muted", `${details.ok ? "ok" : "failed"} in ${details.durationMs}ms`)}`;
  }
  return text;
}

export const aqRenderers: Pick<
  ToolDefinition<any, AqToolDetails>,
  "renderCall" | "renderResult"
> = {
  renderCall(rawArgs, theme, context) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(formatAqCall(rawArgs as AqRenderArgs | undefined, theme));
    return text;
  },
  renderResult(result, options, theme, context) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(formatAqResult(result, options, theme, context.isError));
    return text;
  },
};
