import test from "node:test";
import assert from "node:assert/strict";

import { loadMod, makeInstance, makeDeferred, waitFor, flushTurns } from "./load-mod.mjs";

const keyOf = (path) => JSON.stringify([null, path]);

function keys(n) {
  return Array.from({ length: n }, (_, i) => keyOf(`/place-${i}`));
}

test("refreshGit keeps at most six checks running at once", async () => {
  const { Class, context } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  const gates = new Map();
  const started = [];
  let active = 0;
  let peak = 0;
  inst.check = async (key) => {
    started.push(key);
    active++;
    peak = Math.max(peak, active);
    const gate = makeDeferred();
    gates.set(key, gate);
    try {
      await gate.promise;
    } finally {
      active--;
    }
  };

  const all = keys(12);
  inst.refreshGit(all, context);

  await waitFor(() => started.length === 6);
  await flushTurns(3);
  assert.equal(started.length, 6, "the seventh place waits for a free slot");
  assert.equal(peak, 6);

  // Release the first wave; the next six take its place.
  for (const key of started) gates.get(key).resolve();
  await waitFor(() => started.length === 12);
  assert.equal(peak, 6, "peak concurrency never passes AT_ONCE");

  for (const key of started) gates.get(key).resolve();
  await waitFor(() => inst.refreshing === false && inst.pending.size === 0 && inst.gitInFlight.size === 0);
  assert.deepEqual(new Set(started), new Set(all));
});

test("a slow check does not hold up the other places", async () => {
  const { Class, context } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  const slow = keyOf("/slow");
  const slowGate = makeDeferred();
  const finished = [];
  inst.check = async (key) => {
    if (key === slow) await slowGate.promise;
    finished.push(key);
  };

  inst.refreshGit([slow, ...keys(7)], context);

  // All seven fast places finish while the slow one still occupies a slot.
  await waitFor(() => finished.length === 7);
  assert.equal(finished.includes(slow), false);
  assert.equal(inst.refreshing, true);

  slowGate.resolve();
  await waitFor(() => finished.length === 8);
  await waitFor(() => inst.refreshing === false);
  assert.equal(finished[7], slow);
});

test("a place already in flight is not queued twice, and refreshing resets", async () => {
  const { Class, context } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  const key = keyOf("/same");
  const gate = makeDeferred();
  let calls = 0;
  inst.check = async () => {
    calls++;
    if (calls === 1) await gate.promise;
  };

  inst.refreshGit([key], context);
  await waitFor(() => calls === 1);
  assert.equal(inst.refreshing, true);
  assert.equal(inst.gitInFlight.has(key), true);

  const firstDriver = context.tasks.at(-1).promise;
  inst.refreshGit([key], context);
  await flushTurns(3);
  assert.equal(context.tasks.length, 1, "a second driver is not started while refreshing");
  assert.equal(calls, 1, "the same key is not checked twice");
  assert.equal(inst.pending.has(key), false);

  gate.resolve();
  await firstDriver;
  assert.equal(inst.refreshing, false);
  assert.equal(inst.gitInFlight.has(key), false);

  // The next request is no longer deduped.
  inst.refreshGit([key], context);
  await waitFor(() => calls === 2);
  await waitFor(() => inst.refreshing === false);
  assert.equal(context.tasks.length, 2);
});

test("refreshing resets after a check throws", async () => {
  const { Class, context } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);
  const key = keyOf("/throws");

  inst.check = async () => {
    throw new Error("boom");
  };
  inst.refreshGit([key], context);

  await assert.rejects(context.tasks.at(-1).promise, /boom/);
  await waitFor(() => inst.refreshing === false && inst.gitInFlight.size === 0);
  assert.equal(inst.gitInFlight.has(key), false);
});

