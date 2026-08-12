import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "./user-query-extractor.js";

describe("Claude internal prompt filtering", () => {
  it.each([
    "Err on the side of blocking. Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those.",
    "<local-command-caveat>internal shell transcript</local-command-caveat>",
    "<transcript>{\"user\":\"captured conversation\"}</transcript>",
    "offset 103215 猀尀∀㨀嬀崀",
    "setData( 69 setDataLegacy 6 initializeAsync 8",
  ])("drops the observed internal artifact: %s", (input) => {
    expect(extractUserQueryText(input)).toBe("");
  });

  it("keeps ordinary discussion of filtered terms", () => {
    expect(extractUserQueryText("请解释 offset 103215 和 setData() 的含义"))
      .toBe("请解释 offset 103215 和 setData() 的含义");
  });
});
