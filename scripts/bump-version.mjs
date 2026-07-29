#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    file: "package.json",
    paths: [["version"]]
  },
  {
    file: "package-lock.json",
    paths: [["version"], ["packages", "", "version"]]
  },
  {
    file: "plugins/grok/.claude-plugin/plugin.json",
    paths: [["version"]]
  },
  {
    file: ".claude-plugin/marketplace.json",
    paths: [["metadata", "version"], ["plugins", "grok", "version"]]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "  node scripts/bump-version.mjs --check [version] --root <dir>"
  ].join("\n");
}

function parseArgs(argv) {
  const result = { check: false, root: process.cwd(), version: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      result.check = true;
    } else if (value === "--root") {
      if (!argv[index + 1]) {
        throw new Error("--root requires a directory.");
      }
      result.root = path.resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      result.help = true;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else if (result.version) {
      throw new Error(`Unexpected extra argument: ${value}`);
    } else {
      result.version = value;
    }
  }
  return result;
}

function getPathValue(document, keyPath) {
  if (keyPath[0] === "plugins" && keyPath[1] === "grok") {
    return document.plugins?.find((plugin) => plugin?.name === "grok")?.version;
  }
  return keyPath.reduce((value, key) => value?.[key], document);
}

function setPathValue(document, keyPath, version) {
  if (keyPath[0] === "plugins" && keyPath[1] === "grok") {
    const plugin = document.plugins?.find((entry) => entry?.name === "grok");
    if (!plugin) {
      throw new Error("Marketplace manifest does not contain the grok plugin.");
    }
    plugin.version = version;
    return;
  }

  let target = document;
  for (const key of keyPath.slice(0, -1)) {
    if (!target?.[key] || typeof target[key] !== "object") {
      throw new Error(`Missing version path ${keyPath.join(".")}.`);
    }
    target = target[key];
  }
  target[keyPath.at(-1)] = version;
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(root, file, document) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semantic version such as 0.1.0, got: ${version}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const packageVersion = readJson(options.root, "package.json").version;
  const version = options.version ?? (options.check ? packageVersion : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  const mismatches = [];
  const changed = [];
  for (const target of TARGETS) {
    const document = readJson(options.root, target.file);
    for (const keyPath of target.paths) {
      const actual = getPathValue(document, keyPath);
      if (options.check && actual !== version) {
        mismatches.push(`${target.file} ${keyPath.join(".")}: expected ${version}, found ${actual ?? "<missing>"}`);
      } else if (!options.check) {
        setPathValue(document, keyPath, version);
      }
    }
    if (!options.check) {
      writeJson(options.root, target.file, document);
      changed.push(target.file);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
  }
  console.log(
    options.check
      ? `All version metadata matches ${version}.`
      : `Set version metadata to ${version}: ${changed.join(", ")}.`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
