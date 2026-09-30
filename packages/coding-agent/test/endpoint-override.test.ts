import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { resolveEndpointOverrides } from "../src/cli/endpoint-override.ts";

function resolve(args: string[]) {
	return resolveEndpointOverrides(parseArgs(args));
}

describe("resolveEndpointOverrides", () => {
	it("returns nothing when neither flag is used", () => {
		expect(resolve(["--provider", "openai", "--model", "gpt-4o"])).toEqual({ overrides: {}, diagnostics: [] });
	});

	it("targets the provider named by --provider", () => {
		const { overrides, diagnostics } = resolve([
			"--provider",
			"openai",
			"--base-url",
			"http://127.0.0.1:8000/v1",
			"--api-type",
			"openai-completions",
		]);
		expect(diagnostics).toEqual([]);
		expect(overrides).toEqual({
			openai: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions" },
		});
	});

	it("targets the provider prefix of a provider/model --model value", () => {
		const { overrides, diagnostics } = resolve([
			"--model",
			"openai/gpt-4o",
			"--base-url",
			"http://127.0.0.1:8000/v1",
		]);
		expect(diagnostics).toEqual([]);
		expect(overrides).toEqual({ openai: { baseUrl: "http://127.0.0.1:8000/v1" } });
	});

	it("prefers --provider over the --model prefix", () => {
		const { overrides } = resolve([
			"--provider",
			"anthropic",
			"--model",
			"openai/gpt-4o",
			"--api-type",
			"anthropic-messages",
		]);
		expect(overrides).toEqual({ anthropic: { api: "anthropic-messages" } });
	});

	it("requires a provider when no --provider or known prefix is given", () => {
		for (const args of [
			["--base-url", "http://127.0.0.1:8000/v1"],
			["--api-type", "openai-completions"],
			["--model", "gpt-4o", "--api-type", "openai-completions"],
			// A model id that contains "/" must not be read as a provider.
			["--model", "meta-llama/Llama-3", "--base-url", "http://127.0.0.1:8000/v1"],
		]) {
			const { overrides, diagnostics } = resolve(args);
			expect(overrides).toEqual({});
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].type).toBe("error");
			expect(diagnostics[0].message).toContain("--provider");
		}
	});

	it("rejects a malformed --base-url", () => {
		const { diagnostics } = resolve(["--provider", "openai", "--base-url", "not a url"]);
		expect(diagnostics).toEqual([{ type: "error", message: "--base-url is not a valid URL: not a url" }]);
	});

	it("rejects a non-http --base-url", () => {
		const { diagnostics } = resolve(["--provider", "openai", "--base-url", "file:///etc/passwd"]);
		expect(diagnostics).toEqual([
			{ type: "error", message: "--base-url must be an http or https URL: file:///etc/passwd" },
		]);
	});

	it("warns but accepts an --api-type no extension registered", () => {
		const { overrides, diagnostics } = resolve(["--provider", "openai", "--api-type", "my-custom-api"]);
		expect(overrides).toEqual({ openai: { api: "my-custom-api" } });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].type).toBe("warning");
		expect(diagnostics[0].message).toContain("my-custom-api");
	});

	it("keeps the valid half of a rejected pair out of the override", () => {
		const { overrides, diagnostics } = resolve([
			"--provider",
			"openai",
			"--base-url",
			"nope",
			"--api-type",
			"openai-completions",
		]);
		expect(overrides).toEqual({ openai: { api: "openai-completions" } });
		expect(diagnostics).toEqual([{ type: "error", message: "--base-url is not a valid URL: nope" }]);
	});
});
