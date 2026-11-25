// The release tooling: CHANGELOG.md sections (scripts/changelog.mjs) and the
// version both copies of update.js carry.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cut, notes, unreleased } from "../scripts/changelog.mjs";

const SAMPLE = `# Changelog

Intro.

## Unreleased

- New thing.

## 0.9.0 - 2026-11-01

- Older thing.
`;

test("cut moves Unreleased under the version and leaves an empty Unreleased", () => {
  const text = cut(SAMPLE, "0.9.1", "2026-11-25");
  assert.equal(unreleased(text), "");
  assert.equal(notes(text, "0.9.1"), "- New thing.");
  assert.equal(notes(text, "0.9.0"), "- Older thing.");
  assert.match(text, /## Unreleased\n\n## 0\.9\.1 - 2026-11-25\n\n- New thing\.\n\n## 0\.9\.0/);
});

test("cut refuses an empty Unreleased or a version already listed", () => {
  assert.throws(() => cut(cut(SAMPLE, "0.9.1", "d"), "0.9.2", "d"), /nothing under/);
  assert.throws(() => cut(SAMPLE, "0.9.0", "d"), /already has/);
});

test("the repository's CHANGELOG.md parses", () => {
  const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(text, /^## Unreleased$/m);
});

test("both update.js files carry the same plain x.y.z VERSION", () => {
  const version = name => /^export const VERSION = "(\d+\.\d+\.\d+)";$/m
    .exec(readFileSync(new URL(`../mods/${name}/update.js`, import.meta.url), "utf8"))?.[1];
  assert.ok(version("sidebar-spaces"));
  assert.equal(version("sidebar-agents"), version("sidebar-spaces"));
});
