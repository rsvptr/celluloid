import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { friendlyAnthropicError } from "../src/lib/anthropic";

function apiError(status: number, type: string, message: string) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message }, request_id: "req_test" },
    undefined,
    new Headers(),
  );
}

describe("friendlyAnthropicError", () => {
  it("shows a 400's own sentence, never the raw JSON body the SDK puts in message", () => {
    const e = apiError(400, "invalid_request_error", "prompt is too long: 215000 tokens > 200000 maximum");
    assert.ok(e instanceof Anthropic.BadRequestError);
    assert.match(e.message, /\{"type":"error"/);
    assert.equal(
      friendlyAnthropicError(e),
      "Claude couldn't accept this request (prompt is too long: 215000 tokens > 200000 maximum). Try another model, or base the run on fewer titles.",
    );
  });

  it("keeps the specific classes ahead of the base class", () => {
    assert.match(friendlyAnthropicError(apiError(401, "authentication_error", "invalid x-api-key")), /key was rejected/);
    assert.match(friendlyAnthropicError(apiError(429, "rate_limit_error", "slow down")), /rate-limiting/);
    assert.match(friendlyAnthropicError(apiError(529, "overloaded_error", "Overloaded")), /briefly overloaded/);
    assert.match(
      friendlyAnthropicError(new Anthropic.APIConnectionError({ message: "socket hang up" })),
      /Couldn't reach the Anthropic API/,
    );
  });

  it("gives any other status the API's sentence without the JSON around it", () => {
    const billing = apiError(402, "billing_error", "Your credit balance is too low.");
    assert.equal(
      friendlyAnthropicError(billing),
      "AI request failed: Your credit balance is too low.",
    );
    const bare = Anthropic.APIError.generate(418, undefined, undefined, new Headers());
    assert.equal(friendlyAnthropicError(bare), "AI request failed. Try again in a moment.");
  });

  it("never surfaces a non-SDK error's own message", () => {
    assert.equal(
      friendlyAnthropicError(new Error("stack internals")),
      "Claude request failed. Try again in a moment.",
    );
  });
});
