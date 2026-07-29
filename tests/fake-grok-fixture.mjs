#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const promptFileIndex = args.indexOf("--prompt-file");
const inlineIndex = args.indexOf("-p");
const capture = {
  args,
  cwd: process.cwd(),
  promptFile: promptFileIndex === -1 ? null : args[promptFileIndex + 1],
  prompt: promptFileIndex !== -1
    ? fs.readFileSync(args[promptFileIndex + 1], "utf8")
    : (inlineIndex === -1 ? "" : args[inlineIndex + 1])
};

if (process.env.FAKE_GROK_CAPTURE) {
  fs.writeFileSync(process.env.FAKE_GROK_CAPTURE, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

process.stderr.write("fake grok progress\n");
const delay = Number(process.env.FAKE_GROK_DELAY_MS || 0);
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
process.stdout.write(process.env.FAKE_GROK_OUTPUT || "FAKE_GROK_OK\n");
process.exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || 0);