test("a failed worker does not release the pool while another is still running", async () => {
  const { Class, context } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);
  const gate = makeDeferred();
  inst.check = async key => {
    if (key === "bad") throw new Error("boom");
    await gate.promise;
  };
  inst.refreshGit(["bad", "slow"], context);
  await waitFor(() => inst.gitInFlight.has("slow"));
  await flushTurns(3);
  assert.equal(inst.refreshing, true);
  gate.resolve();
  await assert.rejects(context.tasks.at(-1).promise, /boom/);
  assert.equal(inst.refreshing, false);
  assert.equal(inst.gitInFlight.size, 0);
});

test("a temporary git failure keeps the cached info and marks the place unsure", async () => {
  const { Class, context, herdr } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  const old = { name: "cached", branch: "main", repo: keyOf("/cached/.git") };
  const failed = keyOf("/cached");
  inst.git[failed] = old;
  inst.checked[failed] = 1;

  herdr.exec = async () => ({
    code: 128,
    stdout: "",
    stderr: "fatal: unable to access remote: Could not resolve host",
  });

  await inst.check(failed, context);
  assert.strictEqual(inst.git[failed], old, "the last good answer stays on screen");
  assert.equal(inst.unsure.has(failed), true);
  assert.ok(inst.checked[failed] > 1);

  // A machine away throws instead of answering, and is kept the same way.
  const thrown = keyOf("/away");
  const cached = { name: "away", branch: "work", repo: keyOf("/away/.git") };
  inst.git[thrown] = cached;
  herdr.exec = async () => {
    throw new Error("machine is away");
  };

  await inst.check(thrown, context);
  assert.strictEqual(inst.git[thrown], cached);
  assert.equal(inst.unsure.has(thrown), true);
});

test("git's own not-a-repository answer clears the place", async () => {
  const { Class, context, herdr } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  const key = keyOf("/plain-folder");
  const old = { name: "plain-folder", branch: "main", repo: keyOf("/plain-folder/.git") };
  inst.git[key] = old;
  inst.unsure.add(key);

  herdr.exec = async () => ({
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
  });

  await inst.check(key, context);
  assert.equal(inst.git[key], null);
  assert.equal(inst.unsure.has(key), false);
  assert.ok(inst.checked[key] > 0);
});

test("a failed rev-parse never invents repo info, while dirty and conflicts parse", async () => {
  const { Class, context, herdr } = loadMod("sidebar-spaces");
  const inst = makeInstance(Class);

  // Successful status, but rev-parse cannot name the repo: no info is built.
  herdr.exec = async (_cmd, args) => {
    if (args.includes("status")) {
      return {
        code: 0,
        stdout: "# branch.head main\n1 .M N... 100644 100644 100644 abc def a.txt\n",
        stderr: "",
      };
    }
    return { code: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'" };
  };

  const broken = keyOf("/broken");
  await inst.check(broken, context);
  assert.equal(inst.git[broken], null);
  assert.equal(inst.unsure.has(broken), true);

  // An existing answer is not replaced either.
  const cached = { name: "still-here", branch: "main", dirty: 1 };
  const kept = keyOf("/kept");
  inst.git[kept] = cached;
  await inst.check(kept, context);
  assert.strictEqual(inst.git[kept], cached);
  assert.equal(inst.unsure.has(kept), true);

  // A full answer parses branch, ahead/behind, dirty and conflicts. Two
  // rev-parse runs name the tree and its common .git (a folder name may hold a
  // newline); one status walks the tree.
  let watched = [];
  const calls = [];
  const full = loadMod("sidebar-spaces", {
    watchFolder: (repo) => {
      watched.push(repo);
      return new Promise(() => {});
    },
  });
  const fullInst = makeInstance(full.Class);
  full.herdr.exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes("status")) {
      return {
        code: 0,
        stdout: [
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +1 -2",
          "1 .M N... 100644 100644 100644 abc def changed.txt",
          "2 R. N... 100644 100644 100644 abc def renamed.txt",
          "u UU N... 100644 100644 100644 abc def conflicted.txt",
          "? untracked.txt",
        ].join("\n"),
        stderr: "",
      };
    }
    // Each rev-parse answers one path, so a path with a newline survives.
    if (args.includes("--show-toplevel")) return { code: 0, stdout: "/work/tree\n", stderr: "" };
    return { code: 0, stdout: "/work/tree/.git\n", stderr: "" };
  };

  const work = keyOf("/work/tree");
  await fullInst.check(work, full.context);
  assert.equal(calls.length, 3, "two rev-parse runs, then the walk");
  const info = fullInst.git[work];
  assert.ok(info, "a successful answer is remembered");
  assert.equal(info.name, "tree");
  assert.equal(info.branch, "main");
  assert.equal(info.upstream, "origin/main");
  assert.equal(info.ahead, 1);
  assert.equal(info.behind, 2);
  assert.equal(info.dirty, 4);
  assert.equal(info.conflicts, 1);
  assert.equal(info.repo, keyOf("/work/tree/.git"));
  assert.equal(info.linked, false);
  assert.equal(fullInst.unsure.has(work), false);
  assert.deepEqual(watched, ["/work/tree/.git"]);
  assert.equal(fullInst.watching.has("/work/tree/.git"), true);
});

