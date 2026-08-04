import type { ScopeId } from "../types.ts";

// What one model call cost us, in tokens. `inputTokens` is the whole billed prompt —
// cacheReadTokens and cacheWriteTokens are subsets of it, not additions to it. Harnesses that
// cannot see a cache breakdown leave them unset and are priced as all-fresh input, as before.
export interface ModelCallUsage {
  model: string;
  inputTokens: number;
  entryCount: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}

interface ModelCallRecord extends ModelCallUsage {
  at: number;
  scopeLabel: ScopeId;
}

export interface ModelGateway {
  recordCall(rec: ModelCallRecord): void;
  audit(): readonly ModelCallRecord[];
}

const DEFAULT_MAX_RECORDS = 1_000;

export function createModelGateway(opts: { maxRecords?: number } = {}): ModelGateway {
  const max = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  const records: ModelCallRecord[] = [];
  return {
    recordCall: (rec) => {
      records.push(rec);
      if (records.length > max) records.splice(0, records.length - max);
    },
    audit: () => [...records],
  };
}
