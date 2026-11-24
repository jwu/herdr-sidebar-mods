// The shared git cache both panels read and write (mods/*/main.js, the block
// between the "shared git cache" markers): one answer per place, refs-only looks
// between worktree walks, and shared answers showing up in the other panel
// without asking Git again.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadMod, makeInstance, makeDeferred, waitFor, flushTurns } from "./load-mod.mjs";

const ROOT = new URL("../", import.meta.url);
const source = (name) => readFileSync(fileURLToPath(new URL(`mods/${name}/main.js`, ROOT)), "utf8");
const keyOf = (on, cwd) => JSON.stringify([on ?? null, cwd]);
const now = () => Date.now();
const CACHE = "sidebar.git.v1";

// herdr's shared state, as both mods see it: one store, values by key.
function sharedStore() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    shared: (key) => structuredClone(values.get(key)),
    setShared: (key, value) => {
      if (key === CACHE) writes.push(value);
      values.set(key, value);
    },
    places: () => values.get(CACHE)?.places ?? {},
    seed: (places) => values.set(CACHE, { places }),
  };
}

const info = (over = {}) => ({
  name: "repo",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  dirty: 0,
  conflicts: 0,
  repo: JSON.stringify([null, "/repo/.git"]),
  linked: false,
  ...over,
});

// A record as the store keeps it.
const record = (over = {}) => ({ at: now(), refsAt: now(), dirtyAt: now(), info: info(), unsure: false, ...over });

