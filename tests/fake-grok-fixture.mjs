#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const promptFileIndex = args.indexOf("--prompt-file");
const inlineIndex = args.indexOf("-p");
const jsonSchemaIndex = args.indexOf("--json-schema");
const sandboxIndex = args.indexOf("--sandbox");
const outputFormatIndex = args.indexOf("--output-format");
const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const continueIndex = args.indexOf("--continue");
const sessionId = sessionIdIndex === -1
  ? (resumeIndex === -1 ? null : args[resumeIndex + 1])
  : args[sessionIdIndex + 1];

if (args.includes("--help")) {
  process.stdout.write(process.env.FAKE_GROK_HELP || [
    "Usage: fake-grok",
    "  --json-schema <SCHEMA>",
    "  --sandbox <PROFILE>",
    "  --output-format plain|json|streaming-json",
    ""
  ].join("\n"));
  process.exit(0);
}

const capture = {
  args,
  cwd: process.cwd(),
  jsonSchema: jsonSchemaIndex === -1 ? null : args[jsonSchemaIndex + 1],
  sandbox: sandboxIndex === -1 ? null : args[sandboxIndex + 1],
  outputFormat: outputFormatIndex === -1 ? null : args[outputFormatIndex + 1],
  sessionId,
  resumeSessionId: resumeIndex === -1 ? null : args[resumeIndex + 1],
  continued: continueIndex !== -1,
  promptFile: promptFileIndex === -1 ? null : args[promptFileIndex + 1],
  prompt: promptFileIndex !== -1
    ? fs.readFileSync(args[promptFileIndex + 1], "utf8")
    : (inlineIndex === -1 ? "" : args[inlineIndex + 1])
};

if (process.env.FAKE_GROK_CAPTURE) {
  fs.writeFileSync(process.env.FAKE_GROK_CAPTURE, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

process.stderr.write("fake grok progress\n");
if (process.env.FAKE_GROK_FAIL_BEFORE_SESSION === "1") {
  process.stderr.write("fake grok failed before creating a session\n");
  process.exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || 1);
} else if (capture.outputFormat === "streaming-json") {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  if (process.env.FAKE_GROK_MALFORMED_EVENT === "1") {
    process.stdout.write("not-json-stream-event\n");
  }
  if (process.env.FAKE_GROK_UNKNOWN_EVENT === "1") {
    process.stdout.write(`${JSON.stringify({ type: "future_event", detail: "preserve me" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "tool_use", name: "read_file", session_id: sessionId })}\n`);
}
const delay = Number(process.env.FAKE_GROK_DELAY_MS || 0);
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
const defaultReview = {
  verdict: "approve",
  summary: "No actionable defects found.",
  findings: [],
  next_steps: ["Retain the current test coverage."]
};
const requestedSchema = capture.jsonSchema ? JSON.parse(capture.jsonSchema) : null;
const defaultStructuredOutput = requestedSchema?.properties?.decision
  ? { decision: "allow", reason: "No blocking issue was introduced in the previous turn." }
  : defaultReview;
if (process.env.FAKE_GROK_FAIL_BEFORE_SESSION !== "1") {
  const output = process.env.FAKE_GROK_OUTPUT || "FAKE_GROK_OK";
  if (capture.outputFormat === "streaming-json") {
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: output }] }, session_id: sessionId })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: output, session_id: sessionId })}\n`);
  } else {
    process.stdout.write(process.env.FAKE_GROK_OUTPUT != null
      ? `${process.env.FAKE_GROK_OUTPUT}\n`
      : (jsonSchemaIndex === -1 ? `${output}\n` : `${JSON.stringify(defaultStructuredOutput)}\n`));
  }
  process.exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || 0);
}
