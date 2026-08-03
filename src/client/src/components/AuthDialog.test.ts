import { describe, expect, it } from "vitest";
import { oauthPromptInputType } from "./AuthDialog";

describe("oauthPromptInputType", () => {
  it("renders secret prompts as password inputs and other prompt types as text", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual_code")).toBe("text");
  });
});
