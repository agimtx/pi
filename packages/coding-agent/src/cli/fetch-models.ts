/**
 * Fetch one provider's live model list from its upstream HTTP endpoint.
 *
 * `--list-models` prints pi's local catalog, which only knows the models that
 * were compiled in or cached. `--fetch-models` instead asks the provider what it
 * currently serves, which is the only way to see models released after the last
 * catalog update.
 *
 * One invocation fetches one provider, named by `--provider` (or the
 * `provider/` prefix of `--model`), because the endpoints are unrelated and a
 * run that fans out over all of them would fail as a unit.
 *
 * Which endpoint to call follows the wire protocol, not the provider name: the
 * same provider id can be redirected to a gateway that speaks another protocol
 * with `--base-url` and `--api-type`, and that gateway's listing route belongs
 * to the protocol. So `RULES_BY_API` maps a protocol to its request/parse rule,
 * the protocol is `--api-type` when given and otherwise the one every model of
 * the provider shares. A provider whose models span several protocols has no
 * single answer and falls back to the OpenAI-compatible rule.
 *
 * Two provider-level tables remain, because a protocol alone cannot describe
 * them: `PROVIDER_LISTING_URLS` for endpoints whose path is a provider quirk
 * rather than a protocol trait, and `PROVIDERS_WITHOUT_LISTING` for providers
 * with no listing endpoint at all. Both apply only to the provider's own
 * endpoint — a `--base-url` override names an endpoint the user controls, so it
 * wins over both.
 */

