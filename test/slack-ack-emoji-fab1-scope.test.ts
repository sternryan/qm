import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackCoreClient, type SlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import { createAckEmojiPicker } from "../src/slack/ack-emoji.ts";
import { scopeId } from "../src/types.ts";

// FAB-1: pickAckEmoji and the ack-model audit field must resolve the picking
// CHANNEL's own scope (scopeId("channel", channel)), not a harness/model
// captured once at boot. Before this fix, SlackCoreClient.pickAckEmoji took
// only (text, candidates) -- no channel, no scope -- and ackModelId was a
// bare `() => auxiliaryModelForProvider("anthropic")`, hardcoded to a
// frontier provider regardless of which harness the channel is pinned to.
// These tests would fail to compile against that signature, and would catch
// any regression that stops threading the channel's scope through.

function fakeDeps(opts: {
  pickAckEmoji: SlackCoreClientDeps["pickAckEmoji"];
  ackModelId: SlackCoreClientDeps["ackModelId"];
}): SlackCoreClientDeps {
  return {
    app: {},
    config: {},
    runtimeFallback: { harnessId: "mock", modelId: "x" },
    blobTransfer: {},
    deliveries: {},
    metrics: {},
    runs: { onTerminal: () => {} },
    turnStream: {},
    tasks: {},
    ackPicks: { record: async () => {} },
    pickAckEmoji: opts.pickAckEmoji,
    ackModelId: opts.ackModelId,
  } as unknown as SlackCoreClientDeps;
}

test("SlackCoreClient.pickAckEmoji resolves the picking channel's own scope, per call", async () => {
  const calls: Array<{ scopeLabel: string; text: string; candidates: readonly string[] }> = [];
  const client = createSlackCoreClient(
    fakeDeps({
      pickAckEmoji: async (scopeLabel, text, candidates) => {
        calls.push({ scopeLabel, text, candidates });
        return "🚀";
      },
      ackModelId: async () => "unused",
    }),
  );

  const picked = await client.pickAckEmoji("hello", ["🚀", "👀"], "C-alpha");
  assert.equal(picked, "🚀");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.scopeLabel,
    scopeId("channel", "C-alpha"),
    "pickAckEmoji is called with the picking channel's own scope",
  );

  await client.pickAckEmoji("hi", ["👀"], "C-beta");
  assert.equal(
    calls[1]!.scopeLabel,
    scopeId("channel", "C-beta"),
    "a different channel resolves a different scope — proves the scope is derived per call",
  );
});

test("SlackCoreClient.recordAckPick resolves ackModelId against the pick's own channel scope", async () => {
  const calls: string[] = [];
  const client = createSlackCoreClient(
    fakeDeps({
      pickAckEmoji: async () => undefined,
      ackModelId: async (scopeLabel) => {
        calls.push(scopeLabel);
        return "resolved-model";
      },
    }),
  );

  await client.recordAckPick({ channel: "C-gamma", ts: "1.0", outcome: "picked", picked: "🚀" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], scopeId("channel", "C-gamma"));
});

test("ack-emoji.ts's requestAckEmoji threads ctx.channel into SlackCoreClient.pickAckEmoji unchanged", async () => {
  const seen: Array<{ text: string; candidates: readonly string[]; channel: string }> = [];
  const core = {
    pickAckEmoji: async (text: string, candidates: readonly string[], channel: string) => {
      seen.push({ text, candidates, channel });
      return undefined;
    },
    recordAckPick: async () => {},
  } as unknown as SlackCoreClient;

  const picker = createAckEmojiPicker(core);
  await picker.requestAckEmoji("hello", ["🚀"], { channel: "C-delta", ts: "1.0" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.channel, "C-delta", "the incoming reaction's channel is forwarded to pickAckEmoji");
});
