import test from "node:test";
import assert from "node:assert/strict";
import { loadMod, uiState } from "./load-mod.mjs";

function init(name, overrides = {}, storage = {}) {
  const loaded = loadMod(name, overrides, storage);
  loaded.instance = new loaded.Class();
  loaded.instance.init({}, loaded.context);
  return loaded;
}

function* nodes(root) {
  const state = uiState(root);
  if (!state) return;
  yield root;
  for (const child of state.children) yield* nodes(child);
}
const byId = (root, id) => [...nodes(root)].find(node => uiState(node).id === id);
const textOf = root => uiState(root)?.children.map(c => typeof c === "string" ? c : textOf(c)).join("") ?? "";

for (const name of ["sidebar-spaces", "sidebar-agents"]) {
  test(`${name}: checking initializes and renders without commands, writes or timers`, async () => {
    const unexpected = () => { throw new Error("side effect during check"); };
    const loaded = loadMod(name, {
      checking: () => true, exec: unexpected, hc: unexpected, run: unexpected,
      watchFolder: unexpected, setBadge: unexpected, setShared: unexpected, setAgentOrder: unexpected,
    });
    loaded.storage.setItem = unexpected;
    loaded.storage.removeItem = unexpected;
    loaded.fs.readFile = unexpected;
    loaded.fs.unlink = unexpected;
    const inst = new loaded.Class();
    inst.init({}, loaded.context);
    inst.render(loaded.context);
    inst.close?.(loaded.context);
    await loaded.context.flush();
    assert.equal(loaded.context.tasks.length, 0);
    assert.equal(loaded.context.timers.length, 0);
  });

  test(`${name}: malformed persisted values cannot hide the panel`, () => {
    for (const bad of ["{", "null", "42", '"text"', "[]", "{}", '[null,42,{},"vps"]']) {
      const storage = Object.fromEntries(["changed", "pins", "machines.folded", "machines.order", "machines.reconnecting"].map(key => [key, bad]));
      const { instance, context } = init(name, {}, storage);
      assert.doesNotThrow(() => instance.render(context), `${name}: ${bad}`);
    }
  });
}

test("checks render live data without writing state or reordering worktrees", () => {
  const unexpected = () => { throw new Error("side effect during check"); };
  for (const name of ["sidebar-spaces", "sidebar-agents"]) {
    const loaded = init(name, {
      spaces: () => [
        { id: "main", name: "Main", folder: "/repo", tabs: [{ id: "tab" }] },
        { id: "other", name: "Other", folder: "/other", tabs: [] },
        { id: "tree", name: "Tree", folder: "/tree", tabs: [], active: true },
      ],
      agents: () => [{ address: "t1", tab: "tab", space: "main", pane: "p1", status: "done", seq: 1 }],
      run: unexpected, setShared: unexpected, setAgentOrder: unexpected, setBadge: unexpected,
    });
    loaded.storage.setItem = unexpected;
    loaded.storage.removeItem = unexpected;
    if (name === "sidebar-spaces") {
      const repo = JSON.stringify([null, "/repo/.git"]);
      loaded.instance.git[JSON.stringify([null, "/repo"])] = { repo, linked: false };
      loaded.instance.git[JSON.stringify([null, "/tree"])] = { repo, linked: true };
    }
    assert.doesNotThrow(() => loaded.instance.render(loaded.context));
  }
});

test("Spaces restores valid machine order and drops damaged reconnect records", () => {
  const { instance, context } = init("sidebar-spaces", {}, {
    "machines.order": '["vps",null,"vps",42,{}]',
    "machines.folded": '[null,"vps",42]',
    "machines.reconnecting": JSON.stringify({
      broken: { machine: {} }, primitive: 5, empty: null,
      vps: { machine: { name: "vps", target: "user@vps", state: 42 }, error: {}, busy: true },
    }),
  });
  assert.deepEqual([...instance.order], ["vps", null]);
  assert.deepEqual([...instance.folded], [null, "vps"]);
  assert.deepEqual(Object.keys(instance.reconnecting), ["vps"]);
  assert.equal(instance.reconnecting.vps.busy, false);
  assert.equal(instance.reconnecting.vps.error, null);
  assert.doesNotThrow(() => instance.render(context));
});

test("Agents keeps valid persisted state and removes invalid entries", () => {
  const { instance } = init("sidebar-agents", {}, {
    changed: JSON.stringify({ good: { s: "working", at: 123 }, bad: null, primitive: 42 }),
    pins: '["vps/t1",null,42]',
  });
  assert.equal(instance.changed.good.at, 123);
  assert.deepEqual(Object.keys(instance.changed), ["good"]);
  assert.deepEqual([...instance.pendingPins], ["vps/t1"]);
});

test("Agents preserves brackets, removes status marks, and rejects path/id titles", () => {
  const { vm } = loadMod("sidebar-agents");
  const tab = { name: "Claude", named: false };
  const pane = { program: { name: "Claude", key: "claude" }, terminal: "t1" };
  const title = s => vm.title(tab, { ...pane, title: s });
  assert.equal(title("[web] login"), "[web] login");
  assert.equal(title("[ ! ] Needs input"), "Needs input");
  assert.equal(title("[ . ] Thinking"), "Thinking");
  assert.equal(title("⠋ - Thinking"), "Thinking");
  for (const path of ["~/project", "/home/project", "C:\\project", "✦ ~/project", "t1"]) {
    assert.equal(title(path), "Claude", path);
  }
  assert.equal(vm.title({ name: "My task", named: true }, { ...pane, title: "[web] login" }), "My task");
});

