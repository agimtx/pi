/**
 * Build run-scoped provider endpoint overrides from --base-url and --api-type.
 *
 * The flags answer "where do requests go" and "how are they encoded" for one
 * provider. They deliberately do not define models: the provider's catalog
 * still decides which models exist, what they cost, and how large they are.
 */

import { type Api, isKnownApi, KNOWN_APIS } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import type { ProviderEndpointOverride } from "../core/provider-composer.ts";
import type { Args } from "./args.ts";

export interface EndpointOverrideResolution {
	/** Overrides by provider id. Empty when neither flag was used. */
	overrides: Record<string, ProviderEndpointOverride>;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

const BUILTIN_PROVIDER_IDS = new Set<string>(getBuiltinProviders());

type TargetResolution = { providerId: string; error?: undefined } | { providerId?: undefined; error: string };

/**
 * Which provider the flags apply to. --provider wins; otherwise a
 * "provider/model" --model value names it, but only when the prefix is a
 * built-in provider id so a model id containing "/" cannot be mistaken for one.
 */
function resolveTargetProviderId(parsed: Args): TargetResolution {
	if (parsed.provider) return { providerId: parsed.provider };
	const separator = parsed.model?.indexOf("/") ?? -1;
	const candidate = separator > 0 ? parsed.model!.slice(0, separator) : undefined;
	if (candidate && BUILTIN_PROVIDER_IDS.has(candidate)) return { providerId: candidate };
	return {
		error: '--base-url and --api-type need a provider: pass --provider <name>, or a "provider/model" --model value.',
	};
}

function parseBaseUrl(value: string): { baseUrl: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `--base-url is not a valid URL: ${value}` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: `--base-url must be an http or https URL: ${value}` };
	}
	return { baseUrl: value };
}

export function resolveEndpointOverrides(parsed: Args): EndpointOverrideResolution {
	if (parsed.baseUrl === undefined && parsed.apiType === undefined) {
		return { overrides: {}, diagnostics: [] };
	}

	const target = resolveTargetProviderId(parsed);
	if (target.error) {
		return { overrides: {}, diagnostics: [{ type: "error", message: target.error }] };
	}

	const override: ProviderEndpointOverride = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];

	if (parsed.baseUrl !== undefined) {
		const parsedUrl = parseBaseUrl(parsed.baseUrl);
		if ("error" in parsedUrl) diagnostics.push({ type: "error", message: parsedUrl.error });
		else override.baseUrl = parsedUrl.baseUrl;
	}

	if (parsed.apiType !== undefined) {
		// Custom protocols are legal, so an unknown id is a warning: it only fails
		// at request time when nothing registered it.
		if (!isKnownApi(parsed.apiType)) {
			diagnostics.push({
				type: "warning",
				message: `--api-type "${parsed.apiType}" is not a built-in protocol (${KNOWN_APIS.join(", ")}); it must be registered by an extension.`,
			});
		}
		override.api = parsed.apiType as Api;
	}

	return { overrides: { [target.providerId!]: override }, diagnostics };
}