test("due drops places no longer shown, and cancels their watches for good", async () => {
  const deferreds = new Map();
  const watchCalls = [];
  const { Class, context } = loadMod("sidebar-spaces", {
    machines: () => [],
    window: () => ({ active: false }),
    watchFolder: (repo) => {
      const deferred = makeDeferred();
      const pending = deferred.promise;
      pending.cancel = () => deferred.resolve([]);
      watchCalls.push(repo);
      deferreds.set(repo, deferred);
      return pending;
    },
  });
  const inst = makeInstance(Class);

  const shownRepo = "/shown/.git";
  const goneRepo = "/gone/.git";
  const shownKey = keyOf("/shown");
  const goneKey = keyOf("/gone");
  inst.git = {
    [shownKey]: { name: "shown", repo: JSON.stringify([null, shownRepo]) },
    [goneKey]: { name: "gone", repo: JSON.stringify([null, goneRepo]) },
  };
  inst.checked = { [shownKey]: 111, [goneKey]: 222 };
  inst.unsure.add(goneKey);
  inst.pending.add(goneKey);
  inst.at = { stale: goneKey };

  inst.watch(shownRepo, context);
  inst.watch(goneRepo, context);
  assert.equal(inst.watching.size, 2);

  let shownCancelled = 0;
  let goneCancelled = 0;
  const shownPending = inst.watching.get(shownRepo);
  shownPending.cancel = () => shownCancelled++;
  const gonePending = inst.watching.get(goneRepo);
  const stopGone = gonePending.cancel;
  gonePending.cancel = () => {
    goneCancelled++;
    stopGone();
  };

  const due = inst.due(
    Date.now(),
    [{ id: "s1", folder: "/shown", tabs: [{ id: "t1" }] }],
    [{ tab: "t1", cwd: "/shown" }],
  );

  assert.equal(due.size, 0);
  assert.equal(shownKey in inst.git, true);
  assert.equal(goneKey in inst.git, false, "a place not shown is forgotten");
  assert.equal(inst.checked[shownKey], 111);
  assert.equal(goneKey in inst.checked, false, "its last-look stamp goes too");
  assert.equal(inst.unsure.has(goneKey), false);
  assert.equal(inst.pending.has(goneKey), false);
  assert.equal(inst.watching.has(shownRepo), true, "the shown repo keeps its watch");
  assert.equal(inst.watching.has(goneRepo), false);
  assert.equal(shownCancelled, 0);
  assert.equal(goneCancelled, 1);

  // The canceled watch must not restart and re-register itself.
  await flushTurns(5);
  assert.equal(watchCalls.filter((repo) => repo === goneRepo).length, 1);
  assert.equal(inst.watching.has(goneRepo), false);
  assert.equal(inst.watching.has(shownRepo), true);
  assert.equal(deferreds.get(shownRepo).promise instanceof Promise, true);
});
