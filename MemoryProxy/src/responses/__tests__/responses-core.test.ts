import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  matchResponsesRoute,
  parseResponsesJsonResponse,
  parseResponsesSse,
  resolveResponsesUpstreamUrl,
} from "../index.js";

describe("Responses core smoke", () => {
  it("parses protocol helpers and routes", () => {
    const json = parseResponsesJsonResponse(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1 },
    }));
    assert.equal(json.outputText, "ok");
    assert.equal(json.usage?.input_tokens, 1);

    const stream = parseResponsesSse([
      "event: response.output_text.delta\r\ndata: {\"delta\":\"Hel",
      "lo\"}\r\n\r\nevent: response.completed\r\ndata: {\"response\":{\"status\":\"completed\",\"usage\":{\"output_tokens\":2}}}\r\n\r\ndata: [DONE]\r\n\r\n",
    ]);
    assert.equal(stream.outputText, "Hello");
    assert.equal(stream.status, "completed");
    assert.equal(stream.usage?.output_tokens, 2);
    assert.equal(stream.done, true);

    const config = {
      upstream: { url: "https://upstream.example/v1/chat/completions", apiKey: "", agents: {} },
      server: { forwardTimeoutMs: 1000 },
    } as never;
    assert.equal(
      resolveResponsesUpstreamUrl(config, "/proxy/space/v1/responses?stream=true").url,
      "https://upstream.example/v1/responses?stream=true",
    );
    assert.equal(matchResponsesRoute("/v1/unknown"), null);

    console.log("responses core smoke ok");
  });
});
