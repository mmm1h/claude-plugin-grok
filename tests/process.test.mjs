import assert from "node:assert/strict";
import test from "node:test";

import { terminateProcessTree } from "../plugins/grok/scripts/lib/process.mjs";

test("POSIX termination falls back from a missing process group to the process", () => {
  const calls = [];
  const result = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  assert.deepEqual(calls, [[-1234, "SIGTERM"], [1234, "SIGTERM"]]);
  assert.equal(result.delivered, true);
  assert.equal(result.method, "process");
});

test("termination reports an already exited process without throwing", () => {
  const result = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(result.attempted, true);
  assert.equal(result.delivered, false);
});
