import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ROOT, run } from "./helpers.mjs";

test("version metadata is synchronized", () => {
  const result = run(process.execPath, [path.join(ROOT, "scripts", "bump-version.mjs"), "--check"], {
    cwd: ROOT
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All version metadata matches 0\.4\.1/);
});
