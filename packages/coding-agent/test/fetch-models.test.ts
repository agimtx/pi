import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Api, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	fetchProviderModels,
	printFetchedModels,
	printFetchModelsError,
	resolveFetchProviderId,
} from "../src/cli/fetch-models.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderEndpointOverride } from "../src/core/provider-composer.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;

async function runCli(
	args: string[],
	dirs: { agentDir: string; projectDir: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
		cwd: dirs.projectDir,
		env: { ...process.env, [ENV_AGENT_DIR]: dirs.agentDir, PI_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

interface RecordedRequest {
	url: string;
	headers: IncomingHttpHeaders;
}

type Responder = (url: URL) => { status?: number; body?: unknown; text?: string };

/** Stand-in for a provider's model-listing route, answering per `respond`. */
function startModelServer(respond: Responder): Promise<{
	url: string;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		requests.push({ url: `${url.pathname}${url.search}`, headers: request.headers });
		const { status = 200, body, text } = respond(url);
		response
			.writeHead(status, { "content-type": "application/json" })
			.end(text ?? JSON.stringify(body ?? { data: [] }));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve({
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				requests,
				close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
			});
		});
	});
}

async function createRuntime(
	endpointOverrides: Record<string, ProviderEndpointOverride>,
	credentials: Record<string, { type: "api_key"; key: string }>,
): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(credentials),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		endpointOverrides,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("--fetch-models flag", () => {
	it("parses as a boolean flag", () => {
		expect(parseArgs(["--fetch-models"])).toMatchObject({ fetchModels: true });
		expect(parseArgs(["--fetch-models", "--provider", "openai", "--mode", "json"])).toMatchObject({
			fetchModels: true,
			provider: "openai",
			mode: "json",
		});
		expect(parseArgs(["--provider", "openai"]).fetchModels).toBeUndefined();
	});

	it("resolves the provider from --provider or the --model prefix", () => {
		expect(resolveFetchProviderId(parseArgs(["--fetch-models", "--provider", "openai"]))).toBe("openai");
		expect(resolveFetchProviderId(parseArgs(["--fetch-models", "--model", "openai/gpt-4o"]))).toBe("openai");
		expect(resolveFetchProviderId(parseArgs(["--fetch-models", "--model", "gpt-4o"]))).toBeUndefined();
		expect(resolveFetchProviderId(parseArgs(["--fetch-models"]))).toBeUndefined();
	});
});

