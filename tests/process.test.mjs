import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cancelTrackedJob } from "../plugins/grok/scripts/lib/job-control.mjs";
import {
  binaryAvailable,
  isProcessAlive,
  processIdentityMatches,
  quoteWindowsCmdArg,
  resolveExecutable,
  resolveSpawnInvocation,
  terminateProcessTree
} from "../plugins/grok/scripts/lib/process.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { initRepo, tempDir } from "./helpers.mjs";

test("POSIX termination falls back from a missing process group to the process", () => {
  const calls = [];
  const result = terminateProcessTree(1234, {
    platform: "linux",
    runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }),
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
    runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }),
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(result.attempted, true);
  assert.equal(result.delivered, false);
});

test("Windows taskkill termination reports success, missing process, and ENOENT fallback", () => {
  const success = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl(command, args) {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/PID", "4242", "/T", "/F"]);
      return { status: 0, stdout: "SUCCESS: The process with PID 4242 has been terminated.", stderr: "", error: null };
    }
  });
  assert.equal(success.method, "taskkill");
  assert.equal(success.delivered, true);
  assert.equal(success.attempted, true);

  const missing = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl: () => ({
      status: 128,
      stdout: "",
      stderr: "ERROR: The process \"4242\" not found.",
      error: null
    })
  });
  assert.equal(missing.method, "taskkill");
  assert.equal(missing.delivered, false);
  assert.equal(missing.attempted, true);

  const calls = [];
  const enoent = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl: () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      return { status: 1, stdout: "", stderr: "", error };
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });
  assert.deepEqual(calls, [[4242, "SIGTERM"]]);
  assert.equal(enoent.method, "process");
  assert.equal(enoent.delivered, true);
});

test("POSIX termination also signals recorded child PIDs and pgrep descendants", () => {
  const calls = [];
  const result = terminateProcessTree(100, {
    platform: "linux",
    childPids: [200],
    runCommandImpl(command, args) {
      if (command === "pgrep" && args[0] === "-P" && args[1] === "100") {
        return { status: 0, stdout: "300\n", stderr: "", error: null };
      }
      return { status: 1, stdout: "", stderr: "", error: null };
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  assert.equal(result.delivered, true);
  assert.ok(calls.some((entry) => entry[0] === 100));
  assert.ok(calls.some((entry) => entry[0] === 200));
  assert.ok(calls.some((entry) => entry[0] === 300));
  assert.match(result.method, /tree|process/);
});

test("isProcessAlive accepts optional identity guards without changing default behavior", () => {
  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      }
    }),
    true
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedName: "node",
      getIdentityImpl: () => ({ pid: 1, name: "node", startedAtMs: 1_000 })
    }),
    true
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedName: "node",
      getIdentityImpl: () => ({ pid: 1, name: "chrome", startedAtMs: 1_000 })
    }),
    false
  );

  assert.equal(
    isProcessAlive(1, {
      killImpl() {
        /* signal 0 success */
      },
      expectedStartedAtMs: 1_000,
      getIdentityImpl: () => ({ pid: 1, name: "node", startedAtMs: 999_999_999 })
    }),
    false
  );

  assert.equal(
    processIdentityMatches(
      { pid: 9, name: "grok", startedAtMs: 5_000 },
      { expectedName: "grok.exe", expectedStartedAtMs: 5_100 }
    ),
    true
  );
});

test("terminateProcessTree refuses to kill a PID that fails identity checks", () => {
  const calls = [];
  const result = terminateProcessTree(55, {
    platform: "linux",
    expectedName: "node",
    getIdentityImpl: () => ({ pid: 55, name: "unrelated", startedAtMs: 1 }),
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });
  assert.equal(result.delivered, false);
  assert.equal(result.method, "identity-mismatch");
  assert.deepEqual(calls, []);
});

