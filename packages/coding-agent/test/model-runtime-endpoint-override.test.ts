import { isModelType } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderEndpointOverride } from "../src/core/provider-composer.ts";

async function createRuntime(endpointOverrides?: Record<string, ProviderEndpointOverride>): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
		endpointOverrides,
	});
}

describe("ModelRuntime endpoint overrides", () => {
	it("rewrites the base URL and wire protocol of a provider's chat models", async () => {
		const runtime = await createRuntime({
			openai: { baseUrl: "http://127.0.0.1:8000/v1", api: "anthropic-messages" },
		});
		const models = runtime.getModels("openai");
		expect(models.length).toBeGreaterThan(0);
		expect(runtime.getProvider("openai")?.baseUrl).toBe("http://127.0.0.1:8000/v1");
		for (const model of models) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.baseUrl).toBe("http://127.0.0.1:8000/v1");
		}
	});

	it("keeps the model list, context windows, and costs of the overridden provider", async () => {
		const baseline = await createRuntime();
		const runtime = await createRuntime({ openai: { baseUrl: "http://127.0.0.1:8000/v1" } });
		const overridden = runtime.getModels("openai");
		expect(overridden.map((model) => model.id)).toEqual(baseline.getModels("openai").map((model) => model.id));
		for (const [index, model] of overridden.entries()) {
			const original = baseline.getModels("openai")[index];
			expect(model.contextWindow).toBe(original.contextWindow);
			expect(model.cost).toEqual(original.cost);
		}
	});

	it("applies a base URL without changing the wire protocol", async () => {
		const baseline = await createRuntime();
		const runtime = await createRuntime({ openai: { baseUrl: "http://127.0.0.1:8000/v1" } });
		const apis = new Set(runtime.getModels("openai").map((model) => model.api));
		expect(apis).toEqual(new Set(baseline.getModels("openai").map((model) => model.api)));
	});

	it("leaves image and classifier models on their own protocol", async () => {
		const baseline = await createRuntime();
		const runtime = await createRuntime({ openrouter: { api: "anthropic-messages" } });
		const baselineNonChat = baseline.getAllModels("openrouter").filter((model) => !isModelType(model, "chat"));
		const overriddenNonChat = runtime.getAllModels("openrouter").filter((model) => !isModelType(model, "chat"));
		expect(baselineNonChat.length).toBeGreaterThan(0);
		expect(overriddenNonChat.map((model) => model.api)).toEqual(baselineNonChat.map((model) => model.api));
		for (const model of runtime.getModels("openrouter")) {
			expect(model.api).toBe("anthropic-messages");
		}
	});

	it("survives a catalog refresh", async () => {
		const runtime = await createRuntime({
			openai: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions" },
		});
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getEndpointOverride("openai")).toEqual({
			baseUrl: "http://127.0.0.1:8000/v1",
			api: "openai-completions",
		});
		for (const model of runtime.getModels("openai")) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("http://127.0.0.1:8000/v1");
		}
	});

	it("returns the untouched built-in provider when no override is configured", async () => {
		const runtime = await createRuntime();
		expect(runtime.getEndpointOverride("openai")).toBeUndefined();
		expect(runtime.getProvider("openai")?.baseUrl).not.toBe("http://127.0.0.1:8000/v1");
		expect(new Set(runtime.getModels("openai").map((model) => model.api)).has("anthropic-messages")).toBe(false);
	});

	it("reports an unknown provider instead of creating one", async () => {
		const runtime = await createRuntime({ "not-a-provider": { baseUrl: "http://127.0.0.1:8000/v1" } });
		expect(runtime.getProvider("not-a-provider")).toBeUndefined();
		expect(runtime.getError()).toContain('Provider "not-a-provider"');
		expect(runtime.getError()).toContain("unknown provider");
	});
});
