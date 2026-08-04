import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCredentialDecision,
  claudeCredentialOwner,
  prepareClaudeCredentials,
} from "../src/harness/claude-credentials.ts";
import { deviceFlowCredOwner } from "../src/credentials/device-flow-persist.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { scopeId } from "../src/types.ts";

const RYAN = scopeId("personal", "sternryan@github");
const RYN = scopeId("personal", "NyrW@github");
const OWN = [{ path: ".claude/.credentials.json", contentBase64: "e30=" }];

test("a scope with its own login uses it", () => {
  const decision = claudeCredentialDecision({ scope: RYN, deploymentScope: RYAN, ownFiles: OWN });
  assert.equal(decision.kind, "own");
  assert.deepEqual(decision.kind === "own" ? decision.files : null, OWN);
});

test("the deployment owner keeps the deployment credential when it has no login of its own", () => {
  assert.equal(claudeCredentialDecision({ scope: RYAN, deploymentScope: RYAN, ownFiles: null }).kind, "deployment");
});

test("its own login wins over the deployment credential, even for the deployment owner", () => {
  assert.equal(claudeCredentialDecision({ scope: RYAN, deploymentScope: RYAN, ownFiles: OWN }).kind, "own");
});

test("a scope that is neither the deployment owner nor logged in is refused, never billed to the owner", () => {
  const decision = claudeCredentialDecision({ scope: RYN, deploymentScope: RYAN, ownFiles: null });
  assert.equal(decision.kind, "refuse");
});

test("with no deployment owner declared, an unmapped scope is refused rather than silently sharing", () => {
  assert.equal(claudeCredentialDecision({ scope: RYN, ownFiles: null }).kind, "refuse");
});

test("an undefined scope is refused rather than treated as the deployment owner", () => {
  assert.equal(claudeCredentialDecision({ deploymentScope: RYAN, ownFiles: null }).kind, "refuse");
});

test("an own login is materialized into the jail's Claude config dir, 0600, with deployment auth withheld", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-"));
  try {
    const result = await prepareClaudeCredentials({
      scope: RYN,
      deploymentScope: RYAN,
      jail,
      loadOwnFiles: async () => [
        { path: ".claude/.credentials.json", contentBase64: Buffer.from('{"accessToken":"RYN"}').toString("base64") },
      ],
    });

    assert.equal(result.deploymentAuth, false);
    const written = join(jail, ".claude/.credentials.json");
    assert.equal(readFileSync(written, "utf8"), '{"accessToken":"RYN"}');
    assert.equal(statSync(written).mode & 0o777, 0o600);
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("the deployment owner keeps deployment auth and gets no credential file written into the jail", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-"));
  try {
    const result = await prepareClaudeCredentials({
      scope: RYAN,
      deploymentScope: RYAN,
      jail,
      loadOwnFiles: async () => null,
    });

    assert.equal(result.deploymentAuth, true);
    assert.equal(existsSync(join(jail, ".claude/.credentials.json")), false);
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("a scope with no login and no claim on the deployment token is refused before any Claude process starts", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-"));
  try {
    await assert.rejects(
      () => prepareClaudeCredentials({ scope: RYN, deploymentScope: RYAN, jail, loadOwnFiles: async () => null }),
      (error: Error) => {
        assert.equal(error instanceof NonRetryableTurnError, true);
        assert.match(error.message, /claude login/);
        return true;
      },
    );
    assert.equal(existsSync(join(jail, ".claude/.credentials.json")), false);
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("with no credential resolver wired at all, only the deployment owner may run claude", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-"));
  try {
    assert.equal((await prepareClaudeCredentials({ scope: RYAN, deploymentScope: RYAN, jail })).deploymentAuth, true);
    await assert.rejects(() => prepareClaudeCredentials({ scope: RYN, deploymentScope: RYAN, jail }));
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("a credential path that escapes the jail is refused, not written outside it", async () => {
  const parent = mkdtempSync(join(tmpdir(), "claude-cred-esc-"));
  const jail = join(parent, "jail");
  mkdirSync(jail);
  try {
    await assert.rejects(
      () =>
        prepareClaudeCredentials({
          scope: RYN,
          deploymentScope: RYAN,
          jail,
          loadOwnFiles: async () => [
            { path: "../escaped.json", contentBase64: Buffer.from("PWNED").toString("base64") },
          ],
        }),
      /escapes the jail/,
    );
    assert.equal(existsSync(join(parent, "escaped.json")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the credential and its directory are handed to the identity the Claude process runs as", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-own-"));
  const chowned: Array<{ path: string; uid: number; gid: number }> = [];
  try {
    await prepareClaudeCredentials({
      scope: RYN,
      deploymentScope: RYAN,
      jail,
      identity: { uid: 65534, gid: 65534 },
      chown: (path, uid, gid) => chowned.push({ path, uid, gid }),
      loadOwnFiles: async () => [
        { path: ".claude/.credentials.json", contentBase64: Buffer.from("{}").toString("base64") },
      ],
    });

    assert.deepEqual(
      chowned.map((entry) => entry.path).sort(),
      [join(jail, ".claude"), join(jail, ".claude/.credentials.json")].sort(),
    );
    assert.ok(chowned.every((entry) => entry.uid === 65534 && entry.gid === 65534));
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("with no process identity there is nothing to hand the credential to", async () => {
  const jail = mkdtempSync(join(tmpdir(), "claude-cred-noown-"));
  const chowned: string[] = [];
  try {
    await prepareClaudeCredentials({
      scope: RYN,
      deploymentScope: RYAN,
      jail,
      chown: (path) => chowned.push(path),
      loadOwnFiles: async () => [
        { path: ".claude/.credentials.json", contentBase64: Buffer.from("{}").toString("base64") },
      ],
    });
    assert.deepEqual(chowned, []);
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
});

test("a personal scope's Claude login belongs to the person, a shared scope's to the scope", () => {
  assert.equal(claudeCredentialOwner(scopeId("personal", "NyrW@github")), "NyrW@github");
  assert.equal(claudeCredentialOwner(scopeId("channel", "C1")), scopeId("channel", "C1"));
});

test("the owner a Claude login loads under is the owner it was captured under", () => {
  const personal = scopeId("personal", "NyrW@github");
  assert.equal(claudeCredentialOwner(personal), deviceFlowCredOwner(personal, "NyrW@github"));

  const channel = scopeId("channel", "C1");
  assert.equal(claudeCredentialOwner(channel), deviceFlowCredOwner(channel, "NyrW@github"));
});