import type { Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";

/** Sent on Anthropic requests; the API rejects a request without it. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic subscription access tokens, as opposed to `sk-ant-api*` keys. */
const ANTHROPIC_OAUTH_TOKEN_MARKER = "sk-ant-oat";

const MAX_ERROR_BODY_CHARS = 400;

interface ResolvedAuth {
	apiKey: string | undefined;
	/** Provider-owned headers (auth tokens, tenant ids) resolved by ModelRuntime. */
	headers: Record<string, string>;
}

interface ModelListRule {
	/** Listing URL for a base URL, including any query the protocol needs. */
	url(baseUrl: string, auth: ResolvedAuth): string;
	/** Extra headers, for protocols that do not take a bearer token. */
	headers(auth: ResolvedAuth): Record<string, string>;
	/** Model entries carried by a successful response body. */
	parse(body: unknown): unknown[];
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

/** Provider headers may disable a default with an explicit null. */
function withoutNullHeaders(headers: Record<string, string | null> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result[name] = value;
	}
	return result;
}

function isAnthropicOAuthToken(apiKey: string): boolean {
	// Same discrimination the Anthropic SDK path uses: subscription tokens are
	// bearer tokens, API keys are not.
	return apiKey.includes(ANTHROPIC_OAUTH_TOKEN_MARKER);
}

function bearerHeaders(auth: ResolvedAuth): Record<string, string> {
	return auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {};
}

/** OpenAI-style list envelope: `{ "data": [ ... ] }`. */
function dataEntries(body: unknown): unknown[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (Array.isArray(data)) return data;
	throw new Error('unexpected response shape: no "data" array');
}

/** Anthropic list envelope, same `{ "data": [ ... ] }` payload. */
const anthropicRule: ModelListRule = {
	url: (baseUrl) => `${stripTrailingSlash(baseUrl)}/v1/models`,
	headers: (auth) => ({
		"anthropic-version": ANTHROPIC_VERSION,
		...(auth.apiKey
			? isAnthropicOAuthToken(auth.apiKey)
				? { Authorization: `Bearer ${auth.apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
				: { "x-api-key": auth.apiKey }
			: {}),
	}),
	parse: dataEntries,
};

/** Google Generative Language: `{ models: [{ name: "models/<id>" }] }`, key in the query. */
const googleRule: ModelListRule = {
	url: (baseUrl, auth) => `${stripTrailingSlash(baseUrl)}/models?key=${encodeURIComponent(auth.apiKey ?? "")}`,
	headers: () => ({}),
	parse: (body) => {
		const models = (body as { models?: unknown } | null)?.models;
		if (!Array.isArray(models)) throw new Error('unexpected response shape: no "models" array');
		return models.map((entry) => {
			const name = (entry as { name?: unknown }).name;
			return typeof name === "string" ? { ...(entry as object), id: name.replace(/^models\//u, "") } : entry;
		});
	},
};

const openAiCompatibleRule: ModelListRule = {
	url: (baseUrl) => `${stripTrailingSlash(baseUrl)}/models`,
	headers: bearerHeaders,
	parse: dataEntries,
};

/**
 * Protocols whose listing route differs from `{baseUrl}/models`. Anything not
 * listed here — including a protocol registered by an extension — is assumed to
 * speak the OpenAI-compatible list envelope.
 */
const RULES_BY_API: Record<string, ModelListRule | undefined> = {
	"anthropic-messages": anthropicRule,
	"google-generative-ai": googleRule,
};

/** Host-root `{origin}/v1/models`, for endpoints whose base URL is only a sub-path. */
function hostRootV1Models(baseUrl: string): string {
	return `${stripTrailingSlash(baseUrl.replace(/\/[^/]+$/u, ""))}/v1/models`;
}

/**
 * Listing URLs that the wire protocol does not determine, because the provider
 * serves its API under a sub-path that no protocol implies.
 */
const PROVIDER_LISTING_URLS: Record<string, ModelListRule["url"]> = {
	// Vercel AI Gateway fronts several protocols but lists under its own /v1/ai route.
	"vercel-ai-gateway": (baseUrl) => `${stripTrailingSlash(baseUrl)}/v1/ai/models`,
	// MiniMax's anthropic base is /anthropic, but its listing lives at the host root.
	minimax: hostRootV1Models,
	"minimax-cn": hostRootV1Models,
};

/**
 * Providers with no model-listing endpoint on their own API. Guessing one would
 * return a confusing 404 instead of an honest answer, so they are named here.
 * A `--base-url` override lifts the refusal, because the endpoint being queried
 * is then the user's, not the provider's.
 */
const PROVIDERS_WITHOUT_LISTING: Record<string, string> = {
	"amazon-bedrock": "Bedrock lists models through the SigV4-signed control plane, not the data plane",
	"azure-openai-responses": "Azure exposes deployments through the management API, not the data plane",
	"cloudflare-ai-gateway": "Cloudflare AI Gateway has no model-listing endpoint",
	"cloudflare-workers-ai": "Cloudflare lists models per account through the REST API",
	"github-copilot": "the Copilot model list requires an exchanged Copilot token",
	"google-vertex": "Vertex lists models per project and location through the Cloud control plane",
	"kimi-coding": "Kimi For Coding publishes no model-listing endpoint",
	"openai-codex": "the ChatGPT backend exposes no public model-listing endpoint",
	opencode: "OpenCode Zen publishes no model-listing endpoint",
	"opencode-go": "OpenCode Go publishes no model-listing endpoint",
	radius: "Radius gateways publish their catalog through provider configuration",
	typesafe: "TypeSafe serves a single classifier model and publishes no listing",
};

/**
 * The provider to query: `--provider`, or the `provider/` prefix of `--model`
 * (`--model openai/gpt-5 --fetch-models` needs no separate --provider).
 */
export function resolveFetchProviderId(args: { provider?: string; model?: string }): string | undefined {
	if (args.provider) return args.provider;
	const model = args.model;
	if (!model) return undefined;
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

export interface FetchedProviderModels {
	provider: string;
	/** URL that answered, for provenance. */
	endpoint: string;
	/** Raw provider entries, sorted by `id`. */
	models: unknown[];
}

function entryId(entry: unknown): string | undefined {
	const id = (entry as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : undefined;
}

function entryName(entry: unknown): string {
	const record = entry as { name?: unknown; display_name?: unknown; displayName?: unknown };
	// Google names an entry "models/<id>"; its display name is the human label.
	for (const candidate of [record?.display_name, record?.displayName, record?.name]) {
		if (typeof candidate === "string") return candidate;
	}
	return "";
}

async function readErrorBody(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	const trimmed = text.trim();
	return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...` : trimmed;
}

function bodySuffix(body: string): string {
	return body.length > 0 ? `: ${body}` : "";
}

function resolveBaseUrl(modelRuntime: ModelRuntime, providerId: string): string {
	const provider = modelRuntime.getProvider(providerId);
	// Some providers (OpenCode, custom models.json entries) only carry the URL on
	// their models, never on the provider itself.
	const baseUrl = provider?.baseUrl ?? modelRuntime.getModels(providerId)[0]?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId} has no base URL to query`);
	return baseUrl;
}

/**
 * The protocol to ask about models with. `--api-type` wins because it is what
 * this run actually sends; otherwise the provider's own protocol, which is only
 * unambiguous when all of its models agree.
 */
function resolveApi(modelRuntime: ModelRuntime, providerId: string, apiType: Api | undefined): Api | undefined {
	if (apiType) return apiType;
	const apis = new Set(modelRuntime.getModels(providerId).map((model) => model.api));
	return apis.size === 1 ? [...apis][0] : undefined;
}

export interface FetchProviderModelsOptions {
	signal?: AbortSignal;
	userAgent?: string;
	/** `--api-type`: the protocol this run forces the provider to speak. */
	apiType?: Api;
	/** True when `--base-url` redirected the provider away from its own endpoint. */
	baseUrlOverridden?: boolean;
}

export async function fetchProviderModels(
	modelRuntime: ModelRuntime,
	providerId: string,
	options: FetchProviderModelsOptions = {},
): Promise<FetchedProviderModels> {
	// Both provider-level tables describe the provider's own endpoint. A --base-url
	// override points somewhere else, so neither applies to it.
	const useProviderEndpoint = options.baseUrlOverridden !== true;
	const withoutListing = useProviderEndpoint ? PROVIDERS_WITHOUT_LISTING[providerId] : undefined;
	if (withoutListing) throw new Error(`Provider ${providerId} does not support listing models: ${withoutListing}`);

	const api = resolveApi(modelRuntime, providerId, options.apiType);
	const rule = (api ? RULES_BY_API[api] : undefined) ?? openAiCompatibleRule;
	const auth = await modelRuntime.getAuth(providerId, { signal: options.signal });
	if (!auth)
		throw new Error(`Provider ${providerId} is not configured. Add credentials with "pi auth login ${providerId}".`);

	const resolved: ResolvedAuth = { apiKey: auth.auth.apiKey, headers: withoutNullHeaders(auth.auth.headers) };
	const baseUrl = resolveBaseUrl(modelRuntime, providerId);
	const providerUrl = useProviderEndpoint ? PROVIDER_LISTING_URLS[providerId] : undefined;
	const endpoint = (providerUrl ?? rule.url)(baseUrl, resolved);
	const response = await fetch(endpoint, {
		headers: {
			accept: "application/json",
			...resolved.headers,
			...rule.headers(resolved),
			...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
		},
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}${bodySuffix(await readErrorBody(response))}`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new Error(`invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
	}
	const models = rule.parse(body).sort((a, b) => (entryId(a) ?? "").localeCompare(entryId(b) ?? ""));
	return { provider: providerId, endpoint, models };
}

export function printFetchedModels(result: FetchedProviderModels, asJson: boolean): void {
	if (asJson) {
		console.log(
			JSON.stringify(
				{
					provider: result.provider,
					endpoint: result.endpoint,
					count: result.models.length,
					models: result.models,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Fetched ${result.models.length} models from ${result.endpoint}`);
	if (result.models.length === 0) return;

	const idWidth = Math.max(...result.models.map((model) => (entryId(model) ?? "").length), 0);
	for (const model of result.models) {
		const id = entryId(model) ?? "<unnamed>";
		console.log(`${id.padEnd(idWidth)}  ${entryName(model)}`.trimEnd());
	}
}

export function printFetchModelsError(providerId: string, message: string, asJson: boolean): void {
	if (asJson) {
		console.log(JSON.stringify({ provider: providerId, error: message }, null, 2));
		return;
	}
	console.error(`Error: ${message}`);
}