describe("fetchProviderModels", () => {
	afterEach(() => {
		allowNetwork();
	});

	it("queries an OpenAI-compatible /models endpoint with the resolved key", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models"
				? { body: { data: [{ id: "gpt-b" }, { id: "gpt-a", name: "GPT A" }] } }
				: { status: 404, text: "not found" },
		);
		try {
			const runtime = await createRuntime(
				{ openai: { baseUrl: `${server.url}/v1` } },
				{ openai: { type: "api_key", key: "test-key" } },
			);
			const result = await fetchProviderModels(runtime, "openai");
			expect(server.requests[0].url).toBe("/v1/models");
			expect(server.requests[0].headers.authorization).toBe("Bearer test-key");
			expect(result.endpoint).toBe(`${server.url}/v1/models`);
			// Raw provider entries are preserved, sorted by id.
			expect(result.models).toEqual([{ id: "gpt-a", name: "GPT A" }, { id: "gpt-b" }]);
		} finally {
			await server.close();
		}
	});

	it("sends Anthropic's version header and x-api-key", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [{ id: "claude-x" }] } } : { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ anthropic: { baseUrl: server.url } },
				{ anthropic: { type: "api_key", key: "sk-ant-api-test" } },
			);
			const result = await fetchProviderModels(runtime, "anthropic");
			expect(server.requests[0].headers["x-api-key"]).toBe("sk-ant-api-test");
			expect(server.requests[0].headers["anthropic-version"]).toBe("2023-06-01");
			expect(result.models).toEqual([{ id: "claude-x" }]);
		} finally {
			await server.close();
		}
	});

	it("passes an Anthropic subscription token as a bearer token", async () => {
		const server = await startModelServer(() => ({ body: { data: [] } }));
		try {
			const runtime = await createRuntime(
				{ anthropic: { baseUrl: server.url } },
				{ anthropic: { type: "api_key", key: "sk-ant-oat-test" } },
			);
			await fetchProviderModels(runtime, "anthropic");
			expect(server.requests[0].headers.authorization).toBe("Bearer sk-ant-oat-test");
			expect(server.requests[0].headers["x-api-key"]).toBeUndefined();
		} finally {
			await server.close();
		}
	});

	it("reads Google's models array and strips the models/ prefix", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1beta/models"
				? { body: { models: [{ name: "models/gemini-b" }, { name: "models/gemini-a" }] } }
				: { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ google: { baseUrl: `${server.url}/v1beta` } },
				{ google: { type: "api_key", key: "google-key" } },
			);
			const result = await fetchProviderModels(runtime, "google");
			expect(server.requests[0].url).toBe("/v1beta/models?key=google-key");
			expect(result.models).toEqual([
				{ name: "models/gemini-a", id: "gemini-a" },
				{ name: "models/gemini-b", id: "gemini-b" },
			]);
		} finally {
			await server.close();
		}
	});

	it("reports the status and body of a failed request", async () => {
		const server = await startModelServer(() => ({ status: 401, text: "invalid api key" }));
		try {
			const runtime = await createRuntime(
				{ openai: { baseUrl: `${server.url}/v1` } },
				{ openai: { type: "api_key", key: "k" } },
			);
			await expect(fetchProviderModels(runtime, "openai")).rejects.toThrow(/401.*invalid api key/u);
		} finally {
			await server.close();
		}
	});

	it("refuses providers without a listing endpoint", async () => {
		const runtime = await createRuntime({}, { "amazon-bedrock": { type: "api_key", key: "k" } });
		await expect(fetchProviderModels(runtime, "amazon-bedrock")).rejects.toThrow(/does not support listing models/u);
	});

	it("queries the --api-type protocol, not the provider's own", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [{ id: "claude-x" }] } } : { status: 404, text: "nope" },
		);
		try {
			// An OpenAI provider id pointed at an Anthropic-compatible gateway: the
			// listing route and the key header follow --api-type, not the provider.
			const runtime = await createRuntime(
				{ openai: { baseUrl: server.url, api: "anthropic-messages" } },
				{ openai: { type: "api_key", key: "sk-ant-api-test" } },
			);
			const result = await fetchProviderModels(runtime, "openai", { apiType: "anthropic-messages" });
			expect(server.requests[0].url).toBe("/v1/models");
			expect(server.requests[0].headers["x-api-key"]).toBe("sk-ant-api-test");
			expect(server.requests[0].headers["anthropic-version"]).toBe("2023-06-01");
			expect(server.requests[0].headers.authorization).toBeUndefined();
			expect(result.models).toEqual([{ id: "claude-x" }]);
		} finally {
			await server.close();
		}
	});

	it("passes the key in the query for --api-type google-generative-ai", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1beta/models"
				? { body: { models: [{ name: "models/gemini-a" }] } }
				: { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ openai: { baseUrl: `${server.url}/v1beta`, api: "google-generative-ai" } },
				{ openai: { type: "api_key", key: "google-key" } },
			);
			const result = await fetchProviderModels(runtime, "openai", { apiType: "google-generative-ai" });
			expect(server.requests[0].url).toBe("/v1beta/models?key=google-key");
			expect(result.models).toEqual([{ name: "models/gemini-a", id: "gemini-a" }]);
		} finally {
			await server.close();
		}
	});

	it("keeps the OpenAI-compatible default for an unknown protocol", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [] } } : { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ openai: { baseUrl: `${server.url}/v1`, api: "custom-gateway" as Api } },
				{ openai: { type: "api_key", key: "k" } },
			);
			const result = await fetchProviderModels(runtime, "openai", { apiType: "custom-gateway" as Api });
			expect(server.requests[0].url).toBe("/v1/models");
			expect(result.endpoint).toBe(`${server.url}/v1/models`);
		} finally {
			await server.close();
		}
	});

	it("drops the provider's own endpoint quirk once --base-url redirects it", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [] } } : { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ minimax: { baseUrl: `${server.url}/anthropic` } },
				{ minimax: { type: "api_key", key: "sk-ant-api-test" } },
			);
			// Own endpoint: the /anthropic base is dropped to reach the host root.
			await fetchProviderModels(runtime, "minimax");
			expect(server.requests[0].url).toBe("/v1/models");

			// Redirected: the given base URL is used verbatim as a user would expect.
			const redirected = await startModelServer((url) =>
				url.pathname === "/anthropic/v1/models" ? { body: { data: [] } } : { status: 404, text: "nope" },
			);
			try {
				const runtime2 = await createRuntime(
					{ minimax: { baseUrl: `${redirected.url}/anthropic` } },
					{ minimax: { type: "api_key", key: "sk-ant-api-test" } },
				);
				await fetchProviderModels(runtime2, "minimax", { baseUrlOverridden: true });
				expect(redirected.requests[0].url).toBe("/anthropic/v1/models");
			} finally {
				await redirected.close();
			}
		} finally {
			await server.close();
		}
	});

	it("queries a redirected endpoint for a provider with no listing route of its own", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [] } } : { status: 404, text: "nope" },
		);
		try {
			const runtime = await createRuntime(
				{ "amazon-bedrock": { baseUrl: `${server.url}/v1`, api: "openai-completions" } },
				{ "amazon-bedrock": { type: "api_key", key: "k" } },
			);
			await expect(
				fetchProviderModels(runtime, "amazon-bedrock", {
					apiType: "openai-completions",
					baseUrlOverridden: true,
				}),
			).resolves.toMatchObject({ endpoint: `${server.url}/v1/models` });
		} finally {
			await server.close();
		}
	});

	it("falls back to the OpenAI-compatible rule when a provider spans several protocols", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/api/v1/models" ? { body: { data: [] } } : { status: 404, text: "nope" },
		);
		try {
			// openrouter's catalog spans two protocols, so there is no single answer.
			const runtime = await createRuntime(
				{ openrouter: { baseUrl: `${server.url}/api/v1` } },
				{ openrouter: { type: "api_key", key: "k" } },
			);
			await fetchProviderModels(runtime, "openrouter");
			expect(server.requests[0].url).toBe("/api/v1/models");
			expect(server.requests[0].headers.authorization).toBe("Bearer k");
		} finally {
			await server.close();
		}
	});

	it("refuses an unconfigured provider", async () => {
		const runtime = await createRuntime({ openai: { baseUrl: "https://api.openai.com/v1" } }, {});
		await expect(fetchProviderModels(runtime, "openai")).rejects.toThrow(/not configured/u);
	});
});

