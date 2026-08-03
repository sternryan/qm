import { test } from "node:test";
import assert from "node:assert/strict";
import { createAmbientHelpers } from "../src/api/app-ambient.ts";
import type { App, AppDeps } from "../src/api/app-types.ts";
import { scopeId } from "../src/types.ts";
import type { CachedMessage } from "../src/surface-cache/types.ts";

// FAB-1: app-ambient.ts's judgeAmbientContainer must resolve the JUDGING
// container's own scope (scopeId("channel", container)) and pass it to
// deps.ambientJudge on every call, so that the wiring layer can route the
// judge call through that scope's own harness/model pin instead of a
// harness captured once at boot. Before this fix, ambientJudge had no scope
// parameter anywhere in its chain (systemPrompt, prompt) -- these tests
// would fail to compile against that signature, and would fail at runtime
// against any regression that stops threading the scope through.

function messagesFor(text: string): CachedMessage[] {
  return [{ container: "ignored", ts: "1.0", authorId: "U1", text, createdAt: 1 }];
}

function fakeDeps(opts: {
  ambientJudge: (scopeLabel: string, systemPrompt: string, prompt: string) => Promise<string | undefined>;
  text?: string;
}): AppDeps {
  return {
    surfaceCache: {
      readMessages: async () => messagesFor(opts.text ?? "need help please"),
      containerState: async () => ({ container: "c", kind: "channel" }),
    },
    channelPolicy: {
      // non-empty standing orders => watchReason=true => ambient isn't gated off
      get: async () => ({ orders: "always engage", bots: {}, ambientEnabled: true }),
    },
    ambientJudge: opts.ambientJudge,
  } as unknown as AppDeps;
}

const fakeApp = {
  turn: async () => ({}) as never,
  replayOrphanedRunSignals: async () => {},
} as unknown as App;

test("judgeAmbientContainer resolves the container's own scope and threads it into ambientJudge on every call", async () => {
  const calls: Array<{ scopeLabel: string; container: string }> = [];
  const deps = fakeDeps({
    ambientJudge: async (scopeLabel) => {
      calls.push({ scopeLabel, container: "" });
      return JSON.stringify({ act: false });
    },
  });
  const { judgeAmbientContainer } = createAmbientHelpers(deps, fakeApp);

  await judgeAmbientContainer("slack", "C-alpha");
  assert.equal(calls.length, 1, "ambientJudge was invoked");
  assert.equal(
    calls[0]!.scopeLabel,
    scopeId("channel", "C-alpha"),
    "the judge is called with the judging container's own scope, not an unscoped/org-wide call",
  );
});

test("two different containers resolve two different scopes — proves the scope is derived per call, not fixed once", async () => {
  const seen: string[] = [];
  const deps = fakeDeps({
    ambientJudge: async (scopeLabel) => {
      seen.push(scopeLabel);
      return JSON.stringify({ act: false });
    },
  });
  const { judgeAmbientContainer } = createAmbientHelpers(deps, fakeApp);

  await judgeAmbientContainer("slack", "C-alpha");
  await judgeAmbientContainer("slack", "C-beta");

  assert.deepEqual(seen, [scopeId("channel", "C-alpha"), scopeId("channel", "C-beta")]);
});
