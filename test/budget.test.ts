import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker, estimateCallCostUsd, estimateCostUsd } from "../src/ratelimit/budget.ts";
import {
  CACHE_READ_COST_RATIO,
  CACHE_WRITE_COST_RATIO,
  DEFAULT_AGENT_INPUT_USD_PER_MTOK,
  OUTPUT_COST_RATIO,
} from "../src/model/pi-models.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("budget tracker accumulates per-principal and trips at the limit", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 60_000 });
  assert.equal((await b.check("U1")).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U2", 1000)).allowed, true);
  assert.equal((await b.check("U1", 1000 + 61_000)).allowed, true);
});

test("caps are opt-in: an unconfigured tracker never refuses, a configured one does", async () => {
  const unbounded = createBudgetTracker();
  await unbounded.record("U1", 1_000_000);
  assert.equal((await unbounded.check("U1")).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createBudgetTracker({ limitUsd: 25 });
  await capped.record("U1", 26);
  assert.equal((await capped.check("U1")).allowed, false);
  assert.equal(estimateCostUsd(1000) > 0, true);
  assert.equal(estimateCostUsd(1_000_000), DEFAULT_AGENT_INPUT_USD_PER_MTOK);
});

test("a call with no cache breakdown prices exactly as the flat input estimate did", () => {
  // Every harness except claude-harness reports only a token estimate. Those calls must
  // keep costing what they cost before the meter learned about caching.
  assert.equal(estimateCallCostUsd({ inputTokens: 1_000_000 }), DEFAULT_AGENT_INPUT_USD_PER_MTOK);
  assert.equal(estimateCallCostUsd({ inputTokens: 40_000 }), estimateCostUsd(40_000));
});

test("cache reads cost a tenth of fresh input, cache writes 1.25x, output 5x", () => {
  const rate = DEFAULT_AGENT_INPUT_USD_PER_MTOK;
  // inputTokens is the whole billed prompt; cacheRead/cacheWrite are subsets of it.
  assert.equal(
    estimateCallCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
    rate * CACHE_READ_COST_RATIO,
  );
  assert.equal(
    estimateCallCostUsd({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    rate * CACHE_WRITE_COST_RATIO,
  );
  assert.equal(estimateCallCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), rate * OUTPUT_COST_RATIO);

  // A realistic long-thread turn: 200k of cached history, 2k fresh, 1k written, 500 out.
  const mixed = estimateCallCostUsd({
    inputTokens: 203_000,
    cacheReadTokens: 200_000,
    cacheWriteTokens: 1_000,
    outputTokens: 500,
  });
  const expected =
    ((2_000 + 200_000 * CACHE_READ_COST_RATIO + 1_000 * CACHE_WRITE_COST_RATIO + 500 * OUTPUT_COST_RATIO) /
      1_000_000) *
    rate;
  assert.equal(mixed, expected);
  // The whole point: that turn must not be billed as 203k tokens of fresh input.
  assert.equal(mixed < estimateCostUsd(203_000) / 5, true, "cached history should be ~an order of magnitude cheaper");
});

test("a malformed breakdown can never produce negative or runaway spend", () => {
  // Defensive: cache subsets larger than the reported total must not drive cost below zero.
  assert.equal(estimateCallCostUsd({ inputTokens: 100, cacheReadTokens: 5_000 }) >= 0, true);
  assert.equal(estimateCallCostUsd({ inputTokens: 0, cacheReadTokens: -5_000, outputTokens: -1 }), 0);
});

test("the org cap holds across principals", async () => {
  const b = createBudgetTracker({ limitUsd: 100, orgLimitUsd: 1, windowMs: 60_000 });
  await b.record("U1", 0.6, 1000);
  await b.record("U2", 0.6, 1000);
  assert.equal((await b.check("U3", 1000)).allowed, false);
});

test("a principal over budget is refused by the app", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-bud-")),
    budgetUsdPerWindow: 0.00001,
  });
  const { app } = buildApp(config);
  const dm = (text: string): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
  });

  const first = await app.turn(dm("hello"));
  assert.equal(first.status, "ok");
  const second = await app.turn(dm("again"));
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /budget exceeded/);
});