describe("--fetch-models through the CLI", () => {
	it("prints the fetched models as json on stdout and exits", async () => {
		const server = await startModelServer((url) =>
			url.pathname === "/v1/models" ? { body: { data: [{ id: "gpt-a" }] } } : { status: 404, text: "nope" },
		);
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-fetch-models-"));
		const agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-key" } }));
		try {
			const result = await runCli(
				["--fetch-models", "--provider", "openai", "--base-url", `${server.url}/v1`, "--mode", "json"],
				{ agentDir, projectDir: tempRoot },
			);
			expect(result.code).toBe(0);
			// stdout, not stderr: the json path must survive print-mode stdout takeover.
			expect(JSON.parse(result.stdout)).toEqual({
				provider: "openai",
				endpoint: `${server.url}/v1/models`,
				count: 1,
				models: [{ id: "gpt-a" }],
			});
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
			await server.close();
		}
	});

	it("fails with a clear message when no provider was named", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-fetch-models-"));
		const agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			const result = await runCli(["--fetch-models"], { agentDir, projectDir: tempRoot });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("--fetch-models requires --provider");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("fetched model output", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prints one line per model in text mode", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		printFetchedModels(
			{
				provider: "openai",
				endpoint: "https://api.openai.com/v1/models",
				models: [{ id: "a" }, { id: "bb", name: "B" }],
			},
			false,
		);
		expect(log.mock.calls.map((call) => call[0])).toEqual([
			"Fetched 2 models from https://api.openai.com/v1/models",
			"a",
			"bb  B",
		]);
	});

	it("prints the provider, endpoint, count and raw entries in json mode", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		printFetchedModels(
			{ provider: "openai", endpoint: "https://api.openai.com/v1/models", models: [{ id: "a", price: 1 }] },
			true,
		);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
			provider: "openai",
			endpoint: "https://api.openai.com/v1/models",
			count: 1,
			models: [{ id: "a", price: 1 }],
		});
	});

	it("keeps failures machine-readable in json mode", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		printFetchModelsError("openai", "401 unauthorized", true);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ provider: "openai", error: "401 unauthorized" });
		expect(error).not.toHaveBeenCalled();
	});
});
