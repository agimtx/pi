import { describe, expect, it } from "vitest";
import { createAqToolDefinition } from "../src/core/tools/aq.ts";

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
		expect(JSON.stringify(out.content)).toContain("no AgiQuery host");
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
