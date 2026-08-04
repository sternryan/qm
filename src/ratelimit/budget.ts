import type { ModelCallUsage } from "../model/model-gateway.ts";
import {
  CACHE_READ_COST_RATIO,
  CACHE_WRITE_COST_RATIO,
  DEFAULT_AGENT_INPUT_USD_PER_MTOK,
  OUTPUT_COST_RATIO,
} from "../model/pi-models.ts";
interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

/**
 * Price one model call from its usage breakdown.
 *
 * Charging every prompt token at the fresh-input rate overstates a long thread by roughly an
 * order of magnitude: each turn re-sends the whole transcript, and almost all of it is served
 * from cache at a tenth the price. Weighting each component by its real ratio makes the budget
 * track cost instead of conversation length. A call with no breakdown prices exactly as before.
 */
export function estimateCallCostUsd(
  usage: Pick<ModelCallUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">,
  usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK,
): number {
  const nonNegative = (n: number | undefined) => (Number.isFinite(n) && (n ?? 0) > 0 ? (n as number) : 0);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const output = nonNegative(usage.outputTokens);
  // cacheRead/cacheWrite are subsets of inputTokens; whatever is left over was billed fresh.
  const freshInput = Math.max(0, nonNegative(usage.inputTokens) - cacheRead - cacheWrite);
  const weightedTokens =
    freshInput + cacheRead * CACHE_READ_COST_RATIO + cacheWrite * CACHE_WRITE_COST_RATIO + output * OUTPUT_COST_RATIO;
  return (weightedTokens / 1_000_000) * usdPerMTok;
}

export function createBudgetTracker(
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const orgKey = "@org";

  function spentIn(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((e) => e.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((s, e) => s + e.usd, 0);
  }

  return {
    async check(principalId, now = Date.now()) {
      const spentUsd = spentIn(principalId, now);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgSpent = spentIn(orgKey, now);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
  };
}
