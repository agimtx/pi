import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

/** Capture the headers a provider receives for one request through the runtime. */
async function captureRequestHeaders(
	userAgent: string | undefined,
	provider: {
		headers?: Record<string, string>;
		transformHeaders?: (headers: Record<string, string | null>) => Record<string, string | null>;
	},
): Promise<Record<string, string | null> | undefined> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
		userAgent,
	});
	let captured: Record<string, string | null> | undefined;
	runtime.registerProvider("user-agent-provider", {
		baseUrl: "https://example.test/v1",
		apiKey: "generated-key",
		authHeader: true,
		api: "openai-completions",
		headers: provider.headers,
		streamSimple: (_model, _context, options) => {
			captured = options?.headers;
			throw new Error("captured");
		},
		models: [testModel("user-agent-model")],
	});
	const model = runtime.getModel("user-agent-provider", "user-agent-model");
	expect(model).toBeDefined();

	await runtime.completeSimple(model!, { messages: [] }, { transformHeaders: provider.transformHeaders });
	return captured;
}

describe("--user-agent parsing", () => {
	it("reads the value that follows the flag", () => {
		const parsed = parseArgs(["--user-agent", "my-client/1.0"]);

		expect(parsed.userAgent).toBe("my-client/1.0");
		expect(parsed.diagnostics).toEqual([]);
	});

	it("trims surrounding whitespace", () => {
		expect(parseArgs(["--user-agent", "  my-client/1.0  "]).userAgent).toBe("my-client/1.0");
	});

	it("is undefined when the flag is absent", () => {
		expect(parseArgs([]).userAgent).toBeUndefined();
	});

	it("reports a missing value instead of consuming the next flag", () => {
		const parsed = parseArgs(["--user-agent", "--print"]);

		expect(parsed.userAgent).toBeUndefined();
		expect(parsed.diagnostics).toEqual([{ type: "error", message: "--user-agent requires a value" }]);
		expect(parsed.print).toBe(true);
	});

	it("rejects an empty value without turning it into a message", () => {
		const parsed = parseArgs(["--user-agent", "   "]);

		expect(parsed.userAgent).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(parsed.diagnostics).toEqual([{ type: "error", message: "--user-agent requires a non-empty value" }]);
	});

	it("rejects control characters that would corrupt the header", () => {
		const parsed = parseArgs(["--user-agent", "my-client/1.0\r\nX-Injected: yes"]);

		expect(parsed.userAgent).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(parsed.diagnostics).toEqual([
			{ type: "error", message: "--user-agent must not contain control characters" },
		]);
	});

	it("keeps a prompt that follows the flag", () => {
		const parsed = parseArgs(["--user-agent", "my-client/1.0", "Explain this repo"]);

		expect(parsed.userAgent).toBe("my-client/1.0");
		expect(parsed.messages).toEqual(["Explain this repo"]);
	});
});

describe("ModelRuntime user agent", () => {
	it("sends the custom User-Agent with model requests", async () => {
		const captured = await captureRequestHeaders("my-client/1.0", {});

		expect(captured).toEqual({
			Authorization: "Bearer generated-key",
			"User-Agent": "my-client/1.0",
		});
	});

	it("leaves the default untouched when no User-Agent is configured", async () => {
		const captured = await captureRequestHeaders(undefined, {});

		expect(captured).toEqual({ Authorization: "Bearer generated-key" });
		expect(captured).not.toHaveProperty("User-Agent");
	});

	it("overrides a User-Agent configured in models.json for this run", async () => {
		const captured = await captureRequestHeaders("my-client/1.0", {
			headers: { "user-agent": "configured/1.0" },
		});

		expect(captured).toEqual({
			Authorization: "Bearer generated-key",
			"User-Agent": "my-client/1.0",
		});
	});

	it("still lets the header transform replace it", async () => {
		const captured = await captureRequestHeaders("my-client/1.0", {
			transformHeaders: (headers) => ({ ...headers, "User-Agent": "extension/1.0" }),
		});

		expect(captured).toEqual({
			Authorization: "Bearer generated-key",
			"User-Agent": "extension/1.0",
		});
	});
});
