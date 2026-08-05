import { describe, expect, it } from "vitest";
import { composeUpstreamSignal } from "./upstream-signal.js";

describe("composeUpstreamSignal", () => {
  it("returns the request signal when timeout is disabled", () => {
    const controller = new AbortController();
    const signal = composeUpstreamSignal(controller.signal, 0);

    expect(signal).toBe(controller.signal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("propagates request abort and timeout abort", async () => {
    const requestController = new AbortController();
    const requestSignal = composeUpstreamSignal(requestController.signal, 1000);
    requestController.abort();
    expect(requestSignal.aborted).toBe(true);

    const timeoutSignal = composeUpstreamSignal(new AbortController().signal, 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timeoutSignal.aborted).toBe(true);
  });

  it("honors an already aborted request", () => {
    const controller = new AbortController();
    controller.abort();

    expect(composeUpstreamSignal(controller.signal, 1000).aborted).toBe(true);
  });
});
