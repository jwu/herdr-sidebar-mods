#!/usr/bin/env node
// CHANGELOG.md helper for scripts/release.sh and the release workflow.
//
//   node scripts/changelog.mjs unreleased       prints the "## Unreleased" entries (exit 1 if none)
//   node scripts/changelog.mjs cut <x.y.z>      renames "## Unreleased" to "## <x.y.z> - <date>"
//                                               and starts a new empty "## Unreleased" above it
//   node scripts/changelog.mjs notes <x.y.z>    prints that version's entries (exit 1 if missing)

import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../CHANGELOG.md", import.meta.url);
const HEADING = /^## (.+)$/gm;

// [{ title, body, start, end }] for every "## " section.
export function sections(text) {
  const found = [...text.matchAll(HEADING)];
  return found.map((m, i) => ({
    title: m[1].trim(),
    start: m.index,
    end: i + 1 < found.length ? found[i + 1].index : text.length,
    body: text.slice(m.index + m[0].length, i + 1 < found.length ? found[i + 1].index : text.length).trim(),
  }));
}

const version = title => title.split(/\s+/)[0];

export function unreleased(text) {
  return sections(text).find(s => s.title === "Unreleased")?.body ?? "";
}

export function notes(text, v) {
  return sections(text).find(s => version(s.title) === v)?.body ?? "";
}

export function cut(text, v, date) {
  const s = sections(text).find(x => x.title === "Unreleased");
  if (!s || !s.body) throw new Error("CHANGELOG.md has nothing under ## Unreleased");
  if (notes(text, v)) throw new Error(`CHANGELOG.md already has ${v}`);
  return `${text.slice(0, s.start)}## Unreleased\n\n## ${v} - ${date}\n\n${s.body}\n\n${text.slice(s.end)}`.replace(/\n{3,}/g, "\n\n");
}

if (process.argv[1]?.endsWith("changelog.mjs")) {
  const [command, v] = process.argv.slice(2);
  const text = readFileSync(FILE, "utf8");
  const fail = message => { console.error(message); process.exit(1); };
  if (command === "unreleased") {
    const body = unreleased(text);
    if (!body) fail("CHANGELOG.md has nothing under ## Unreleased");
    console.log(body);
  } else if (command === "notes") {
    const body = notes(text, v);
    if (!body) fail(`CHANGELOG.md has no entries for ${v}`);
    console.log(body);
  } else if (command === "cut") {
    if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) fail("usage: changelog.mjs cut <x.y.z>");
    try {
      writeFileSync(FILE, cut(text, v, new Date().toISOString().slice(0, 10)));
    } catch (e) { fail(e.message); }
  } else {
    fail("usage: changelog.mjs unreleased | cut <x.y.z> | notes <x.y.z>");
  }
}