// Answers the way Git does, per place: each test overrides what it cares about.
// The first walk is two rev-parse runs and a status; later walks use status.
// A refs look asks for a branch, an upstream and the ahead/behind counts.
function responds(answers = {}) {
  const calls = [];
  const exec = async (_cmd, args, opts) => {
    const line = args.join(" ");
    calls.push(line);
    const a = answers[opts.cwd] ?? {};
    if (line.includes("--show-toplevel")) return a.top ?? { code: 0, stdout: `${opts.cwd}\n`, stderr: "" };
    if (line.includes("--git-common-dir")) return a.common ?? { code: 0, stdout: `${opts.cwd}/.git\n`, stderr: "" };
    if (line.includes("status")) return a.status ?? { code: 0, stdout: "# branch.head main\n", stderr: "" };
    if (line.includes("symbolic-ref")) return a.ref ?? { code: 0, stdout: "refs/heads/main\n", stderr: "" };
    if (line.includes("--symbolic-full-name")) return a.upstream ?? { code: 0, stdout: "origin/main\n", stderr: "" };
    if (line.includes("rev-list")) return a.counts ?? { code: 0, stdout: "0\t0\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

// A panel with the git state init() would set up, and no timers or commands.
function panel(name, store, overrides = {}, extra = {}) {
  const loaded = loadMod(name, { checking: () => false, ...store, ...overrides });
  const instance = makeInstance(loaded.Class, extra);
  return { ...loaded, instance };
}

function renderPanel(name, store, overrides = {}) {
  const p = loadMod(name, { ...store, ...overrides, checking: () => true });
  const instance = new p.Class();
  instance.init({}, p.context);
  return { ...p, instance, render: () => instance.render(p.context) };
}

async function refreshSpaces(p, keys) {
  p.instance.refreshGit(keys, p.context);
  await p.context.tasks.at(-1).promise;
}

test("both mods carry the same shared git cache block", () => {
  const block = (name) => {
    const text = source(name);
    const start = text.indexOf("// --- shared git cache");
    const end = text.indexOf("// --- end shared git cache ---");
    assert.ok(start >= 0 && end > start, `${name}: the block is marked`);
    return text.slice(start, end + "// --- end shared git cache ---".length);
  };
  assert.equal(block("sidebar-agents"), block("sidebar-spaces"));
});

test("a place one panel looked at shows in the other without asking Git", async () => {
  const store = sharedStore();
  const git = responds({
    "/repo": { status: { code: 0, stdout: "# branch.head feature\n# branch.ab +2 -1\n1 .M N... a\n? b\n", stderr: "" } },
  });
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  const key = keyOf(null, "/repo");
  spaces.instance.gitWalk.add(key);
  await refreshSpaces(spaces, [key]);
  assert.equal(git.calls.length, 3, "a first look is the repo and the worktree");
  assert.equal(store.places()[key].info.branch, "feature");
  assert.equal(store.places()[key].info.dirty, 2);

  // The agents panel has the same place, and asks Git nothing.
  let agentCalls = 0;
  const agents = panel("sidebar-agents", store, {
    exec: async () => {
      agentCalls++;
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  agents.instance.places = () => [[key, { on: null, cwd: "/repo" }]];
  agents.instance.refreshGit(agents.context);
  await agents.context.flush();
  assert.equal(agentCalls, 0, "a fresh answer in shared state is the answer");
  assert.equal(agents.instance.git[key].branch, "feature");
  assert.equal(agents.instance.gitAt[key], store.places()[key].at);
});

test("both panels name worktrees from a hidden bare repo after its project", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo/worktree");
  const common = "/repo/.bare";
  const git = responds({ "/repo/worktree": { common: { code: 0, stdout: common + "\n" } } });
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  spaces.instance.gitWalk.add(key);
  await refreshSpaces(spaces, [key]);
  assert.equal(spaces.instance.git[key].name, "repo");
  assert.equal(spaces.instance.git[key].linked, true);

  // A previous version's shared cache still has the old name.
  const previous = store.places()[key];
  store.seed({ [key]: { ...previous, info: { ...previous.info, name: ".bare" } } });
  const agents = panel("sidebar-agents", store, { exec: git.exec });
  agents.instance.places = () => [[key, { on: null, cwd: "/repo/worktree" }]];
  agents.instance.refreshGit(agents.context);
  await agents.context.flush();
  assert.equal(agents.instance.git[key].name, "repo");
  assert.equal(git.calls.length, 3, "the old cache can be used without asking Git again");
});

for (const walk of [true, false]) {
  test(`a peer ${walk ? "walk" : "refs read"} taken since the request satisfies it`, async () => {
    const store = sharedStore();
    const key = keyOf(null, "/queued");
    const seeded = record({ at: now() - 5000, refsAt: now() - 5000, dirtyAt: now() - 5000 });
    store.seed({ [key]: seeded });

    const git = responds();
    const spaces = panel("sidebar-spaces", store, { exec: git.exec });
    spaces.instance.adoptGit(new Set([key]));
    if (walk) spaces.instance.gitWalk.add(key);
    else spaces.instance.gitForced.add(key);
    spaces.instance.refreshGit([key], spaces.context);
    const at = spaces.instance.gitRequested.get(key) + 1;
    const peer = record({ at, refsAt: at, dirtyAt: walk ? at : seeded.dirtyAt, info: info({ branch: "peer" }) });
    store.seed({ [key]: peer });
    await spaces.context.tasks.at(-1).promise;
    assert.equal(git.calls.length, 0);
    assert.equal(spaces.instance.git[key].branch, "peer");
    assert.equal(store.writes.length, 0, "using a peer answer leaves the store alone");
  });
}

test("a forced refs request added to a busy Spaces pool reads past the old peer answer", async () => {
  const store = sharedStore();
  const slow = keyOf("vps", "/slow");
  const key = keyOf(null, "/repo");
  const git = responds({ "/repo": { ref: { code: 0, stdout: "refs/heads/after-commit\n", stderr: "" } } });
  const gate = makeDeferred();
  let started = false;
  const spaces = panel("sidebar-spaces", store, {
    exec: async (cmd, args, opts) => {
      if (opts.cwd === "/slow") {
        started = true;
        await gate.promise;
      }
      return git.exec(cmd, args, opts);
    },
  });
  spaces.instance.refreshGit([slow], spaces.context);
  const task = spaces.context.tasks.at(-1);
  await waitFor(() => started);
  const answered = now();
  spaces.vm.Date = class extends Date { static now() { return answered; } };
  store.seed({ [key]: record({ at: answered, refsAt: answered, dirtyAt: answered }) });
  spaces.instance.gitForced.add(key);
  spaces.instance.refreshGit([key], spaces.context);
  gate.resolve();
  await task.promise;
  assert.ok(git.calls.includes("symbolic-ref -q HEAD"));
  assert.equal(store.places()[key].info.branch, "after-commit");
  assert.equal(store.places()[key].dirtyAt, answered);
  assert.ok(store.places()[key].at > answered, "the other panel can adopt the refresh");
});

test("between walks only the refs are read, and the worktree's counts stay", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  const taken = now();
  const cached = info({ branch: "old", dirty: 3, conflicts: 1, upstream: "origin/old" });
  store.seed({ [key]: { at: taken, refsAt: taken - 40000, dirtyAt: taken - 5000, info: cached, unsure: false } });

  const git = responds({ "/repo": { counts: { code: 0, stdout: "2\t1\n", stderr: "" } } });
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  spaces.instance.adoptGit(new Set([key]));
  // A fallback look (nothing in this panel changed): refs only.
  await refreshSpaces(spaces, [key]);

  assert.deepEqual(git.calls.sort(), [
    "rev-list --left-right --count HEAD...@{upstream}",
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
    "symbolic-ref -q HEAD",
  ]);
  const answer = spaces.instance.git[key];
  assert.equal(answer.branch, "main");
  assert.equal(answer.upstream, "origin/main", "the refs look refreshes the upstream too");
  assert.equal(answer.ahead, 2);
  assert.equal(answer.behind, 1);
  assert.equal(answer.dirty, 3, "the worktree's counts are kept");
  assert.equal(answer.conflicts, 1);
  const kept = store.places()[key];
  assert.ok(kept.refsAt >= taken, "the refs are stamped as read");
  assert.equal(kept.dirtyAt, taken - 5000, "the walk's stamp is untouched");
});

test("a branch without an upstream, a detached HEAD and an unborn branch are answers", async () => {
  const key = keyOf(null, "/repo");
  const run = async (answers) => {
    const store = sharedStore();
    store.seed({ [key]: { at: 1, refsAt: 1, dirtyAt: 1, info: info(), unsure: false } });
    const git = responds({ "/repo": answers });
    const spaces = panel("sidebar-spaces", store, { exec: git.exec });
    spaces.instance.git[key] = info();
    spaces.instance.checked[key] = 1;
    await spaces.instance.check(key, spaces.context);
    return { answer: spaces.instance.git[key], unsure: spaces.instance.unsure.has(key) };
  };

  // No upstream: rev-parse fails with Git's own word, the tail keeps no counts.
  const unpinned = await run({
    ref: { code: 0, stdout: "refs/heads/work\n", stderr: "" },
    upstream: { code: 128, stdout: "", stderr: "fatal: no upstream configured for branch 'work'\n" },
  });
  assert.equal(unpinned.answer.branch, "work");
  assert.equal(unpinned.answer.upstream, null);
  assert.equal(unpinned.answer.ahead, 0);
  assert.equal(unpinned.unsure, false);

  // Detached: no ref at all, and nothing to report (the row drops its tail).
  const detached = await run({
    ref: { code: 1, stdout: "", stderr: "" },
    upstream: { code: 128, stdout: "", stderr: "fatal: HEAD does not point to a branch\n" },
  });
  assert.equal(detached.answer.branch, null);
  assert.equal(detached.answer.upstream, null);
  assert.equal(detached.unsure, false);

  // Unborn: HEAD names a branch no commit has reached yet.
  const unborn = await run({
    ref: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
    upstream: { code: 128, stdout: "", stderr: "fatal: no upstream configured for branch 'main'\n" },
  });
  assert.equal(unborn.answer.branch, "main");
  assert.equal(unborn.unsure, false);

  // A machine that cannot answer is not mistaken for a detached HEAD.
  const away = await run({
    ref: { code: 255, stdout: "", stderr: "ssh: connect to host vps port 22: refused\n" },
    upstream: { code: 255, stdout: "", stderr: "ssh: connect to host vps port 22: refused\n" },
  });
  assert.equal(away.answer.branch, "main", "the last answer stays");
  assert.equal(away.unsure, true);
});

test("a second worktree walk uses only status and keeps the repo identity", async () => {
  const store = sharedStore();
  const cwd = "/repo/worktree";
  const key = keyOf(null, cwd);
  const answers = { [cwd]: { common: { code: 0, stdout: "/repo/.git\n", stderr: "" } } };
  const git = responds(answers);
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  await refreshSpaces(spaces, [key]);
  assert.equal(git.calls.length, 3);
  const { name, repo, linked } = spaces.instance.git[key];
  assert.equal(linked, true);

  // The scheduled second walk is due after the first.
  const later = store.places()[key].at + 60001;
  spaces.vm.Date = class extends Date { static now() { return later; } };
  answers[cwd].status = { code: 0, stdout: "# branch.head feature\n? untracked\n", stderr: "" };
  git.calls.length = 0;
  spaces.instance.gitWalk.add(key);
  await refreshSpaces(spaces, [key]);
  assert.deepEqual(git.calls, ["--no-optional-locks -c core.fsmonitor=false status --porcelain=v2 --branch"]);
  assert.deepEqual({ ...store.places()[key].info }, info({ name, repo, linked, branch: "feature", upstream: null, dirty: 1 }));
});

test("a folder that left git clears its answer, and a transient status failure keeps it", async () => {
  const key = keyOf(null, "/gone");
  const store = sharedStore();
  store.seed({ [key]: { at: 1, refsAt: 1, dirtyAt: 1, info: info(), unsure: false } });
  const missing = { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n" };
  const git = responds({ "/gone": { status: missing } });
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  spaces.instance.git[key] = info();
  spaces.instance.checked[key] = 1;
  spaces.instance.gitWalk.add(key); // the walk, as a slow check would take
  await refreshSpaces(spaces, [key]);
  assert.deepEqual(git.calls, ["--no-optional-locks -c core.fsmonitor=false status --porcelain=v2 --branch"]);
  assert.equal(spaces.instance.git[key], null);
  assert.equal(spaces.instance.unsure.has(key), false);
  assert.equal(store.places()[key].info, null);

  // A worktree git will not describe: the answer stays, marked unsure.
  const other = keyOf(null, "/lost");
  const kept = info({ branch: "kept" });
  const lost = panel("sidebar-spaces", store, {
    exec: responds({ "/lost": { status: { code: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'\n" } } }).exec,
  });
  lost.instance.git[other] = kept;
  lost.instance.checked[other] = 1;
  lost.instance.gitWalk.add(other);
  await lost.instance.check(other, lost.context);
  assert.strictEqual(lost.instance.git[other], kept);
  assert.equal(lost.instance.unsure.has(other), true);
});

test("a repo path with a newline in it survives the walk", async () => {
  const store = sharedStore();
  const dir = "/work/od\nd";
  const key = keyOf(null, dir);
  const git = responds({ [dir]: { top: { code: 0, stdout: `${dir}\n`, stderr: "" }, common: { code: 0, stdout: `${dir}/.git\n`, stderr: "" } } });
  const spaces = panel("sidebar-spaces", store, { exec: git.exec });
  spaces.instance.gitWalk.add(key);
  await spaces.instance.check(key, spaces.context);
  const answer = spaces.instance.git[key];
  assert.equal(answer.repo, JSON.stringify([null, `${dir}/.git`]));
  assert.equal(answer.name, "od\nd");
  assert.equal(answer.linked, false);
});

test("two machines' same folder are two places", async () => {
  const store = sharedStore();
  const git = responds({
    "/repo": {
      status: { code: 0, stdout: "# branch.head local-branch\n", stderr: "" },
    },
    vps: true,
  });
  const exec = async (cmd, args, opts) => {
    if (args.includes("status")) {
      const branch = opts.on === "vps" ? "vps-branch" : "local-branch";
      return { code: 0, stdout: `# branch.head ${branch}\n`, stderr: "" };
    }
    return git.exec(cmd, args, opts);
  };
  const spaces = panel("sidebar-spaces", store, { exec });
  for (const on of [null, "vps"]) {
    const key = keyOf(on, "/repo");
    spaces.instance.gitWalk.add(key);
    await refreshSpaces(spaces, [key]);
  }
  const local = store.places()[keyOf(null, "/repo")].info;
  const remote = store.places()[keyOf("vps", "/repo")].info;
  assert.equal(local.branch, "local-branch");
  assert.equal(remote.branch, "vps-branch");
  assert.equal(local.repo, JSON.stringify([null, "/repo/.git"]));
  assert.equal(remote.repo, JSON.stringify(["vps", "/repo/.git"]));
});

test("the store drops places nobody looked at and stays bounded", async () => {
  const store = sharedStore();
  const old = now() - 600000;
  const seeded = {};
  for (let i = 0; i < 80; i++) {
    seeded[keyOf(null, `/place-${i}`)] = { at: old + i * 1000, refsAt: old, dirtyAt: old, info: info(), unsure: false };
  }
  seeded[keyOf(null, "/ancient")] = { at: now() - 3600000, refsAt: old, dirtyAt: old, info: info(), unsure: false };
  store.seed(seeded);

  const spaces = panel("sidebar-spaces", store, { exec: responds().exec });
  const key = keyOf(null, "/fresh");
  spaces.instance.gitWalk.add(key);
  await refreshSpaces(spaces, [key]);

  const places = store.places();
  assert.equal(key in places, true);
  assert.equal(keyOf(null, "/ancient") in places, false, "an entry past its quarter of an hour goes");
  assert.ok(Object.keys(places).length <= 64, `kept ${Object.keys(places).length} places`);
  assert.equal(keyOf(null, "/place-79") in places, true, "the newest places stay");
  assert.equal(keyOf(null, "/place-0") in places, false, "the oldest are dropped");
});

test("a damaged store is an empty one", async () => {
  const key = keyOf(null, "/repo");
  for (const damaged of ["text", 42, [], null, { places: "text" }, { places: [] }]) {
    const store = sharedStore();
    store.values.set(CACHE, damaged);
    const spaces = panel("sidebar-spaces", store, { exec: responds().exec });
    spaces.instance.gitWalk.add(key);
    await spaces.instance.check(key, spaces.context);
    assert.equal(spaces.instance.git[key].branch, "main", String(damaged));
  }
});

test("damaged records are not adopted, and adoption stays on the places shown", () => {
  const store = sharedStore();
  const good = keyOf(null, "/good");
  const bad = keyOf(null, "/bad");
  const expired = keyOf(null, "/expired");
  const elsewhere = keyOf(null, "/elsewhere");
  store.seed({
    [good]: record(),
    [bad]: { at: now(), info: "not a record" },
    [expired]: record({ at: now() - 3600000 }),
    [elsewhere]: record(),
  });

  const spaces = panel("sidebar-spaces", store);
  spaces.instance.adoptGit(new Set([good, bad, expired]));
  assert.deepEqual(Object.keys(spaces.instance.git), [good], "only a usable record of a live place");

  const agents = panel("sidebar-agents", store);
  agents.instance.adoptGit(new Set([good, bad, expired]));
  assert.deepEqual(Object.keys(agents.instance.git), [good]);
});

test("checking renders the store and suppresses cache writes even if a pool runs", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  store.seed({ [key]: record() });
  const git = responds();
  const spaces = renderPanel("sidebar-spaces", store, {
    spaces: () => [{ id: "s1", folder: "/repo", tabs: [] }],
    exec: git.exec,
  });
  spaces.render();
  assert.equal(spaces.instance.git[key].branch, "main", "what is known is drawn");
  assert.equal(git.calls.length, 0);
  await refreshSpaces(spaces, [keyOf(null, "/other")]);
  assert.equal(store.writes.length, 0);
});

test("spaces walks the worktree when its counts are old, even with the refs fresh", () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  store.seed({ [key]: { at: now() - 1000, refsAt: now() - 1000, dirtyAt: now() - 61000, info: info(), unsure: false } });
  const spaces = panel("sidebar-spaces", store, { window: () => ({ active: true, platform: "macos" }), machines: () => [] });
  spaces.instance.adoptGit(new Set([key]));
  const due = spaces.instance.due(now(), [{ id: "s1", folder: "/repo", tabs: [] }], [{ tab: "t1", cwd: "/repo" }]);
  assert.equal(due.has(key), true);
  assert.equal(spaces.instance.gitWalk.has(key), true, "the worktree, not only the refs");

  // Everything fresh: nothing is asked.
  store.seed({ [key]: { at: now(), refsAt: now(), dirtyAt: now(), info: info(), unsure: false } });
  spaces.instance.gitWalk.clear();
  const again = spaces.instance.due(now(), [{ id: "s1", folder: "/repo", tabs: [] }], [{ tab: "t1", cwd: "/repo" }]);
  assert.equal(again.has(key), false);
  assert.equal(spaces.instance.gitWalk.has(key), false);
});

test("an overdue worktree walk wins over overdue refs, and failures back off", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  store.seed({ [key]: record({ at: now() - 31000, refsAt: now() - 31000, dirtyAt: now() - 61000 }) });
  const spaces = panel("sidebar-spaces", store, { window: () => ({ active: true }), machines: () => [] });
  spaces.instance.adoptGit(new Set([key]));
  const sp = [{ id: "s1", folder: "/repo", tabs: [] }];
  assert.equal(spaces.instance.due(now(), sp, []).has(key), true);
  assert.equal(spaces.instance.gitWalk.has(key), true, "refs cannot starve worktree scans every thirty seconds");

  store.seed({ [key]: record({ refsAt: 0, dirtyAt: 0, unsure: true }) });
  spaces.instance.gitWalk.clear();
  assert.equal(spaces.instance.due(now(), sp, []).has(key), false, "offline scans wait before retrying");
  const agents = panel("sidebar-agents", store, { exec: () => assert.fail("retrying too soon") });
  agents.instance.places = () => [[key, { on: null, cwd: "/repo" }]];
  agents.instance.refreshGit(agents.context);
  await agents.context.flush();
  assert.equal(agents.instance.gitBusy, false);
});

test("a folder watch asks for the refs now, not when the fallback comes round", async () => {
  let first = true;
  const { Class, context } = loadMod("sidebar-spaces", {
    watchFolder: () => {
      if (!first) return new Promise(() => {});
      first = false;
      return Promise.resolve(["index"]);
    },
  });
  const inst = makeInstance(Class);
  const key = keyOf(null, "/repo");
  inst.git[key] = { ...info(), repo: JSON.stringify([null, "/repo/.git"]) };
  inst.checked[key] = Date.now(); // read a moment ago: the fallback would skip it
  inst.gitWalk.add(key); // a walk was queued for it
  const refreshed = [];
  inst.refreshGit = (keys) => refreshed.push([...keys]);
  inst.watch("/repo/.git", context);
  await waitFor(() => refreshed.length > 0);
  assert.deepEqual(refreshed[0], [key]);
  assert.equal(inst.gitForced.has(key), true, "the refs are read now");
  assert.equal(inst.gitWalk.has(key), false, "not the whole worktree");
});

test("spaces keeps a watch on a repo the other panel answered for", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  store.seed({ [key]: record() });
  const watched = [];
  const spaces = panel("sidebar-spaces", store, {
    spaces: () => [{ id: "s1", folder: "/repo", tabs: [] }],
    panes: () => [{ tab: "t1", cwd: "/repo" }],
    machines: () => [],
    window: () => ({ active: false, platform: "macos" }),
    watchFolder: (repo) => {
      watched.push(repo);
      return new Promise(() => {});
    },
  });
  spaces.instance.checkNew(spaces.context);
  assert.deepEqual(watched, ["/repo/.git"], "changes there reach this panel");
});

test("Spaces renders never start or cancel watches for Agents-only repos", async () => {
  const store = sharedStore();
  const home = keyOf(null, "/home");
  const other = keyOf(null, "/other");
  store.seed({ [home]: record({ info: null }), [other]: record({ info: info({ repo: keyOf(null, "/other/.git") }) }) });
  let started = 0;
  let cancelled = 0;
  const spaces = renderPanel("sidebar-spaces", store, {
    spaces: () => [{ id: "s1", folder: "/home", tabs: [] }],
    watchFolder: () => {
      started++;
      const gate = makeDeferred();
      gate.promise.cancel = () => { cancelled++; gate.resolve([]); };
      return gate.promise;
    },
  });
  for (let i = 0; i < 5; i++) {
    spaces.render();
    assert.equal(other in spaces.instance.git, false);
    spaces.instance.checkNew(spaces.context);
    await flushTurns(1);
  }
  assert.equal(started, 0);
  assert.equal(cancelled, 0);
});

for (const name of ["sidebar-spaces", "sidebar-agents"]) {
  test(`${name}: a remote branch change forces a refs look with fresh cache ages`, async () => {
    const store = sharedStore();
    const key = keyOf("vps", "/repo");
    const at = now() - 1000;
    store.seed({ [key]: record({ at, refsAt: at, dirtyAt: at, info: info({ repo: keyOf("vps", "/repo/.git") }) }) });
    const git = responds({ "/repo": { ref: { code: 0, stdout: "refs/heads/feature\n", stderr: "" } } });
    let branch = "main";
    const p = renderPanel(name, store, {
      spaces: () => [{ id: "vps/s1", machine: "vps", folder: "/repo", branch, tabs: [] }],
      agents: () => [{ address: "vps/t1", pane: "vps/p1", status: "idle" }],
      panes: () => [{ pane: "vps/p1", cwd: "/repo", branch }],
      exec: git.exec,
      watchFolder: () => assert.fail("remote repo watch"),
    });
    p.herdr.checking = () => false;
    const refresh = () => {
      p.render();
      if (name === "sidebar-spaces") p.instance.checkNew(p.context);
    };
    refresh();
    assert.equal(git.calls.length, 0);
    branch = "feature";
    refresh();
    await p.context.tasks.at(-1).promise;
    assert.ok(git.calls.includes("symbolic-ref -q HEAD"));
    assert.ok(git.calls.every(line => !line.includes("status")));
    assert.equal(p.instance.git[key].branch, "feature");
  });
}

test("Agents looks at pane-less rows and terminal parents using their live folders", async () => {
  const store = sharedStore();
  const other = keyOf(null, "/space-only");
  store.seed({ [other]: record() });
  const standalone = keyOf("vps", "/standalone");
  const parent = keyOf(null, "/parent");
  const child = keyOf(null, "/child");
  const git = responds();
  const agents = renderPanel("sidebar-agents", store, {
    terminals: () => [
      { address: "vps/solo", cwd: "/standalone", state: "live", status: "working" },
      { address: "parent", cwd: "/parent", state: "live" },
      { address: "child", parent: "parent", cwd: "/child", state: "live", status: "working" },
      { address: "unrelated", cwd: "/unrelated", state: "live" },
    ],
    exec: git.exec,
  });
  agents.herdr.checking = () => false;
  agents.render();
  assert.equal(other in agents.instance.git, false, "a Spaces-only record stays out of the list");
  assert.deepEqual(new Set(Array.from(agents.instance.places(), ([key]) => key)), new Set([standalone, parent]));
  await agents.context.tasks.at(-1).promise;
  assert.equal(store.places()[standalone].info.repo, keyOf("vps", "/standalone/.git"));
  assert.equal(store.places()[parent].info.repo, keyOf(null, "/parent/.git"));
  assert.equal(child in store.places(), false, "the sub-row has no Git tail");
});

test("Agents refreshes worktree counts sooner in the current space and the agent being viewed", async () => {
  const store = sharedStore();
  const cwd = ["/current", "/background", "/peek"];
  const keys = cwd.map(path => keyOf(null, path));
  const at = now() - 16000;
  store.seed(Object.fromEntries(keys.map(key => [key, record({ at, refsAt: at, dirtyAt: at })])));
  const git = responds(Object.fromEntries(cwd.map(path => [path, {
    status: { code: 0, stdout: "# branch.head main\n? new-file\n", stderr: "" },
  }])));
  const agents = renderPanel("sidebar-agents", store, {
    agents: () => [
      { pane: "p0", address: "t0", space: "current" },
      { pane: "p1", address: "t1", space: "background" },
      { pane: "p2", address: "t2", space: "peek" },
      { pane: "p0", address: "t3", space: "background" },
    ],
    panes: () => cwd.map((path, i) => ({ pane: `p${i}`, cwd: path })),
    focused: () => ({ space: "current", terminal: "editor", shown: "t2" }),
    exec: git.exec,
  });
  agents.herdr.checking = () => false;
  agents.render();
  await agents.context.flush();
  assert.equal(git.calls.filter(line => line.includes("status")).length, 2);
  assert.deepEqual(keys.map(key => agents.instance.git[key].dirty), [1, 0, 1]);
});

test("the agents panel walks the worktree less often than it reads refs", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  const git = responds({ "/repo": { counts: { code: 0, stdout: "1\t0\n", stderr: "" } } });
  const agents = panel("sidebar-agents", store, { exec: git.exec });
  agents.instance.places = () => [[key, { on: null, cwd: "/repo" }]];

  // A first look walks the tree.
  agents.instance.refreshGit(agents.context);
  await agents.context.flush();
  assert.equal(agents.instance.git[key].branch, "main");
  assert.equal(git.calls.some((c) => c.includes("status")), true);

  // Half a minute later the refs are due again, the walk is not.
  git.calls.length = 0;
  const kept = store.places()[key];
  const later = kept.refsAt + 31000;
  agents.vm.Date = class extends Date { static now() { return later; } };
  agents.instance.refreshGit(agents.context);
  await agents.context.flush();
  assert.deepEqual(git.calls.sort(), [
    "rev-list --left-right --count HEAD...@{upstream}",
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
    "symbolic-ref -q HEAD",
  ]);
  assert.equal(agents.instance.git[key].ahead, 1);
  assert.equal(agents.instance.git[key].dirty, 0, "the walk's counts are kept");
});

test("a failed run does not release the place while its peer still runs", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  store.seed({ [key]: { at: 1, refsAt: now() - 40000, dirtyAt: now() - 60000, info: info(), unsure: false } });
  const gate = makeDeferred();
  let peerStarted = false;
  const spaces = panel("sidebar-spaces", store, {
    exec: async (_cmd, args) => {
      if (args.includes("symbolic-ref")) throw new Error("machine is away");
      peerStarted = true;
      await gate.promise;
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    },
  });
  spaces.instance.git[key] = info();
  spaces.instance.checked[key] = 1;
  let settled = false;
  const look = spaces.instance.check(key, spaces.context).then(() => (settled = true));
  await waitFor(() => peerStarted);
  await flushTurns(3);
  assert.equal(settled, false, "the look waits for the run still going");
  gate.resolve();
  await look;
  assert.equal(spaces.instance.unsure.has(key), true, "the failed look keeps what was shown");
});

test("the agents panel looks at two places at a time and a slow one holds nothing up", async () => {
  const store = sharedStore();
  const slow = keyOf(null, "/slow");
  const places = [slow, keyOf(null, "/a"), keyOf(null, "/b"), keyOf(null, "/c"), keyOf(null, "/d")];
  let active = 0;
  let peak = 0;
  const finished = [];
  const gate = makeDeferred();

  const agents = panel("sidebar-agents", store, {
    exec: async (_cmd, args, opts) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (opts.cwd === "/slow") await gate.promise;
        if (args.includes("status")) return { code: 0, stdout: "# branch.head main\n", stderr: "" };
        return { code: 0, stdout: `${opts.cwd}\n`, stderr: "" };
      } finally {
        active--;
        finished.push(opts.cwd);
      }
    },
  });
  agents.instance.places = () => places.map((key) => [key, { on: null, cwd: JSON.parse(key)[1] }]);

  agents.instance.refreshGit(agents.context);
  await waitFor(() => finished.length >= 4);
  assert.equal(peak <= 4, true, "two places, two execs each");
  assert.ok(!finished.includes("/slow"), "the slow place is still running");
  gate.resolve();
  await agents.context.flush();
  assert.equal(new Set(finished).size, places.length);
  assert.equal(agents.instance.gitBusy, false);
});

for (const name of ["sidebar-spaces", "sidebar-agents"]) {
  test(`${name}: one cache write per pool merges the latest shared places`, async () => {
    const store = sharedStore();
    const slow = keyOf(null, "/slow");
    const fast = keyOf(null, "/fast");
    const other = keyOf(null, "/other");
    const git = responds();
    const gate = makeDeferred();
    const p = panel(name, store, {
      exec: async (cmd, args, opts) => {
        if (opts.cwd === "/slow") await gate.promise;
        return git.exec(cmd, args, opts);
      },
    });
    if (name === "sidebar-spaces") p.instance.refreshGit([slow, fast], p.context);
    else {
      p.instance.places = () => [[slow, { cwd: "/slow" }], [fast, { cwd: "/fast" }]];
      p.instance.refreshGit(p.context);
    }
    const task = p.context.tasks.at(-1);
    await waitFor(() => Boolean(p.instance.git[fast]));
    assert.equal(store.writes.length, 0, "the pool is still running");
    const fresh = p.instance.gitRecords[fast].at + 1;
    store.seed({ [fast]: record({ at: fresh, info: info({ branch: "peer" }) }), [other]: record() });
    gate.resolve();
    await task.promise;
    assert.equal(store.writes.length, 1);
    assert.deepEqual(Object.keys(store.places()).sort(), [slow, fast, other].sort());
    assert.equal(store.places()[fast].info.branch, "peer", "keep the newer answer");
  });
}

test("shared-cache eviction preserves local scan ages instead of causing repeated scans", async () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  for (const name of ["sidebar-spaces", "sidebar-agents"]) {
    store.seed({ [key]: record() });
    const p = panel(name, store, { exec: () => assert.fail("a fresh evicted place was scanned again"), window: () => ({ active: true }) });
    p.instance.adoptGit(new Set([key]));
    store.seed({}); // the bounded shared cache may evict an otherwise visible place
    if (name === "sidebar-agents") {
      p.instance.places = () => [[key, { on: null, cwd: "/repo" }]];
      p.instance.refreshGit(p.context);
      await p.context.flush();
      assert.equal(p.instance.gitBusy, false);
    } else {
      const sp = [{ id: "s1", folder: "/repo", tabs: [] }];
      assert.equal(p.instance.due(now(), sp, []).has(key), false);
      p.instance.gitRecords[key].dirtyAt = now() - 61000;
      assert.equal(p.instance.due(now(), sp, []).has(key), true);
      assert.equal(p.instance.gitWalk.has(key), true, "the evicted record still remembers the worktree scan age");
    }
  }
});

test("damaged nested Git info cannot reach rendering or folder watches", () => {
  const store = sharedStore();
  const key = keyOf(null, "/repo");
  const spaces = panel("sidebar-spaces", store);
  for (const bad of [{}, info({ repo: "broken" }), info({ branch: 42 }), info({ dirty: "3" }), info({ repo: '[null,42]' })]) {
    store.seed({ [key]: record({ info: bad }) });
    spaces.instance.adoptGit(new Set([key]));
    assert.equal(key in spaces.instance.git, false);
  }
});
