import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT, run } from "./helpers.mjs";

test("version metadata is synchronized", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const result = run(process.execPath, [path.join(ROOT, "scripts", "bump-version.mjs"), "--check"], {
    cwd: ROOT
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`All version metadata matches ${version.replace(/\./g, "\\.")}`)
  );
});