test("Dock badge counts blocked and done, updates only on change, and clears", () => {
  const calls = [];
  const { instance, herdr } = init("sidebar-agents", { setBadge: text => calls.push(text) });
  herdr.checking = () => false;
  const list = [
    { address: "t1", status: "blocked" }, { address: "t2", status: "done" },
    { address: "t3", status: "working" }, { address: "t4", status: "idle" },
  ];
  instance.updateBadge(list);
  instance.updateBadge(list);
  instance.updateBadge(list.slice(1));
  instance.updateBadge([]);
  assert.deepEqual(calls, ["2", "1", null]);
  instance.badgeOwner = true;
  instance.close();
  assert.equal(calls.at(-1), null);
});

test("sort overlay never owns or clears the Dock badge", () => {
  const calls = [];
  const { instance, context } = init("sidebar-agents", {
    checking: () => false, props: () => ({ sortMenu: true }), setBadge: text => calls.push(text),
  });
  instance.render(context);
  instance.close();
  assert.deepEqual(calls, []);
});

const spaces = [
  { id: "local", name: "Local project", folder: "/local", tabs: [], active: false },
  { id: "remote", name: "Remote project", folder: "/remote", machine: "vps", tabs: [], active: true },
];

function spacePanel() {
  const loaded = init("sidebar-spaces", { spaces: () => spaces.map(s => ({ ...s })) });
  loaded.instance.machines = [{ name: "vps", state: "connected" }];
  return loaded;
}

test("Spaces scroll follows displayed machine order and reacts to resize", () => {
  const { instance, context } = spacePanel();
  let root = instance.render(context);
  assert.equal(instance.activeAt, 3); // local header, row, remote header, active row
  assert.deepEqual(instance.scroll.items, [3]);
  instance.render(context);
  assert.deepEqual(instance.scroll.items, [3], "unchanged selection does not reset manual scrolling");
  instance.order = ["vps", null];
  root = instance.render(context);
  assert.equal(instance.activeAt, 1);
  assert.deepEqual(instance.scroll.items, [3, 1]);
  const area = [...nodes(root)].find(n => uiState(n).handlers.on_size_change);
  uiState(area).handlers.on_size_change({ width: 300, height: 200 }, context);
  assert.deepEqual(instance.scroll.items, [3, 1, 1]);
  instance.folded.add("vps");
  instance.render(context);
  assert.equal(instance.activeAt, -1);
  assert.deepEqual(instance.scroll.items, [3, 1, 1], "a hidden row has no scroll target");
});

test("machine guidance rows count toward scrolling; Copy preserves focus", () => {
  const { instance, context } = spacePanel();
  instance.machines = [{ name: "vps", state: "needs_login", keeps_running_after_logout: false }];
  const root = instance.render(context);
  assert.equal(instance.activeAt, 4);
  const copy = byId(root, "machine-login-copy-vps");
  assert.ok(copy);
  const copied = [];
  let stopped = false;
  uiState(copy).handlers.on_click({}, {
    ...context, stop_propagation() { stopped = true; }, write_to_clipboard(s) { copied.push(s); },
  });
  assert.equal(stopped, true);
  assert.deepEqual(copied, ["hc machine login vps"]);
  assert.ok(textOf(instance.render(context)).includes("Copied"));
});

test("machine logout warning opens the official fix dialog", () => {
  const overlays = [];
  const { instance, context, herdr } = spacePanel();
  herdr.openOverlay = options => overlays.push(options);
  instance.machines = [{ name: "vps", state: "connected", keeps_running_after_logout: false }];
  let root = instance.render(context);
  const warn = byId(root, "machine-logout-vps");
  assert.ok(warn);
  uiState(warn).handlers.on_click({}, { ...context, stop_propagation() {} });
  assert.equal(overlays[0].mod, "machine-add");
  herdr.layout = () => ({ id: "sidebar", size: { px: 76 } });
  root = instance.render(context);
  assert.ok(byId(root, "machine-logout-vps"), "warning is available in the rail too");
});

test("a rail machine needing login opens Settings instead of folding", () => {
  const calls = [];
  const { instance, context, herdr } = spacePanel();
  herdr.layout = () => ({ id: "sidebar", size: { px: 76 } });
  herdr.run = (...args) => calls.push(args);
  instance.machines = [{ name: "vps", state: "needs_login" }];
  const root = instance.render(context);
  const head = byId(root, "machine-vps");
  uiState(head).handlers.on_mouse_down({}, context);
  uiState(head).handlers.on_mouse_up({}, context);
  assert.equal(calls[0][0], "app.settings");
  assert.equal(calls[0][1].section, "machines");
  assert.equal(instance.folded.has("vps"), false);
});

test("a temporary Agents git error keeps the previous tail", async () => {
  const { instance, context, herdr } = init("sidebar-agents");
  const key = JSON.stringify([null, "/repo"]);
  const cached = { branch: "feature", dirty: 3 };
  instance.git[key] = cached;
  instance.places = () => [[key, { on: null, cwd: "/repo" }]];
  herdr.exec = async () => ({ code: 1, stdout: "", stderr: "temporarily unavailable" });
  instance.refreshGit(context);
  await context.tasks.at(-1).promise;
  assert.strictEqual(instance.git[key], cached);
  instance.gitAt[key] = 0;
  delete instance.gitRecords[key]; // force the next attempt past its failure backoff
  herdr.exec = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  instance.refreshGit(context);
  await context.tasks.at(-1).promise;
  assert.equal(instance.git[key], null);
});
