import { chownSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { CredentialFile } from "../credentials/keychain.ts";
import { parseScopeId, type ScopeId } from "../types.ts";

export interface ClaudeCredentialInput {
  scope?: ScopeId;
  deploymentScope?: string;
  ownFiles?: readonly CredentialFile[] | null;
  ownEnv?: NodeJS.ProcessEnv | null;
}

export type ClaudeCredentialDecision =
  | { kind: "own"; files?: readonly CredentialFile[]; env?: NodeJS.ProcessEnv }
  | { kind: "deployment" }
  | { kind: "refuse"; reason: string };

export const CLAUDE_NO_CREDENTIAL_REASON =
  "this conversation has no Claude login of its own. Run `claude login` on this computer to use your own " +
  "Claude subscription here — it will not borrow anyone else's.";

export function claudeCredentialDecision(input: ClaudeCredentialInput): ClaudeCredentialDecision {
  if (input.ownFiles && input.ownFiles.length > 0) return { kind: "own", files: input.ownFiles };
  if (input.ownEnv && Object.keys(input.ownEnv).length > 0) return { kind: "own", env: input.ownEnv };
  if (input.scope && input.deploymentScope && String(input.scope) === input.deploymentScope) {
    return { kind: "deployment" };
  }
  return { kind: "refuse", reason: CLAUDE_NO_CREDENTIAL_REASON };
}

export const CLAUDE_CREDENTIAL_SERVICE = "claude";

export function claudeCredentialOwner(scope: ScopeId): string {
  const parsed = parseScopeId(scope);
  return parsed.kind === "personal" ? parsed.ref : scope;
}

export interface PrepareClaudeCredentialsInput {
  scope?: ScopeId;
  deploymentScope?: string;
  jail: string;
  identity?: { uid: number; gid: number };
  chown?: (path: string, uid: number, gid: number) => void;
  loadOwnFiles?: (scope: ScopeId) => Promise<readonly CredentialFile[] | null>;
  loadOwnEnv?: (scope: ScopeId) => Promise<NodeJS.ProcessEnv | null>;
}

export async function prepareClaudeCredentials(
  input: PrepareClaudeCredentialsInput,
): Promise<{ deploymentAuth: boolean; env?: NodeJS.ProcessEnv }> {
  const ownFiles = input.scope && input.loadOwnFiles ? await input.loadOwnFiles(input.scope) : null;
  const ownEnv = input.scope && input.loadOwnEnv ? await input.loadOwnEnv(input.scope) : null;
  const decision = claudeCredentialDecision({
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.deploymentScope ? { deploymentScope: input.deploymentScope } : {}),
    ownFiles,
    ownEnv,
  });
  if (decision.kind === "refuse") throw new NonRetryableTurnError(decision.reason);
  if (decision.kind === "deployment") return { deploymentAuth: true };
  if (!decision.files) return { deploymentAuth: false, ...(decision.env ? { env: decision.env } : {}) };

  const root = resolve(input.jail);
  for (const file of decision.files) {
    const target = resolve(root, file.path);
    const rel = relative(root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new NonRetryableTurnError(`refusing a Claude credential path that escapes the jail: ${file.path}`);
    }
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(file.contentBase64, "base64"), { mode: 0o600 });
    if (input.identity) {
      const chown = input.chown ?? chownSync;
      chown(dir, input.identity.uid, input.identity.gid);
      chown(target, input.identity.uid, input.identity.gid);
    }
  }
  return { deploymentAuth: false };
}
