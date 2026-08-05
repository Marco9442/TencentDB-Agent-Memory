# Responses Docker E2E

Run the isolated Responses acceptance matrix from `MemoryProxy`:

```bash
npm run test:e2e:responses
```

The command builds and runs a unique Compose project containing MemoryProxy,
MemoryCore with SQLite storage, a deterministic Mock Responses upstream, and a
one-shot runner. It verifies route aliases, request preservation, JSON/SSE,
Responses memory injection for missing, string, and array `instructions`,
session isolation, function-call continuation and replay idempotency,
MemoryCore L0 write/read, Chat/Messages compatibility, upstream error handling,
cancellation, and then removes containers, volumes, and networks with a
post-cleanup check.

The function-call SSE case requires the complete event loop: function-call
item, argument delta/done, `response.completed` with its real response id, and
`data: [DONE]`. The runner immediately uses that id for
`previous_response_id`, requires a completed HTTP 200 continuation, verifies
one final user/assistant L0 pair, and checks that replay does not add another
pair. The intermediate function-call round must not write final L0 messages.

The default matrix never needs an OpenAI API key. A real-provider smoke test is
not part of the deterministic matrix and must be run separately when a key is
available; the orchestrator reports `SKIPPED_NO_API_KEY` when it is absent.
