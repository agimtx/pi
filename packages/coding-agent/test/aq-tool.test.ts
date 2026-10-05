import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { createAqToolDefinition } from "../src/core/tools/aq.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function renderCall(code: string): string {
	const context = {
		args: { code },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	} satisfies ToolRenderContext;
	const component = createAqToolDefinition().renderCall?.({ code }, theme, context) as Component;
	return stripVTControlCharacters(component.render(120).join("\n")).trim();
}

describe("aq as a built-in tool", () => {
	it("is declared to the model like read and bash", () => {
		const def = createAqToolDefinition();
		expect(def.name).toBe("aq");
		expect(def.promptSnippet).toBeTruthy();
		expect(def.promptGuidelines?.length).toBeGreaterThan(0);
		expect(def.renderCall).toBeTypeOf("function");
		expect(def.renderResult).toBeTypeOf("function");
	});

	it("fails cleanly when no host is attached", async () => {
		const def = createAqToolDefinition();
		const out = await def.execute("id", { code: "return 1" }, undefined, undefined, undefined as never);
		expect(out.details.ok).toBe(false);
		expect(JSON.stringify(out.content)).toContain("no Agile Query host");
	});

	it("does not hang when the host never answers", async () => {
		const def = createAqToolDefinition();
		const ctx = { ui: { input: async () => undefined } } as never;
		const out = await def.execute("id", { code: "return 1" }, undefined, undefined, ctx);
		expect(out.details.ok).toBe(false);
		expect(JSON.stringify(out.content)).toContain("did not answer");
	});

	it("round-trips a host result", async () => {
		const def = createAqToolDefinition();
		const payload = JSON.stringify({
			ok: true,
			value: { n: 2 },
			console: [{ level: "log", text: "hi" }],
			durationMs: 5,
			executor: "copilot-eval",
		});
		const ctx = { ui: { input: async () => payload } } as never;
		const out = await def.execute("id", { code: "return {n:2}" }, undefined, undefined, ctx);
		expect(out.details.ok).toBe(true);
		expect(
			out.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		).toContain('"n": 2');
	});

	it("reports a script that threw", async () => {
		const def = createAqToolDefinition();
		const payload = JSON.stringify({
			ok: false,
			console: [],
			error: { name: "TypeError", message: "x is not a function" },
			durationMs: 3,
			executor: "copilot-eval",
		});
		const ctx = { ui: { input: async () => payload } } as never;
		const out = await def.execute("id", { code: "boom()" }, undefined, undefined, ctx);
		expect(out.details.ok).toBe(false);
		expect(JSON.stringify(out.content)).toContain("TypeError");
	});

	it("reports what the script returned, so a renderer does not have to read it out of the prose", async () => {
		const def = createAqToolDefinition();
		const payload = JSON.stringify({
			ok: true,
			value: { n: 2 },
			console: [],
			durationMs: 2,
			executor: "copilot-eval",
		});
		const ctx = { ui: { input: async () => payload } } as never;
		const out = await def.execute("id", { code: "return {n:2}" }, undefined, undefined, ctx);
		expect(out.details.value).toEqual({ n: 2 });
	});

	it("leaves the returned value out when the host reported none", async () => {
		const def = createAqToolDefinition();
		const payload = JSON.stringify({
			ok: true,
			value: null,
			console: [],
			durationMs: 1,
			executor: "copilot-eval",
		});
		const ctx = { ui: { input: async () => payload } } as never;
		const out = await def.execute("id", { code: "return undefined" }, undefined, undefined, ctx);
		expect(out.details.value).toBeNull();
	});
});

describe("aq as `aq -e '<code>'`", () => {
	beforeAll(() => initTheme("dark"));

	it("presents the -e form everywhere the model or a transcript can read it", () => {
		const def = createAqToolDefinition();
		expect(def.label).toBe("aq -e");
		expect(def.description).toContain("aq -e");
		expect(def.promptSnippet).toContain("aq -e");
		expect(def.promptGuidelines?.join("\n")).toContain("aq -e");
	});

	it("takes code and nothing else, so the host only ever receives code", () => {
		const def = createAqToolDefinition();
		const properties = (def.parameters as { properties: object }).properties;
		expect(Object.keys(properties)).toEqual(["code", "timeout_ms"]);
	});

	it("renders a collapsed call as the command that ran", () => {
		expect(renderCall("return await relationships.list({ modelId })")).toBe(
			"aq -e return await relationships.list({ modelId })",
		);
	});
});
