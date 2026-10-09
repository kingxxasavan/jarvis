import assert from "node:assert/strict";
import test from "node:test";
import { parseToolText, ToolTextGate } from "../src/lib/ai/toolText.ts";

test("xml-style tool call text becomes a real call and is never shown", () => {
  const gate = new ToolTextGate();
  const src = "Let me look.\n<tool_call>\n<function=pc_read_project_file>\n<parameter=project>\nread-google-sheet\n</parameter>\n<parameter=path>\nexcel_dump/sheet1.csv\n</parameter>\n</function>\n</tool_call>";
  let shown = "";
  for (let i = 0; i < src.length; i += 7) shown += gate.push(src.slice(i, i + 7));
  const { rest, calls } = gate.finish();
  shown += rest;
  assert.equal(shown.trim(), "Let me look.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "pc_read_project_file");
  assert.deepEqual(JSON.parse(calls[0].arguments), { project: "read-google-sheet", path: "excel_dump/sheet1.csv" });
});

test("json-style tool call text is parsed", () => {
  const { calls, rest } = parseToolText('<tool_call>{"name": "web_search", "arguments": {"query": "x", "n": 3}}</tool_call>');
  assert.equal(rest, "");
  assert.equal(calls[0].name, "web_search");
  assert.deepEqual(JSON.parse(calls[0].arguments), { query: "x", n: 3 });
});

test("ordinary text with angle brackets streams through", () => {
  const gate = new ToolTextGate();
  let shown = gate.push("a < b and <b>bold</b> <tool");
  shown += gate.push("s are fine");
  shown += gate.finish().rest;
  assert.equal(shown, "a < b and <b>bold</b> <tools are fine");
});
