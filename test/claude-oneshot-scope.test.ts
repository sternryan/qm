import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeHarness } from "../src/harness/claude-harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { scopeId } from "../src/types.ts";

const RYAN = scopeId("personal", "sternryan@github");
const RYN = scopeId("personal", "NyrW@github");

// A oneshot (title, compaction, security screen, detection, judge) used to run under a
// synthetic "org:oneshot" scope that isInternalClaudeScope() exempts from credential
// enforcement -- so every oneshot on any scope's turn silently spent the deployment
// owner's subscription. Bound to the turn's own scope, it obeys the same policy a turn does.
test("a oneshot for a scope with no Claude login of its own is refused, never billed to the deployment owner", async () => {
  const harness = createClaudeHarness({
    deploymentCredentialScope: RYAN,
    loadOwnCredentials: async () => null,
    loadOwnCredentialEnv: async () => null,
  });

  assert.equal(typeof harness.modelsFor, "function", "the claude adapter must resolve model utilities per scope");
  const models = await harness.modelsFor!(RYN);

  await assert.rejects(
    () => models.judge!("system", "prompt"),
    (error: Error) => {
      assert.equal(error instanceof NonRetryableTurnError, true);
      assert.match(error.message, /claude login/);
      return true;
    },
  );
});

// In production nothing holds the claude adapter directly -- wiring builds a router over
// several adapters, and every scoped caller goes through router.modelsFor(). If the router
// hands back the chosen adapter's UNSCOPED models table, the per-scope binding above is
// never reached and oneshots keep spending the deployment owner's subscription.
test("the router's per-scope models carry the scope down into the adapter, not just to it", async () => {
  const claude = createClaudeHarness({
    deploymentCredentialScope: RYAN,
    loadOwnCredentials: async () => null,
    loadOwnCredentialEnv: async () => null,
    binaryPath: "/nonexistent/claude",
  });
  const router = createHarnessRouter(new Map([["claude", claude]]), claude, () => ({
    harnessId: "claude",
    modelId: "claude-haiku-4-5",
  }));

  const models = await router.modelsFor!(RYN);

  await assert.rejects(
    () => models.judge!("system", "prompt"),
    (error: Error) => {
      assert.equal(error instanceof NonRetryableTurnError, true);
      assert.match(error.message, /claude login/);
      return true;
    },
  );
});
