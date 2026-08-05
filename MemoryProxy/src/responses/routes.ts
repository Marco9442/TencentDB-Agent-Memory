import type { Hono } from "hono";
import type { ProxyConfig } from "../types.js";
import { handleResponses } from "./handler.js";
import { responsesEndpointPaths } from "./route.js";

/** Register only explicit Responses paths; the old POST catch-all remains Chat. */
export function registerResponsesRoutes(app: Hono, config: ProxyConfig): void {
  for (const path of responsesEndpointPaths()) {
    // Models is a read-only OpenAI helper endpoint. The other Responses
    // helpers are POST endpoints, including `/alpha/search`.
    if (path.endsWith("/models")) {
      app.get(path, (c) => handleResponses(c, config));
    } else {
      app.post(path, (c) => handleResponses(c, config));
    }
  }
}
