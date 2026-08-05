import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/model/pi-models.ts";

const LANE_URL = process.env.QM_SMITHY_LIVE_URL;

test("a pi-ai openai model retargeted at a smithy lane completes a tool call", { skip: !LANE_URL }, async () => {
  const template = resolveModel("gpt-5.6-terra");
  assert.ok(template, "template model must resolve");
  const response = await fetch(`${LANE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local-heavy",
      messages: [{ role: "user", content: "What files are in /tmp? Use the tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "list_dir",
            description: "List a directory",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
      max_tokens: 200,
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ function: { name: string } }> } }>;
  };
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls?.[0]?.function.name, "list_dir");
});
