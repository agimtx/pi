/**
 * AgiQuery host integration for pi.
 *
 * Loaded as a built-in extension rather than from a path, so a packaged pi binary
 * carries it with no resource to resolve and no `--extension` flag to pass. It stays
 * inactive until something names it in `--tools`, which is how the AgiQuery app turns
 * it on; everyone else's pi is unaffected.
 *
 * The host channel is pi's own extension-UI sub-protocol, so pi never opens a socket
 * to reach the app: an extension hands work to its host and waits for the answer. That
 * channel is general, so a tool that needs the host for something other than running a
 * script needs no new plumbing.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SANDBOX_REQUEST_TITLE } from "./protocol.ts";
import { createAqScriptTool } from "./tool.ts";

export function createAqExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool(createAqScriptTool());

		pi.registerCommand("aq-sandbox", {
			description: "Show that the AgiQuery host channel is available",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`aq_script runs through the host channel (${SANDBOX_REQUEST_TITLE})`, "info");
			},
		});
	};
}

export default createAqExtension();
