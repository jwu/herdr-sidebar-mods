// The release check both panels share (mods/*/update.js): once a day, one toast
// per version, a gear dot until the dialog is opened, quiet when offline.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadMod, uiState } from "./load-mod.mjs";

function setup(values = {}) {
  const store = new Map(Object.entries(values));
  const toasts = [];
  const loaded = loadMod("sidebar-spaces", {
    shared: (key) => structuredClone(store.get(key)),
    setShared: (key, value) => { store.set(key, value); },
    notify: (n) => { toasts.push(n); return "id"; },
  });
  const module = (file) => loaded.vm.moduleImports.get(new URL(`../mods/sidebar-spaces/${file}`, import.meta.url).href);
  return { store, toasts, update: module("update.js"), settings: module("settings.js") };
}

function feed(tag, { ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    // GitHub refuses a request without a User-Agent; Herdr's fetch sends none.
    assert.match(options?.headers?.["user-agent"] ?? "", /^herdr-ultimate-sidebar\//);
    if (tag instanceof Error) throw tag;
    return { ok, status: ok ? 200 : 403, json: async () => ({ tag_name: tag, html_url: `https://github.com/jwu/herdr-sidebar-mods/releases/tag/${tag}` }) };
  };
  return { calls, fetchImpl };
}

test("VERSION is a plain x.y.z release", () => {
  const { update } = setup();
  assert.match(update.VERSION, /^\d+\.\d+\.\d+$/);
});

test("newer compares numbers, not text", () => {
  const { update } = setup();
  assert.equal(update.newer("0.10.0", "0.9.9"), true);
  assert.equal(update.newer("v1.0.0", "1.0.0"), false);
  assert.equal(update.newer("0.8.1", "0.8.2"), false);
});

test("a newer release is announced once, and asked for at most once a day", async () => {
  const { store, toasts, update } = setup();
  const next = "v99.0.0";
  const gh = feed(next);
  let u = await update.checkForUpdate({ fetchImpl: gh.fetchImpl });
  assert.equal(gh.calls.length, 1);
  assert.equal(u.available, true);
  assert.equal(u.latest, "99.0.0");
  assert.equal(u.unseen, true);
  assert.equal(toasts.length, 1);

  await update.checkForUpdate({ fetchImpl: gh.fetchImpl });
  assert.equal(gh.calls.length, 1, "the day's answer is reused");

  u = await update.checkForUpdate({ force: true, fetchImpl: gh.fetchImpl });
  assert.equal(gh.calls.length, 2, "Check now asks again");
  assert.equal(toasts.length, 1, "the same version is not toasted twice");

  update.markUpdateSeen();
  assert.equal(update.updateState().unseen, false);
  assert.equal(update.updateState().available, true, "seen still shows in the dialog");
  assert.equal(store.get(update.UPDATE_STATE).seen, "99.0.0");
});

test("the installed version or an older one is up to date", async () => {
  const { toasts, update } = setup();
  const u = await update.checkForUpdate({ fetchImpl: feed(`v${update.VERSION}`).fetchImpl });
  assert.equal(u.available, false);
  assert.equal(u.error, null);
  assert.equal(toasts.length, 0);
});

test("offline or a bad answer stays quiet and retries within the hour", async () => {
  for (const gh of [feed(new Error("offline")), feed("v9.9.9", { ok: false }), feed("nightly")]) {
    const { store, toasts, update } = setup();
    const u = await update.checkForUpdate({ fetchImpl: gh.fetchImpl });
    assert.equal(u.available, false);
    assert.equal(toasts.length, 0);
    const at = store.get(update.UPDATE_STATE).checkedAt;
    assert.ok(Date.now() - at > 22 * 3600 * 1000, "the next check is due within an hour");
    assert.ok(u.error, "the reason is kept for the settings row");
  }
});

test("daily checks off: nothing is asked unless forced", async () => {
  const { update } = setup({ "sidebar.updates.check": false });
  const gh = feed("v99.0.0");
  await update.checkForUpdate({ fetchImpl: gh.fetchImpl });
  assert.equal(gh.calls.length, 0);
  await update.checkForUpdate({ force: true, fetchImpl: gh.fetchImpl });
  assert.equal(gh.calls.length, 1);
});

test("the gear shows a dot for an unseen release, and opening it clears the dot", async () => {
  const { update, settings } = setup();
  const theme = { hover: "#333", accent: "#00f" };
  const dot = (button) => uiState(button).children.some((c) => uiState(c)?.id === "sidebar-update-dot");
  assert.equal(dot(settings.settingsButton(theme, () => {})), false);

  await update.checkForUpdate({ fetchImpl: feed("v99.0.0").fetchImpl });
  let opened = 0;
  const button = settings.settingsButton(theme, () => opened++);
  assert.equal(dot(button), true);
  uiState(button).handlers.on_click({}, {});
  assert.equal(opened, 1);
  assert.equal(dot(settings.settingsButton(theme, () => {})), false);
});

test("the release workflow refuses a tag that differs from VERSION", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /update\.js/);
});
