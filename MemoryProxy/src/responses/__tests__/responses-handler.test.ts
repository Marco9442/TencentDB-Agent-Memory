import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { buildConfig } from "../../config.js";
import { createApp } from "../../server.js";

describe("Responses handler smoke", () => {
  it("preserves JSON/SSE bytes and keeps non-Responses routes on Chat", async () => {
    const config = buildConfig({ upstreamUrl: "https://upstream.example/v1/chat/completions" });
    config.server.forwardTimeoutMs = 1000;
    let seenUrl = "";
    let seenBody = "";
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = init?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(init.body)
        : String(init?.body ?? "");
      if (seenBody.includes('"stream":true')) {
        const chunks = [
          'event: response.output_text.delta\r\ndata: {"delta":"Hel',
          'lo"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"status":"completed"}}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('{"status":"completed","output":[]}', {
        status: 201,
        headers: { "content-type": "application/json", "x-upstream": "kept" },
      });
    };

    try {
      const app = createApp(config);
      const body = JSON.stringify({ model: "provider-model-alias", input: "keep shape", instructions: [{ type: "input_text", text: "keep" }] });
      const response = await app.fetch(new Request("http://proxy/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      assert.equal(response.status, 201);
      assert.equal(await response.text(), '{"status":"completed","output":[]}');
      assert.equal(seenUrl, "https://upstream.example/v1/responses");
      assert.equal(seenBody, body);

      const sseBody = JSON.stringify({ model: "provider-model-alias", input: "stream", stream: true });
      const streamResponse = await app.fetch(new Request("http://proxy/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sseBody,
      }));
      assert.equal(streamResponse.status, 200);
      assert.equal(await streamResponse.text(), [
        'event: response.output_text.delta\r\ndata: {"delta":"Hello"}\r\n\r\n',
        'event: response.completed\r\ndata: {"response":{"status":"completed"}}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ].join(""));
      assert.equal(seenUrl, "https://upstream.example/v1/responses");

      const unknown = await app.fetch(new Request("http://proxy/v1/not-responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      assert.equal(unknown.status, 201);
      assert.equal(seenUrl, "https://upstream.example/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