test("Windows executable resolution prefers .exe and quotes .cmd for cmd.exe", () => {
  const exe = resolveExecutable("grok", {
    platform: "win32",
    runCommandImpl: () => ({
      status: 0,
      stdout: "C:\\npm\\grok.cmd\nC:\\tools\\grok.exe\n",
      stderr: "",
      error: null
    })
  });
  assert.equal(exe, "C:\\tools\\grok.exe");

  const cmdOnly = resolveExecutable("grok", {
    platform: "win32",
    runCommandImpl: () => ({
      status: 0,
      stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd\n",
      stderr: "",
      error: null
    })
  });
  assert.equal(cmdOnly, "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd");

  const invocation = resolveSpawnInvocation(
    "grok",
    ["-p", "hello & del /q secrets"],
    {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      runCommandImpl: () => ({
        status: 0,
        stdout: "C:\\npm\\grok.cmd\n",
        stderr: "",
        error: null
      })
    }
  );
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^"C:\\npm\\grok\.cmd" "-p" "hello & del \/q secrets"$/);
  // Prompt metacharacters stay inside quotes — no shell:true injection surface.
  assert.equal(quoteWindowsCmdArg('say "hi"'), "\"say \"\"hi\"\"\"");

  const linux = resolveSpawnInvocation("grok", ["--version"], { platform: "linux" });
  assert.equal(linux.command, "grok");
  assert.deepEqual(linux.args, ["--version"]);
  assert.equal(linux.shell, false);
});

test("binaryAvailable uses resolved Windows path without requiring shell:true", () => {
  const calls = [];
  const result = binaryAvailable("grok", ["--version"], {
    platform: "win32",
    runCommandImpl(command, args, options = {}) {
      calls.push({ command, args, shell: options.shell ?? false });
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: "C:\\tools\\grok.exe\n",
          stderr: "",
          error: null
        };
      }
      return {
        status: 0,
        stdout: "grok 0.2.114\n",
        stderr: "",
        error: null
      };
    }
  });
  assert.equal(result.available, true);
  assert.equal(result.command, "C:\\tools\\grok.exe");
  assert.ok(calls.some((call) => call.command === "C:\\tools\\grok.exe" && call.shell === false));
});

test("cancel helper does not report cancelled when termination is not delivered", (t) => {
  const root = tempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initRepo(repo);
  const previousHome = process.env.GROK_COMPANION_HOME;
  process.env.GROK_COMPANION_HOME = path.join(root, "state");
  t.after(() => {
    if (previousHome == null) {
      delete process.env.GROK_COMPANION_HOME;
    } else {
      process.env.GROK_COMPANION_HOME = previousHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = {
    id: "task-cancel-failed",
    kind: "task",
    title: "Task",
    status: "running",
    phase: "running",
    pid: 1234,
    cwd: repo,
    workspaceRoot: repo,
    summary: "test",
    createdAt: new Date().toISOString()
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  const result = cancelTrackedJob(repo, job, {
    terminateImpl: () => ({ attempted: true, delivered: false, method: "test-signal" }),
    isProcessAliveImpl: () => true
  });
  const stored = readJobFile(resolveJobFile(repo, job.id));
  assert.equal(result.status, "cancel-failed");
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "cancel-failed");
  assert.equal(stored.terminationDelivered, false);
  assert.equal(stored.terminationMethod, "test-signal");
  assert.ok(stored.cancelRequestedAt);
  assert.match(stored.errorMessage, /still running/);

  const goneJob = { ...job, id: "task-already-exited", pid: 5678 };
  writeJobFile(repo, goneJob.id, goneJob);
  upsertJob(repo, goneJob);
  const gone = cancelTrackedJob(repo, goneJob, {
    terminateImpl: () => ({ attempted: true, delivered: false, method: null }),
    isProcessAliveImpl: () => false
  });
  const goneStored = readJobFile(resolveJobFile(repo, goneJob.id));
  assert.equal(gone.status, "cancelled");
  assert.equal(gone.delivered, false);
  assert.equal(goneStored.terminationMethod, "already-exited");
  assert.ok(goneStored.cancelledAt);
});
