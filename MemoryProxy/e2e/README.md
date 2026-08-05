# Responses Docker E2E

Run the isolated Responses acceptance matrix from `MemoryProxy`:

```bash
npm run test:e2e:responses
```

The command builds and runs a unique Compose project containing MemoryProxy,
MemoryCore with SQLite storage, a deterministic Mock Responses upstream, and a
one-shot runner. It verifies route aliases, request preservation, JSON/SSE,
function-call continuation and replay idempotency, MemoryCore L0 write/read,
Chat/Messages compatibility, upstream error handling, cancellation, and then
removes containers, volumes, and networks with a post-cleanup check.

The default matrix never needs an OpenAI API key. A real-provider smoke test is
not part of the deterministic matrix and must be run separately when a key is
available; the orchestrator reports `SKIPPED_NO_API_KEY` when it is absent.
