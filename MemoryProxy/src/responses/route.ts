import type { ProxyConfig } from "../types.js";
import type { ResponsesEndpoint, ResponsesRoute } from "./types.js";

const ENDPOINTS = new Set<ResponsesEndpoint>([
  "responses",
  "responses/compact",
  "models",
  "alpha/search",
]);

function pathAndQuery(value: string): { pathname: string; search: string } {
  try {
    const parsed = new URL(value, "http://responses.local");
    return { pathname: parsed.pathname, search: parsed.search };
  } catch {
    const [pathname, query = ""] = value.split("?", 2);
    return { pathname, search: query ? `?${query}` : "" };
  }
}

/** Match only the route families registered by `registerResponsesRoutes`. */
export function matchResponsesRoute(requestPath: string): ResponsesRoute | null {
  const { pathname } = pathAndQuery(requestPath);
  const parts = pathname.split("/").filter(Boolean);
  let tail = parts;
  let prefix: ResponsesRoute["prefix"] = "root";
  let agentName: string | undefined;

  if (parts[0] === "proxy" && parts.length >= 3) {
    tail = parts.slice(2);
    prefix = "proxy-space";
  } else if (parts.length >= 3) {
    tail = parts.slice(2);
    prefix = "agent-space";
    agentName = parts[0];
  }

  const endpoint = tail.join("/").replace(/^v1\//, "") as ResponsesEndpoint;
  if (!ENDPOINTS.has(endpoint)) return null;

  return {
    endpoint,
    endpointPath: `/${endpoint}`,
    ...(agentName ? { agentName } : {}),
    prefix,
  };
}

export const matchResponseRoute = matchResponsesRoute;

function configuredUpstream(config: ProxyConfig, route: ResponsesRoute): {
  baseUrl: string;
  apiKey: string;
} {
  const agent = route.agentName ? config.upstream.agents?.[route.agentName] : undefined;
  if (agent) {
    return { baseUrl: agent.url, apiKey: agent.apiKey ?? "" };
  }
  return { baseUrl: config.upstream.url, apiKey: config.upstream.apiKey };
}

const KNOWN_UPSTREAM_SUFFIX = /\/(?:chat\/completions|messages(?:\/count_tokens)?|responses(?:\/compact)?|models(?:\/alpha\/search)?|alpha\/search|completions|embeddings|moderations)$/i;

/** Resolve a Responses endpoint without changing the configured base shape. */
export function resolveResponsesUpstreamUrl(
  config: ProxyConfig,
  requestPath: string,
): { url: string; apiKey: string; route: ResponsesRoute } {
  const route = matchResponsesRoute(requestPath);
  if (!route) throw new Error(`Unsupported Responses path: ${requestPath}`);

  const { baseUrl, apiKey } = configuredUpstream(config, route);
  const { search } = pathAndQuery(requestPath);
  let upstream: URL;
  try {
    upstream = new URL(baseUrl);
  } catch {
    const base = baseUrl.replace(/\/+$/, "");
    return { url: `${base}${route.endpointPath}${search}`, apiKey, route };
  }

  const basePath = upstream.pathname.replace(/\/+$/, "") || "/";
  upstream.pathname = KNOWN_UPSTREAM_SUFFIX.test(basePath)
    ? basePath.replace(KNOWN_UPSTREAM_SUFFIX, route.endpointPath)
    : `${basePath === "/" ? "" : basePath}${route.endpointPath}`;
  if (search) upstream.search = search;
  return { url: upstream.toString(), apiKey, route };
}

export const resolveResponsesUrl = resolveResponsesUpstreamUrl;

export function responsesEndpointPaths(): string[] {
  const suffixes = [
    "/v1/responses",
    "/responses",
    "/v1/responses/compact",
    "/responses/compact",
    "/v1/models",
    "/models",
    "/v1/alpha/search",
    "/alpha/search",
  ];
  const paths = new Set<string>(suffixes);
  for (const suffix of suffixes) {
    paths.add(`/:agent/:spaceId${suffix}`);
    paths.add(`/proxy/:spaceId${suffix}`);
  }
  return [...paths];
}
