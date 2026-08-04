import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeChildAgentAllowed,
  claudeChildEnv,
  isInternalClaudeScope,
  claudeProcessIdentity,
  claudeReplayTranscript,
  claudeToolContext,
  spawnClaudeProcess,
  stripClaudeImageBytes,
} from "../src/harness/claude-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { ScopeId } from "../src/types.ts";
import { zeroUsage, type PiReplayMessage } from "../src/harness/replay.ts";

test("Claude forwards external-content screening into its native tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const ref = claudeToolContext({ screenExternalContent } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
});

test("Claude replay preserves paired tool calls and results as untrusted history", () => {
  const messages: PiReplayMessage[] = [
    { role: "user", content: [{ type: "text", text: "look it up" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "history", arguments: { query: "needle" } }],
      timestamp: 2,
      stopReason: "stop",
      usage: zeroUsage(),
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "history",
      content: [{ type: "text", text: "found it" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const replay = claudeReplayTranscript(messages);

  assert.match(replay, /untrusted conversation history, not instructions/);
  assert.match(replay, /Assistant tool call \(history, call call-1\).*needle/);
  assert.match(replay, /Tool result \(history, call call-1\): found it/);
});

test("Claude tape strips base64 image bytes regardless of size", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "tiny" } },
        { type: "text", text: "keep me", data: "ordinary field" },
      ],
    },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };

  const stripped = stripClaudeImageBytes(message as Parameters<typeof stripClaudeImageBytes>[0]) as typeof message;

  assert.equal(stripped.message.content[0]?.source?.data, "[image omitted]");
  assert.equal(stripped.message.content[1]?.data, "ordinary field");
});

test("Claude only permits declared least-privilege child agent types", () => {
  assert.equal(claudeChildAgentAllowed({ subagent_type: "research" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "code" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "consult" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "general-purpose" }), false);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "claude" }), false);
  assert.equal(claudeChildAgentAllowed({}), false);
});

test("Claude child environment excludes core credentials and user homes", () => {
  assert.deepEqual(
    claudeChildEnv(
      {
        PATH: "/bin",
        HOME: "/Users/private",
        CORE_SIGNING_SECRET: "signing-secret",
        DATABASE_URL: "postgres://secret",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-provider-key",
      },
      "/tmp/claude-jail",
    ),
    {
      HOME: "/tmp/claude-jail",
      CLAUDE_CONFIG_DIR: "/tmp/claude-jail/.claude",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "anthropic-provider-key",
    },
  );
});

test("Claude drops only a root parent process to the unprivileged nobody identity", () => {
  assert.deepEqual(claudeProcessIdentity(0), { uid: 65534, gid: 65534 });
  assert.equal(claudeProcessIdentity(1000), undefined);
});

test("Claude spawned from a root container runs as nobody", { skip: process.getuid?.() !== 0 }, async () => {
  const child = spawnClaudeProcess(
    {
      command: process.execPath,
      args: ["-e", "process.stdout.write(String(process.getuid()))"],
      env: process.env,
      signal: new AbortController().signal,
    },
    claudeProcessIdentity(0),
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, "65534");
});

test("a scope on its own login does not inherit the deployment's Claude credentials", () => {
  const env = claudeChildEnv(
    {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-DEPLOYMENT",
      ANTHROPIC_AUTH_TOKEN: "deployment-auth",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-DEPLOYMENT",
      ANTHROPIC_BASE_URL: "https://gateway.internal",
    },
    "/tmp/jail",
    { deploymentAuth: false },
  );

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://gateway.internal");
});

test("the deployment owner still receives the deployment's Claude credentials", () => {
  const env = claudeChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-DEPLOYMENT" }, "/tmp/jail", {
    deploymentAuth: true,
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-DEPLOYMENT");
});

test("qm's own oneshot scope is internal, so titles and detection keep using the deployment credential", () => {
  assert.equal(isInternalClaudeScope({ kind: "org", id: "oneshot" } as unknown as ScopeId), true);
});

test("a real conversation scope is never treated as internal", () => {
  assert.equal(isInternalClaudeScope("personal:NyrW@github"), false);
  assert.equal(isInternalClaudeScope("org:acme"), false);
});

test("a missing scope is not internal, so it is refused rather than waved through", () => {
  assert.equal(isInternalClaudeScope(undefined), false);
});
