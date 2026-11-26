import test from "node:test";
import assert from "node:assert/strict";
import { loadMod, uiState, makeDeferred, flushTurns } from "./load-mod.mjs";

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

test("Spaces and Agents align expanded rows and keep status at the end", () => {
  const space = { id: "local", name: "Project", status: "done", tabs: [] };
  const loadedSpaces = init("sidebar-spaces", { spaces: () => [space] });
  const loadedAgents = init("sidebar-agents", {
    agents: () => [{ address: "t1", status: "done", seq: 1, title: "Agent" }],
  });
  const t = loadedSpaces.herdr.theme();
  const value = (node, method) => uiState(node).calls.find(([name]) => name === method)?.[1];
  const assertTrailingStatus = row => {
    const status = uiState(row).children.at(-1);
    assert.ok([...nodes(status)].some(n => value(n, "bg") === t.done));
  };
  const agents = loadedAgents.instance.render(loadedAgents.context);
  const agentRow = byId(agents, "ag-t1");
  assertTrailingStatus(agentRow);
  for (const tree of [false, true]) {
    const spaceBox = loadedSpaces.instance.spaceBox({ w: space, i: 0, tree }, t);
    const outer = byId(spaceBox, "space-local");
    const row = uiState(outer).children.at(-1);
    assert.equal(value(spaceBox, "ml") + value(outer, "px"), value(byId(agents, "ag-list"), "pl") + value(agentRow, "px"));
    assert.equal(value(uiState(row).children[0], "w"), value(uiState(agentRow).children[0], "w"));
    assert.equal(value(row, "gap"), value(agentRow, "gap"));
    assert.equal(value(row, "pl"), undefined);
    assertTrailingStatus(row);
  }
  const terminal = { address: "t2", status: "done" };
  const [taskRow] = loadedSpaces.instance.terminalRows("space-local", [terminal], t);
  const subRow = loadedAgents.instance.subRow(t, { t: terminal, lines: ["└"] });
  assert.equal(value(taskRow, "pl"), value(subRow, "pl"));
  assertTrailingStatus(taskRow);
  assertTrailingStatus(subRow);
});

test("Sidebar settings applies the selected status position to both panels", () => {
  const values = new Map();
  const shared = key => values.get(key);
  const closed = [];
  let overlay;
  const space = { id: "local", name: "Project", status: "done", tabs: [] };
  const spaces = init("sidebar-spaces", { shared, spaces: () => [space], openOverlay: spec => { overlay = spec; } });
  const agents = init("sidebar-agents", {
    shared,
    agents: () => [{ address: "t1", status: "done", seq: 1, title: "Agent" }],
  });
  const root = spaces.instance.render(spaces.context);
  uiState(byId(root, "sidebar-settings")).handlers.on_click();
  assert.equal(overlay.mod, "sidebar-spaces");
  assert.equal(overlay.kind, "dialog");
  const settings = init(overlay.mod, {
    checking: () => false,
    props: () => ({ ...overlay.props, overlay: "settings-overlay" }),
    shared,
    setShared: (key, value) => values.set(key, value),
    closeOverlay: id => closed.push(id),
  });
  assert.equal(settings.context.tasks.length, 0);
  assert.equal(settings.context.timers.length, 0);
  const initial = [...nodes(settings.instance.render(settings.context))]
    .filter(node => uiState(node).id?.startsWith("setting-sidebar.statusPosition-"));
  assert.deepEqual(initial.map(textOf), ["Left", "Right"]);
  assert.ok(uiState(initial[1]).calls.some(([method]) => method === "font_semibold"));

  const t = spaces.herdr.theme();
  const terminal = { address: "t2", status: "done" };
  for (const [choice, index] of [["start", 0], ["end", -1]]) {
    const menu = settings.instance.render(settings.context);
    const id = `setting-sidebar.statusPosition-${choice}`;
    uiState(byId(menu, id)).handlers.on_click();
    const selected = byId(settings.instance.render(settings.context), id);
    assert.ok(uiState(selected).calls.some(([method]) => method === "font_semibold"));
    const spaceRow = byId(spaces.instance.render(spaces.context), "space-local");
    const agentRow = byId(agents.instance.render(agents.context), "ag-t1");
    const [taskRow] = spaces.instance.terminalRows("space-local", [terminal], t);
    const subRow = agents.instance.subRow(t, { t: terminal, lines: ["└"] });
    for (const row of [uiState(spaceRow).children.at(-1), agentRow, taskRow, subRow]) {
      const cell = uiState(row).children.at(index);
      assert.ok([...nodes(cell)].some(n => uiState(n).calls.some(([method, color]) => method === "bg" && color === t.done)));
    }
  }
  assert.deepEqual(closed, [], "changes can be made without reopening the dialog");
  const dialog = settings.instance.render(settings.context);
  for (const key of ["git.showBranch", "git.showChanges", "git.showSync", "agents.showParentTerminalIds", "showChildTerminalIds", "spaces.showUsage", "spaces.showPorts", "spaces.expandTerminals", "spaces.showCup", "agents.expandChildren"]) {
    const toggle = uiState(byId(dialog, `setting-sidebar.${key}`)).handlers.on_click;
    toggle();
    assert.equal(shared(`sidebar.${key}`), false);
    toggle();
    assert.equal(shared(`sidebar.${key}`), true);
  }
  uiState(byId(dialog, "setting-agents.sort-grouped")).handlers.on_click();
  assert.equal(shared("agents.sort"), "grouped");
  uiState(byId(dialog, "setting-sidebar.agents.unreadClear-manual")).handlers.on_click();
  assert.equal(shared("sidebar.agents.unreadClear"), "manual");
  uiState(byId(dialog, "setting-sidebar.agents.unreadColor-yellow")).handlers.on_click();
  assert.equal(shared("sidebar.agents.unreadColor"), "yellow");
  uiState(byId(dialog, "settings-done")).handlers.on_click();
  assert.deepEqual(closed, ["settings-overlay"]);
});

test("Agents shows a settings gear beside sort when the layout has no Spaces mod", () => {
  const overlays = [];
  const { instance, context } = init("sidebar-agents", {
    layout: () => ({ id: "sidebar", children: [
      { type: "block", content: { mod: "spaces" } },
      { type: "block", content: { mod: "sidebar-agents" } },
    ] }),
    openOverlay: spec => overlays.push(spec),
  });
  const root = instance.render(context);
  const gear = byId(root, "sidebar-settings");
  const sort = byId(root, "ag-sort");
  assert.ok(gear);
  assert.ok(sort);
  const controls = [...nodes(root)].find(node => uiState(node).children.includes(gear));
  assert.ok(uiState(controls).children.includes(sort));
  uiState(gear).handlers.on_click();
  assert.deepEqual(structuredClone(overlays), [
    { mod: "sidebar-agents", kind: "dialog", width: 510, height: 823, props: { sidebarSettings: true } },
  ]);
});

test("Agents hides the settings gear when Spaces is nested in the current layout", () => {
  const { instance, context } = init("sidebar-agents", {
    layout: () => ({ type: "row", children: [{ id: "sidebar", type: "column", children: [
      { type: "block", content: { mod: "sidebar-agents" } },
      { type: "stack", children: [{ type: "block", content: { mod: "sidebar-spaces" } }] },
    ] }] }),
  });
  const root = instance.render(context);
  assert.equal(byId(root, "sidebar-settings"), undefined);
  assert.ok(byId(root, "ag-sort"));
});

test("Agents settings overlay renders without starting the panel", () => {
  const unexpected = () => assert.fail("the settings overlay started the Agents panel");
  const changed = [], closed = [];
  const { instance, context, mocks, storage } = init("sidebar-agents", {
    checking: () => false,
    props: () => ({ sidebarSettings: true, overlay: "agent-settings" }),
    setShared: (key, value) => changed.push([key, value]),
    closeOverlay: id => closed.push(id),
    agents: unexpected, setBadge: unexpected, setAgentOrder: unexpected,
  }, { pins: "[]" });
  const dialog = instance.render(context);
  assert.match(textOf(dialog), /Ultimate Sidebar Settings/);
  assert.equal(context.tasks.length, 0);
  assert.equal(context.timers.length, 0);
  assert.equal(mocks.gpuiBase.scrollHandles.length, 0);
  assert.equal(storage.getItem("pins"), "[]");
  uiState(byId(dialog, "setting-agents.sort-grouped")).handlers.on_click();
  assert.deepEqual(changed, [["agents.sort", "grouped"]]);
  uiState(byId(dialog, "settings-done")).handlers.on_click();
  instance.close();
  assert.deepEqual(closed, ["agent-settings"]);
});

test("Sidebar display preferences affect both lists and preserve individual fold choices", () => {
  const values = new Map();
  const shared = key => values.get(key);
  const space = { id: "local", name: "Project", folder: "/project", tabs: [{ id: "tab" }] };
  const model = {
    shared,
    spaces: () => [space],
    panes: () => [{ pane: "p1", terminal: "t1", tab: "tab", cwd: space.folder }],
    terminals: () => [{ address: "t2", parent: "t1", state: "live", status: "idle" }],
    agents: () => [{ address: "t1", pane: "p1", tab: "tab", space: "local", status: "working", seq: 1 }],
    layout: () => ({ id: "sidebar", size: { px: 400 } }),
  };
  const spaces = init("sidebar-spaces", model);
  const agents = init("sidebar-agents", model);
  const git = { branch: "feature", upstream: "origin/feature", dirty: 2, conflicts: 4, ahead: 3, behind: 1 };
  for (const panel of [spaces, agents]) panel.instance.git[JSON.stringify([null, space.folder])] = git;
  spaces.instance.cupHere = true;
  spaces.instance.ports = { "": { local: [{ number: 3000, address: "127.0.0.1" }] } };
  const render = panel => panel.instance.render(panel.context);
  for (const [key, labels] of [["Branch", ["feature", "origin"]], ["Changes", ["*2", "✘4"]], ["Sync", ["↑3", "↓1"]]]) {
    for (const panel of [spaces, agents]) for (const label of labels) assert.ok(textOf(render(panel)).includes(label), label);
    values.set(`sidebar.git.show${key}`, false);
    for (const panel of [spaces, agents]) for (const label of labels) assert.ok(!textOf(render(panel)).includes(label), label);
  }
  assert.ok(textOf(render(spaces)).includes("CPU"));
  assert.ok(byId(render(spaces), "space-ports-local"));
  assert.ok(byId(render(spaces), "machine-cup-local"));
  assert.ok(byId(render(spaces), "task-t2"));
  assert.ok(byId(render(agents), "sub-t2"));
  values.set("sidebar.spaces.showUsage", false);
  values.set("sidebar.spaces.showPorts", false);
  values.set("sidebar.spaces.showCup", false);
  values.set("sidebar.spaces.expandTerminals", false);
  values.set("sidebar.agents.expandChildren", false);
  values.set("agents.sort", "grouped");
  let spaceRoot = render(spaces);
  let agentRoot = render(agents);
  assert.ok(!textOf(spaceRoot).includes("CPU"));
  assert.equal(byId(spaceRoot, "space-ports-local"), undefined);
  assert.equal(byId(spaceRoot, "space-port-tree-local"), undefined);
  assert.equal(byId(spaceRoot, "machine-cup-local"), undefined);
  assert.equal(byId(spaceRoot, "task-t2"), undefined);
  assert.equal(byId(agentRoot, "sub-t2"), undefined);
  assert.ok(byId(agentRoot, "sp-local"));
  uiState(byId(spaceRoot, "terminals-space-local")).handlers.on_click({}, { ...spaces.context, stop_propagation() {} });
  uiState(byId(agentRoot, "fold-t1")).handlers.on_click({}, { ...agents.context, stop_propagation() {} });
  assert.ok(byId(render(spaces), "task-t2"));
  assert.ok(byId(render(agents), "sub-t2"));
  spaces.instance.cup = "on";
  assert.ok(byId(render(spaces), "machine-cup-local"), "an active hold can still be stopped");
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
  assert.equal(title("🔴 Login"), "🔴 Login");
  assert.equal(title("❤️ Deploy"), "❤️ Deploy");
  assert.equal(title("[ ! ] ⏳️ 🔴 Login"), "🔴 Login");
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
  const resize = uiState(area).handlers.on_size_change;
  resize({ width: 300, height: 200 }, context);
  resize({ width: 300, height: 180 }, context);
  assert.deepEqual(instance.scroll.items, [3, 1, 1, 1]);
  instance.folded.add("vps");
  instance.render(context);
  assert.equal(instance.activeAt, -1);
  assert.deepEqual(instance.scroll.items, [3, 1, 1, 1], "a hidden row has no scroll target");
});

test("Spaces machine folds leave manual scrolling alone", () => {
  const { instance, context, herdr } = spacePanel();
  let root = instance.render(context);
  const size = { width: 300, height: 200 };
  const resize = () => {
    const area = [...nodes(root)].find(n => uiState(n).handlers.on_size_change);
    uiState(area).handlers.on_size_change({ ...size }, context);
  };
  resize();
  for (const [machine, activeRows] of [["local", [2, 3]], ["vps", [-1, 3]]]) {
    for (const activeAt of activeRows) {
      const { handlers } = uiState(byId(root, `machine-${machine}`));
      const event = { position: { x: 20, y: 40 } };
      handlers.on_mouse_down(event, context);
      handlers.on_mouse_up(event, context);
      root = instance.render(context);
      assert.equal(instance.activeAt, activeAt);
      resize(); // Herdr can report the same viewport size again after a fold.
      assert.deepEqual(instance.scroll.items, [3, 3]);
    }
  }
  instance.render(context);
  assert.deepEqual(instance.scroll.items, [3, 3]);
  herdr.spaces = () => spaces.map(s => ({ ...s, active: s.id === "local" }));
  instance.render(context);
  assert.deepEqual(instance.scroll.items, [3, 3, 1]);
});

test("Agents reuses trees within a render and rebuilds them when terminals change", () => {
  let state = "live";
  const { instance, context } = init("sidebar-agents", {
    agents: () => [{ address: "t1", status: "idle", seq: 1 }],
    terminals: () => [
      { address: "t2", parent: "t1", state, status: "working" },
      { address: "t3", parent: "t1", state: "live", status: "idle" },
    ],
  });
  assert.ok(byId(instance.render(context), "sub-t2"));
  const first = instance.tree("t1");
  assert.equal(instance.tree("t1"), first);
  assert.equal(first[1].lines[0], "└");
  assert.equal(first[0].lines[0], "├");

  state = "finished";
  const root = instance.render(context);
  assert.equal(byId(root, "sub-t2"), undefined);
  assert.ok(byId(root, "sub-t3"));
  const next = instance.tree("t1");
  assert.notEqual(next, first);
  assert.equal(next.length, 1);
  assert.equal(next[0].lines[0], "└");
});

test("Agents shows a plain terminal as the parent of a reporting child agent", () => {
  const calls = [];
  const attached = { address: "t1", pane: "p1", space: "home", tab: "tab", status: "idle", seq: 1 };
  const { instance, context, herdr } = init("sidebar-agents", {
    agents: () => [attached],
    spaces: () => [{ id: "home", active: true, tabs: [{ id: "tab" }] }],
    panes: () => [{ pane: "p1", terminal: "t1" }, { pane: "p2", terminal: "t2", cwd: "/work/current-project" }],
    terminals: () => [
      { address: "t3", parent: "t2", name: "pi-test", state: "live", status: "idle" },
      { address: "t4", parent: "t1", name: "nested-pi", state: "live", status: "done" },
      { address: "t5", parent: "t2", name: "plain-shell", state: "live", status: null },
      { address: "t8", parent: "t5", name: "agent-through-shell", state: "live", status: "idle" },
      { address: "t9", parent: "t1", name: "plain-command", state: "live", status: null },
      { address: "t6", state: "finished", status: "idle" },
      { address: "t2", state: "live", program: { name: "zsh" }, cwd: "/work/original-project" },
      { address: "t7", name: "independent-pi", state: "live", status: "idle" },
    ],
    run: (command, args) => calls.push([command, args.terminal ?? args.pane, args.place]),
  });
  let root = instance.render(context);
  assert.ok(textOf(byId(root, "ag-t2")).includes("current-project"));
  assert.ok(textOf(byId(root, "ag-t2")).includes("Local · t2"));
  assert.ok(textOf(byId(root, "sub-t3")).includes("pi-test"));
  assert.ok(byId(root, "sub-t4"));
  assert.ok([...nodes(byId(root, "sub-t4"))].some(n => uiState(n).calls.some(([method, color]) => method === "bg" && color === herdr.theme().done)),
    "a finished turn uses the same Done dot as Spaces");
  assert.ok(byId(root, "sub-t8"), "an agent launched through a plain shell stays visible");
  assert.equal(byId(root, "sub-t5"), undefined);
  assert.equal(byId(root, "sub-t9"), undefined);
  const rows = [...nodes(root)].map(node => uiState(node).id).filter(id => /^(ag|sub)-t\d+$/.test(id ?? ""));
  assert.equal(rows.indexOf("sub-t3"), rows.indexOf("ag-t2") + 1, "the child follows the plain parent's row");
  for (const address of ["t3", "t4", "t5", "t6"]) assert.equal(byId(root, `ag-${address}`), undefined);
  uiState(byId(root, "ag-t2")).handlers.on_click({}, context);
  uiState(byId(root, "sub-t3")).handlers.on_click({}, context);
  uiState(byId(root, "sub-t4")).handlers.on_click({}, context);
  uiState(byId(root, "ag-t7")).handlers.on_click({}, context);
  assert.equal(byId(root, "close-child-t3"), undefined);
  uiState(byId(root, "sub-t3")).handlers.on_mouse_move({}, context);
  root = instance.render(context);
  assert.ok(byId(root, "close-child-t3"));
  assert.equal(byId(root, "close-child-t4"), undefined);
  uiState(byId(root, "sub-t3")).handlers.on_hover(false, context);
  root = instance.render(context);
  assert.equal(byId(root, "close-child-t3"), undefined);
  uiState(byId(root, "sub-t3")).handlers.on_mouse_move({}, context);
  root = instance.render(context);
  let closeStopped = false;
  uiState(byId(root, "close-child-t3")).handlers.on_click({}, { ...context, stop_propagation() { closeStopped = true; } });
  assert.equal(closeStopped, true);
  assert.deepEqual(calls, [["pane.focus", "p2", undefined], ["terminal.peek", "t3", undefined],
    ["terminal.peek", "t4", undefined], ["terminal.keep", "t7", "tab"], ["terminal.kill", "t3", undefined]]);
  uiState(byId(root, "fold-t2")).handlers.on_click({}, { ...context, stop_propagation() {} });
  assert.equal(byId(instance.render(context), "sub-t3"), undefined);
  herdr.layout = () => ({ id: "sidebar", size: { px: 76 } });
  root = instance.render(context);
  assert.ok(byId(root, "ag-t3"));
});

test("both sidebars keep child terminals in a space on their machine", () => {
  const local = { id: "local", name: "Local", active: true, tabs: [] };
  const first = { id: "vps/first", name: "First", machine: "vps", tabs: [{ id: "vps/first-tab" }] };
  const home = { id: "vps/home", name: "Home", machine: "vps", tabs: [{ id: "vps/tab" }] };
  const parent = { address: "vps/t1", pane: "vps/p1", tab: "vps/tab", space: home.id, status: "working" };
  const child = { address: "vps/t3", name: "Worker", parent: "vps/t2", state: "live", status: "idle" };
  for (const [name, rowId] of [["sidebar-spaces", "task-vps/t3"], ["sidebar-agents", "sub-vps/t3"]]) {
    const calls = [];
    const toasts = [];
    const settings = new Map();
    const { instance, context, herdr } = init(name, {
      shared: key => settings.get(key),
      spaces: () => [local, first, home],
      panes: () => [{ pane: parent.pane, tab: parent.tab, terminal: parent.address }],
      agents: () => [parent],
      terminals: () => [child, { address: "vps/t2", parent: parent.address, state: "live" }],
      run: (command, args) => calls.push([command, args.id ?? args.terminal, args.place]),
    });
    const root = instance.render(context);
    if (name === "sidebar-agents") {
      assert.ok(textOf(byId(root, "ag-vps/t1")).includes("vps · t1"));
      settings.set("sidebar.agents.showParentTerminalIds", false);
      const hidden = instance.render(context);
      const parentText = textOf(byId(hidden, "ag-vps/t1"));
      assert.ok(parentText.includes("vps"));
      assert.ok(!parentText.includes("vps · t1"));
      assert.ok(textOf(byId(hidden, rowId)).includes("Workert3"));
      settings.delete("sidebar.agents.showParentTerminalIds");
    }
    const row = byId(root, rowId);
    const id = [...nodes(row)].find(node => uiState(node).children.includes("t3"));
    assert.ok(id, name);
    assert.ok(uiState(id).calls.some(([method, color]) => method === "text_color" && color === herdr.theme().dim), name);
    const nameGroup = uiState(row).children.find(node => textOf(node) === "Workert3");
    assert.equal(uiState(nameGroup).children.at(-1), id, name);
    settings.set("sidebar.showChildTerminalIds", false);
    const hidden = instance.render(context);
    assert.ok(textOf(byId(hidden, rowId)).includes("Worker"), name);
    assert.ok(!textOf(byId(hidden, rowId)).includes("t3"), name);
    if (name === "sidebar-agents") {
      assert.ok(textOf(byId(hidden, "ag-vps/t1")).includes("vps · t1"));
    }
    settings.delete("sidebar.showChildTerminalIds");
    const keep = ["terminal.keep", child.address, "tab"];
    const clickKeep = () => {
      calls.length = 0;
      const render = () => instance.render(context);
      uiState(byId(render(), rowId)).handlers.on_mouse_move({}, context);
      uiState(byId(render(), "keep-child-vps/t3")).handlers.on_click({}, { ...context, stop_propagation() {} });
    };
    clickKeep();
    assert.deepEqual(calls, [["space.select", home.id, undefined], keep], name);
    herdr.spaces = () => [{ ...local, active: false }, { ...first, active: true }, home];
    clickKeep();
    assert.deepEqual(calls, [keep], name);
    herdr.spaces = () => [local, first, home];
    herdr.panes = () => [{ pane: parent.pane, tab: "missing-tab", terminal: parent.address }];
    clickKeep();
    assert.deepEqual(calls, [["space.select", first.id, undefined], keep], name);
    herdr.spaces = () => [local];
    herdr.notify = toast => toasts.push(toast);
    clickKeep();
    assert.deepEqual(calls, [], name);
    assert.equal(toasts.length, 1, name);
  }
});

test("Both sidebars copy terminal addresses and show temporary feedback in their own headers", () => {
  for (const [mod, prefix] of [
    ["sidebar-agents", ""], ["sidebar-agents", "vps/"],
    ["sidebar-spaces", ""], ["sidebar-spaces", "vps/"],
  ]) {
    const inAgents = mod === "sidebar-agents";
    const feedbackId = inAgents ? "ag-copied" : "space-copied";
    const controlId = inAgents ? "ag-sort" : "space-new";
    const space = { id: `${prefix}project`, name: "Project", machine: prefix ? "vps" : null, tabs: [{ id: `${prefix}tab` }] };
    const parent = { address: `${prefix}t1`, pane: `${prefix}p1`, tab: space.tabs[0].id, space: space.id, status: "working", title: "Parent" };
    const child = { address: `${prefix}t2`, parent: parent.address, state: "live", status: "working", name: "Child" };
    const settings = new Map();
    const events = [];
    const { instance, context, herdr } = init(mod, {
      spaces: () => [space],
      panes: () => [{ pane: parent.pane, tab: parent.tab, terminal: parent.address }],
      agents: () => [parent], terminals: () => [child], shared: key => settings.get(key),
      notify: ({ title, level }) => events.push([title, level]),
    });
    const render = () => instance.render(context);
    assert.equal(byId(render(), feedbackId), undefined);
    const rows = [
      [`${inAgents ? "sub" : "task"}-${child.address}`, child.address, "sidebar.showChildTerminalIds", true],
    ];
    if (inAgents) rows.unshift([`ag-${parent.address}`, parent.address, "sidebar.agents.showParentTerminalIds", false]);
    for (const [rowId, address, setting, move] of rows) {
      const copyId = `copy-${address}`;
      assert.equal(byId(render(), copyId), undefined);
      const row = uiState(byId(render(), rowId));
      if (move) row.handlers.on_mouse_move({}, context);
      else row.handlers.on_hover(true, context);
      const hoveredRow = byId(render(), rowId);
      const copy = byId(hoveredRow, copyId);
      assert.ok(copy);
      const group = [...nodes(hoveredRow)].find(node => uiState(node).children.includes(copy));
      const siblings = uiState(group).children;
      assert.ok(textOf(siblings[siblings.indexOf(copy) - 1]).endsWith(address.split("/").pop()));
      assert.equal(textOf(copy), "");
      const { calls } = uiState(copy);
      assert.ok(calls.some(([method]) => method === "cursor_default"));
      const [, hover] = calls.find(([method]) => method === "hover");
      hover(copy);
      assert.ok(calls.some(([method, color]) => method === "bg" && color === herdr.theme().hover));
      events.length = 0;
      uiState(copy).handlers.on_click({}, {
        ...context,
        stop_propagation: () => events.push("stop"),
        write_to_clipboard: text => events.push(text),
      });
      assert.deepEqual(events, ["stop", address]);
      const copied = render();
      const control = byId(copied, controlId);
      const controls = [...nodes(copied)].find(node => uiState(node).children.includes(control));
      assert.equal(textOf(byId(controls, feedbackId)), "Copied");
      settings.set(setting, false);
      assert.equal(byId(render(), copyId), undefined);
      settings.delete(setting);
      row.handlers.on_hover(false, context);
      assert.equal(byId(render(), copyId), undefined);
    }
    const timers = context.timers.filter(timer => timer.kind === "after");
    assert.equal(timers.length, rows.length);
    if (inAgents) assert.equal(timers[0].cancelled, true);
    const last = timers.at(-1);
    assert.equal(last.ms, 2000);
    last.fn(context);
    assert.equal(byId(render(), feedbackId), undefined);
  }
});

test("viewing a completed child clears that turn in both sidebars", () => {
  const child = { address: "t2", parent: "t1", state: "live", status: "done", turn: 1 };
  const values = new Map();
  const host = {
    spaces: () => [{ id: "project", name: "Project", tabs: [{ id: "tab" }] }],
    panes: () => [{ pane: "p1", tab: "tab", terminal: "t1" }],
    terminals: () => [child],
    agents: () => [{ address: "t1", pane: "p1", space: "project", tab: "tab", status: "idle" }],
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  };
  const agents = init("sidebar-agents", host);
  const spaces = init("sidebar-spaces", host);
  agents.herdr.checking = () => false;
  spaces.herdr.checking = () => false;
  const hasDone = (panel, id) => [...nodes(byId(panel.instance.render(panel.context), id))].some(n =>
    uiState(n).calls.some(([method, color]) => method === "bg" && color === panel.herdr.theme().done));
  assert.equal(hasDone(agents, "sub-t2"), true);
  assert.equal(hasDone(spaces, "task-t2"), true);
  const peekFrom = (panel, rowId) => {
    const render = () => panel.instance.render(panel.context);
    uiState(byId(render(), rowId)).handlers.on_hover(true, panel.context);
    let root = render();
    assert.equal(byId(root, "keep-child-t2"), undefined, "a hover notification alone does not reveal Keep");
    assert.equal(byId(root, "close-child-t2"), undefined, "a hover notification alone does not reveal Close");
    uiState(byId(root, rowId)).handlers.on_mouse_move({}, panel.context);
    root = render();
    assert.ok(byId(root, "keep-child-t2"));
    assert.ok(byId(root, "close-child-t2"));
    uiState(byId(root, rowId)).handlers.on_click({}, panel.context);
    root = render();
    assert.equal(byId(root, "close-child-t2"), undefined, "opening a peek clears hover even without mouse leave");
  };
  peekFrom(spaces, "task-t2");
  assert.equal(hasDone(agents, "sub-t2"), false);
  assert.equal(hasDone(spaces, "task-t2"), false);
  child.turn++;
  assert.equal(hasDone(agents, "sub-t2"), true);
  assert.equal(hasDone(spaces, "task-t2"), true);
  peekFrom(agents, "sub-t2");
  assert.equal(hasDone(spaces, "task-t2"), false);
});

test("Spaces groups live pane-less terminals by their nearest ancestor space", () => {
  const { instance, context, herdr } = spacePanel();
  herdr.spaces = () => spaces.map(s => ({ ...s, tabs: [{ id: `${s.id}-tab` }] }));
  herdr.panes = () => [
    { terminal: "t1", tab: "local-tab" },
    { terminal: "vps/t1", tab: "remote-tab" },
  ];
  let terms = [
    { address: "t1", state: "live" },
    { address: "vps/t1", parent: "t1", state: "live" },
    { address: "t2", name: "tests", parent: "t1", state: "live" },
    { address: "t3", name: "deep child", parent: "t2", state: "live" },
    { address: "t4", parent: "t3", state: "finished" },
    { address: "t5", parent: "t4", state: "live" },
    { address: "t6", parent: "gone", state: "live" },
    { address: "t7", parent: "t6", state: "live" },
    { address: "vps/t2", parent: "vps/t1", state: "live" },
    { address: "vps/t3", parent: "gone", state: "live" },
  ];
  herdr.terminals = () => terms;
  instance.ports = { "": { local: [{ number: 3000, address: "127.0.0.1" }] } };
  const calls = [];
  herdr.run = (...args) => calls.push(args);
  let root = instance.render(context);
  const ids = section => [...nodes(byId(root, `terminal-section-${section}`))]
    .map(n => uiState(n).id).filter(id => id?.startsWith("task-"));
  assert.deepEqual(ids("space-local"), ["task-t2", "task-t3", "task-t5"]);
  assert.ok(byId(root, "space-port-tree-local"));
  assert.deepEqual(ids("space-remote"), ["task-vps/t2"]);
  assert.deepEqual(ids("machine-local"), ["task-t6", "task-t7"]);
  assert.deepEqual(ids("machine-vps"), ["task-vps/t3"]);
  const unattached = byId(root, "terminals-machine-local");
  assert.equal(textOf(unattached), "Unattached");
  uiState(unattached).handlers.on_click({}, context);
  root = instance.render(context);
  assert.deepEqual(ids("machine-local"), []);
  assert.equal(textOf(byId(root, "terminals-machine-local")), "Unattached 2");
  uiState(byId(root, "terminals-machine-local")).handlers.on_click({}, context);
  root = instance.render(context);
  assert.equal(instance.activeAt, 4, "the unattached section counts toward the next machine's scroll offset");
  uiState(byId(root, "task-t3")).handlers.on_click({}, context);
  assert.equal(byId(root, "close-child-vps/t2"), undefined);
  uiState(byId(root, "task-vps/t2")).handlers.on_mouse_move({}, context);
  root = instance.render(context);
  assert.ok(byId(root, "close-child-vps/t2"));
  assert.equal(byId(root, "close-child-t3"), undefined);
  let closeStopped = false;
  uiState(byId(root, "close-child-vps/t2")).handlers.on_click({}, { ...context, stop_propagation() { closeStopped = true; } });
  assert.equal(closeStopped, true);
  assert.deepEqual(calls.map(([command, args]) => [command, args.terminal]), [["terminal.peek", "t3"], ["terminal.kill", "vps/t2"]]);
  const toggle = byId(byId(root, "space-local"), "terminals-space-local");
  assert.equal(textOf(toggle), "");
  uiState(toggle).handlers.on_click({}, { ...context, stop_propagation() {} });
  root = instance.render(context);
  assert.deepEqual(ids("space-local"), []);
  assert.equal(byId(root, "space-port-tree-local"), undefined);
  assert.equal(textOf(byId(root, "terminals-space-local")), "3");
  assert.ok(!textOf(root).includes("Tasks"));
  terms = [];
  root = instance.render(context);
  assert.equal(byId(root, "terminals-space-local"), undefined);
  assert.equal(byId(root, "terminals-machine-local"), undefined);
});

test("machine Clear only removes finished records from the selected machine", async () => {
  const { instance, context, herdr } = spacePanel();
  const calls = [], toasts = [];
  herdr.notify = toast => toasts.push(toast);
  herdr.hc = async args => {
    calls.push([...args]);
    return { code: 0, stdout: JSON.stringify({
      machines: [{ name: "vps", state: "connected" }],
      terminals: [
        { address: "t1", state: "finished", parent: "t0" },
        { address: "vps/t1", state: "finished" },
        { address: "vps/t2", state: "live" },
      ],
    }) };
  };
  instance.refreshMachines(context);
  await context.tasks.at(-1).promise;
  calls.length = 0;
  instance.machines = [{ name: "vps", state: "connected" }];
  const button = byId(instance.render(context), "machine-clear-vps");
  assert.equal(textOf(button), "1");
  const click = uiState(button).handlers.on_click;
  let stopped = 0;
  const cx = { ...context, stop_propagation() { stopped++; } };
  click({}, cx);
  click({}, cx);
  await context.tasks.at(-1).promise;
  assert.equal(stopped, 2);
  assert.deepEqual(calls, [["ls", "--all", "--json"], ["rm", "vps/t1", "--json"]]);
  assert.equal(toasts[0].title, "vps: removed 1 finished terminal");
  assert.equal(textOf(byId(instance.render(context), "machine-clear-vps")), "0");
});

test("Spaces clears the machine list when a successful response omits machines", async () => {
  const { instance, context, herdr } = spacePanel();
  herdr.hc = async () => ({ code: 0, stdout: "{}", stderr: "" });
  instance.refreshMachines(context);
  await context.flush();
  assert.equal(instance.machines.length, 0);
});

test("the trash count refreshes when a terminal leaves the live snapshot", async () => {
  const { instance, context, herdr } = spacePanel();
  let terms = [{ address: "t1", state: "live" }, { address: "t2", state: "live" }];
  const calls = [];
  herdr.terminals = () => terms;
  herdr.hc = async args => {
    calls.push([...args]);
    return { code: 0, stdout: JSON.stringify({ terminals: terms }) };
  };
  instance.render(context);
  terms = [{ address: "t1", state: "finished" }]; // t2 exited with --rm.
  instance.render(context);
  assert.equal(instance.finishedCountsDirty, true);
  instance.checkNew(context);
  await context.flush();
  assert.deepEqual(calls, [["ls", "--all", "--json"]]);
  assert.equal(textOf(byId(instance.render(context), "machine-clear-local")), "1");
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
  const event = { position: { x: 20, y: 40 } };
  uiState(head).handlers.on_mouse_down(event, context);
  uiState(head).handlers.on_mouse_up(event, context);
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

test("polls pause while the window is out of sight and resume when it shows", async () => {
  let visible = false;
  const calls = [];
  const loaded = loadMod("sidebar-spaces", {
    checking: () => false,
    window: () => ({ platform: "macos", active: false, visible }),
    exec: async () => { calls.push(["exec"]); return { code: 1, stdout: "", stderr: "" }; },
    hc: async args => { calls.push(["hc", ...args]); return { code: 1, stdout: "", stderr: "" }; },
  });
  const instance = new loaded.Class();
  instance.init({}, loaded.context);
  await loaded.context.flush();
  calls.length = 0;
  const every = ms => loaded.context.timers.find(t => t.ms === ms);
  instance.checkNew = () => calls.push(["checkNew"]);
  for (const ms of [15000, 2000, 250]) await every(ms).fn(loaded.context);
  await loaded.context.flush();
  assert.deepEqual(calls, [], "nothing runs while hidden");
  visible = true;
  await every(2000).fn(loaded.context);
  await every(250).fn(loaded.context);
  await loaded.context.flush();
  assert.ok(calls.some(c => c[0] === "hc" && c[1] === "machine"), "machines are asked again on return");
  assert.equal(calls.filter(c => c[0] === "exec").length, 1, "sampling resumes with one call for Local");
  assert.ok(calls.some(c => c[0] === "checkNew"));

  // Herdr without the flag keeps polling.
  const old = loadMod("sidebar-agents", { checking: () => false, window: () => ({ platform: "macos" }) });
  const agents = new old.Class();
  agents.init({}, old.context);
  let refreshed = 0;
  agents.refreshGit = () => refreshed++;
  await old.context.timers.find(t => t.ms === 5000).fn(old.context);
  assert.equal(refreshed, 1);
});

test("Spaces samples load and ports once per connected machine per tick", async () => {
  let now = 10_000;
  const calls = [];
  const pending = makeDeferred();
  const loaded = init("sidebar-spaces", {
    checking: () => false,
    spaces: () => spaces.map(s => ({ ...s, tabs: [{ id: `${s.id}-tab` }] })),
    panes: () => [{ tab: "local-tab", terminal: "t1" }, { tab: "remote-tab", terminal: "vps/t1" }],
  });
  const { instance, context, herdr } = loaded;
  await context.flush();
  loaded.vm.Date = { now: () => now };
  instance.machines.push({ name: "vps", state: "connected" }, { name: "away", state: "offline" });
  herdr.exec = async (cmd, [flag, script], { on, timeout }) => {
    calls.push([cmd, flag, on, timeout]);
    assert.match(script, /\[stats\]/);
    assert.match(script, /\[ports\]/);
    assert.ok(script.includes('lsof -nP -a -u "$(id -u)" -iTCP -sTCP:LISTEN -Fpcn'));
    return pending.promise;
  };
  const tick = () => context.timers.find(t => t.ms === 2000).fn(context);
  const expected = [["sh", "-c", null, 15000], ["sh", "-c", "vps", 15000]];
  tick();
  await Promise.resolve();
  assert.deepEqual(calls, expected);
  now += 5000;
  tick();
  await Promise.resolve();
  assert.deepEqual(calls, expected, "a pending sample blocks another call on its machine");

  pending.resolve({ code: 0, stdout: [
    "[stats]", "os Darwin", "cores 4", "memsize 81920",
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)", "Pages active: 10.",
    "60.0", "20.0", "[/stats]", "[ports]", "L 501 127.0.0.1:3000",
    "O 501 HC_TERMINAL_ID t1", "[/ports]", "",
  ].join("\n") });
  await context.flush();
  for (const [key, space] of [["", "local"], ["vps", "remote"]]) {
    const { cpu, mem, cores, stale } = instance.stats[key];
    assert.deepEqual([cpu, mem, cores, stale], [20, 50, 4, false]);
    const [{ number, address }] = instance.ports[key][space];
    assert.deepEqual([number, address], [3000, "127.0.0.1:3000"]);
  }
  tick();
  await context.flush();
  assert.deepEqual(calls, [...expected, ...expected]);
  tick();
  await context.flush();
  assert.deepEqual(calls, [...expected, ...expected], "a completed sample is throttled until the next interval");
});

test("Spaces samples enabled sections and keeps old readings on failure", async () => {
  const settings = new Map();
  const scripts = [];
  let result;
  const { instance, context } = init("sidebar-spaces", {
    shared: key => settings.get(key),
    exec: async (_cmd, [_flag, script]) => {
      scripts.push(script);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const sample = async () => {
    instance.sampleAt = {};
    instance.refreshSample(context);
    await context.flush();
  };
  settings.set("sidebar.spaces.showUsage", false);
  settings.set("sidebar.spaces.showPorts", false);
  await sample();
  assert.deepEqual(scripts, []);

  const priorStats = { stale: false };
  const priorPorts = { local: [{ number: 9000 }] };
  instance.stats[""] = priorStats;
  instance.ports[""] = priorPorts;
  settings.set("sidebar.spaces.showUsage", true);
  result = { code: 1, stdout: "" };
  await sample();
  assert.match(scripts.at(-1), /\[stats\]/);
  assert.doesNotMatch(scripts.at(-1), /\[ports\]/);
  assert.equal(priorStats.stale, true);
  assert.equal(instance.stats[""], priorStats);
  assert.equal(instance.ports[""], priorPorts);

  priorStats.stale = false;
  settings.set("sidebar.spaces.showUsage", false);
  settings.set("sidebar.spaces.showPorts", true);
  result = new Error("exec timed out");
  await sample();
  assert.doesNotMatch(scripts.at(-1), /\[stats\]/);
  assert.match(scripts.at(-1), /\[ports\]/);
  assert.equal(priorStats.stale, false);
  assert.equal(instance.ports[""], priorPorts);

  settings.set("sidebar.spaces.showUsage", true);
  result = { code: 0, stdout: "[stats]\nos Darwin\n[ports]\n[/ports]\n" };
  await sample();
  assert.equal(priorStats.stale, true, "an incomplete usage section keeps the last reading");
  assert.equal(Object.keys(instance.ports[""]).length, 0, "a complete empty port section clears old listeners");
});

test("Spaces defers repository watch events while hidden", async () => {
  let visible = false;
  const fired = makeDeferred();
  const { instance, context } = init("sidebar-spaces", {
    window: () => ({ visible }),
    spaces: () => [{ id: "s1", folder: "/repo", tabs: [] }],
    watchFolder: (() => { let n = 0; return () => n++ ? new Promise(() => {}) : fired.promise; })(),
  });
  const key = JSON.stringify([null, "/repo"]);
  instance.git[key] = { repo: key };
  const refreshed = [];
  instance.refreshGit = (keys) => refreshed.push([...keys]);
  instance.watch("/repo", context);
  fired.resolve([]);
  await flushTurns();
  assert.deepEqual(refreshed, []);
  assert.ok(instance.gitForced.has(key));
  const requested = instance.gitRequested.get(key);
  visible = true;
  instance.checkNew(context);
  assert.equal(instance.gitRequested.get(key), requested);
  assert.deepEqual(refreshed, [[key]]);
});

test("Spaces drags let go outside the list end without a drop", () => {
  const { instance, context, herdr } = spacePanel();
  const calls = [];
  herdr.run = (name, args) => calls.push([name, args]);
  let root = instance.render(context);
  const windowHandlers = () => uiState([...nodes(root)].find(n => uiState(n).handlers["on_window_mouse_up:left"]) ?? root).handlers;
  assert.equal(windowHandlers()["on_window_mouse_up:left"], undefined, "nothing watches the window without a press");
  const bounds = { x: 0, y: 30, width: 300, height: 400 };
  const press = () => {
    uiState(byId(root, "space-local")).handlers["on_mouse_down:left"]({ position: { x: 100, y: 60 } }, context);
    root = instance.render(context);
    uiState(byId(root, "space-remote")).handlers.on_mouse_move({ position: { x: 100, y: 100 } }, context);
    return windowHandlers();
  };

  let handlers = press();
  handlers["on_window_mouse_up:left"]({ position: { x: 100, y: 100 }, bounds }, context);
  assert.equal(instance.spacePress?.id, "local", "a release inside is the row's to handle");
  handlers["on_window_mouse_up:left"]({ position: { x: 500, y: 100 }, bounds }, context);
  assert.equal(instance.spacePress, null);
  assert.equal(instance.spaceOver, null);

  handlers = press();
  handlers.on_window_mouse_move({ position: { x: 500, y: 100 }, bounds, pressed_button: "left" }, context);
  assert.equal(instance.spacePress?.id, "local", "still carried outside the list");
  assert.equal(instance.spaceOver, null, "no drop line while outside");
  handlers.on_window_mouse_move({ position: { x: 100, y: 100 }, bounds }, context);
  assert.equal(instance.spacePress, null, "released outside the window");

  uiState(byId(root, "machine-vps")).handlers["on_mouse_down:left"]({}, context);
  root = instance.render(context);
  windowHandlers()["on_window_mouse_up:left"]({ position: { x: 100, y: 0 }, bounds }, context);
  assert.equal(instance.machinePress, null);
  assert.deepEqual(calls, []);
});

test("palette commands reach the panels", async () => {
  const queue = (commands) => {
    let i = 0;
    return () => i < commands.length ? Promise.resolve(commands[i++]) : new Promise(() => {});
  };
  const overlays = [], toasts = [];
  const spacesPanel = loadMod("sidebar-spaces", {
    checking: () => false, nextCommand: queue(["settings", "keep-awake"]), openOverlay: spec => overlays.push(spec),
    notify: toast => toasts.push(toast),
  });
  const s = new spacesPanel.Class();
  let cups = 0;
  s.toggleCup = () => cups++;
  s.init({}, spacesPanel.context);
  await flushTurns();
  assert.equal(JSON.stringify(overlays.map(o => o.props)), JSON.stringify([{ sidebarSettings: true }]));
  assert.equal(cups, 0, "no cup where caffeinate is missing");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "Keep awake needs caffeinate (macOS)");
  assert.equal(toasts[0].level, "info");

  const sorts = [];
  const agentsPanel = loadMod("sidebar-agents", {
    checking: () => false, nextCommand: queue(["sort-grouped", "bogus", "sort-priority"]),
    setShared: (key, value) => sorts.push([key, value]),
  });
  new agentsPanel.Class().init({}, agentsPanel.context);
  await flushTurns();
  assert.deepEqual(sorts, [["agents.sort", "grouped"], ["agents.sort", "priority"]]);
});

test("palette entries name their own mod's commands", async () => {
  const { readFileSync } = await import("node:fs");
  for (const mod of ["sidebar-spaces", "sidebar-agents"]) {
    const { palette } = JSON.parse(readFileSync(new URL(`../mods/${mod}/mod.json`, import.meta.url), "utf8"));
    assert.ok(palette.length);
    for (const p of palette) assert.ok(p.command.startsWith(`${mod}.`) && p.title.trim() && !p.args, p.command);
  }
});

test("an idle agent marked unread waits in Unread until focus leaves and returns", () => {
  // As the core reports them: an agent you have looked at still says done.
  const t1 = { address: "t1", state: "live", status: "done", turn: 1 };
  const t2 = { address: "t2", state: "live", status: "done", turn: 1 };
  const values = new Map();
  let focus = "t1";
  const host = {
    spaces: () => [{ id: "project", name: "Project", tabs: [{ id: "tab" }] }],
    panes: () => [{ pane: "p1", tab: "tab", terminal: "t1" }, { pane: "p2", tab: "tab", terminal: "t2" }],
    terminals: () => [t1, t2],
    agents: () => [t1, t2].map((t, i) => ({ address: t.address, pane: `p${i + 1}`, space: "project", tab: "tab", status: t.status === "done" ? "idle" : t.status, seq: i, focused: focus === t.address })),
    focused: () => ({ terminal: focus }),
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  };
  const p = init("sidebar-agents", host);
  p.herdr.checking = () => false;
  p.context.stop_propagation ??= () => {};
  const render = () => p.instance.render(p.context);
  const hasUnread = (address) => [...nodes(byId(render(), `ag-${address}`))].some(n =>
    uiState(n).calls.some(([method, color]) => method === "bg" && color === p.herdr.theme().ansi1));
  const mark = (address) => {
    uiState(byId(render(), `ag-${address}`)).handlers.on_hover(true, p.context);
    uiState(byId(render(), `unread-${address}`)).handlers.on_click({}, p.context);
  };

  // Another agent: cleared by focusing it.
  mark("t2");
  assert.equal(hasUnread("t2"), true);
  assert.ok(byId(render(), "sec-2.5"), "Unread has its own section");
  t1.status = "working";
  const sections = [...nodes(render())].map(n => uiState(n).id).filter(id => id?.startsWith("sec-"));
  assert.deepEqual(sections, ["sec-2.5", "sec-2"], "Unread sections come before Working");
  t1.status = "done";
  focus = "t2";
  assert.equal(hasUnread("t2"), false);

  // The focused agent: kept while you stay, cleared when you come back.
  mark("t2");
  assert.equal(hasUnread("t2"), true);
  focus = "t1";
  assert.equal(hasUnread("t2"), true);
  assert.equal(hasUnread("t2"), true, "leaving keeps the mark's turn");
  focus = "t2";
  assert.equal(hasUnread("t2"), false);

  // A new turn clears it.
  focus = "t1";
  mark("t2");
  t2.status = "working";
  t2.turn++;
  render();
  t2.status = "done";
  assert.equal(hasUnread("t2"), false);

  // Mark all as read empties the section.
  mark("t2");
  focus = "t2";
  mark("t1");
  assert.equal(hasUnread("t1"), true);
  uiState(byId(render(), "mark-all-read")).handlers.on_click({}, p.context);
  assert.equal(Object.keys(values.get("sidebar.unread")).length, 0);
  assert.equal(byId(render(), "sec-2.5"), undefined);
});

test("Spaces shows a space with an agent marked unread", () => {
  const t1 = { address: "t1", state: "live", status: "done", turn: 1 };
  const values = new Map([["sidebar.unread", { t1: { left: true, turn: 1 } }]]);
  const space = { id: "local", name: "Project", status: "idle", tabs: [{ id: "tab" }] };
  const p = init("sidebar-spaces", {
    spaces: () => [space],
    panes: () => [{ pane: "p1", tab: "tab", terminal: "t1" }],
    terminals: () => [t1],
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  });
  p.herdr.checking = () => false;
  const red = () => [...nodes(byId(p.instance.render(p.context), "space-local"))].some(n =>
    uiState(n).calls.some(([method, color]) => method === "bg" && color === p.herdr.theme().ansi1));
  assert.equal(red(), true);
  for (const status of ["working", "done", "blocked"]) {
    space.status = status;
    assert.equal(red(), false, `${status} outranks unread in a space`);
  }
  space.status = "idle";
  t1.turn++;
  assert.equal(red(), false, "a new turn ends the mark");
});

test("a folded group's dot shows working before unread", () => {
  const values = new Map([["agents.sort", "grouped"], ["sidebar.unread", { t2: { left: true, turn: 1 } }]]);
  const t1 = { address: "t1", state: "live", status: "working", turn: 1 };
  const t2 = { address: "t2", state: "live", status: "done", turn: 1 };
  const p = init("sidebar-agents", {
    spaces: () => [{ id: "project", name: "Project", tabs: [{ id: "tab" }] }],
    panes: () => [{ pane: "p1", tab: "tab", terminal: "t1" }, { pane: "p2", tab: "tab", terminal: "t2" }],
    terminals: () => [t1, t2],
    agents: () => [t1, t2].map((t, i) => ({ address: t.address, pane: `p${i + 1}`, space: "project", space_name: "Project", tab: "tab", status: t.status === "done" ? "idle" : t.status, seq: i })),
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  });
  p.herdr.checking = () => false;
  p.instance.folded.add("sp-project");
  const header = () => [...nodes(byId(p.instance.render(p.context), "sp-project"))];
  const spins = () => header().some(n => uiState(n).calls.some(([method]) => method === "spin"));
  const red = () => header().some(n => uiState(n).calls.some(([method, color]) => method === "bg" && color === p.herdr.theme().ansi1));
  assert.equal(spins(), true);
  assert.equal(red(), false);
  t1.status = "done";
  assert.equal(red(), true, "with nothing running, the unread mark shows");
});

test("with Clear unread when set to Marked read, only Mark as read or a new turn clears it", () => {
  const t1 = { address: "t1", state: "live", status: "done", turn: 1 };
  const t2 = { address: "t2", state: "live", status: "done", turn: 1 };
  const values = new Map([["sidebar.agents.unreadClear", "manual"]]);
  let focus = "t1";
  const p = init("sidebar-agents", {
    spaces: () => [{ id: "project", name: "Project", tabs: [{ id: "tab" }] }],
    panes: () => [{ pane: "p1", tab: "tab", terminal: "t1" }, { pane: "p2", tab: "tab", terminal: "t2" }],
    terminals: () => [t1, t2],
    agents: () => [t1, t2].map((t, i) => ({ address: t.address, pane: `p${i + 1}`, space: "project", tab: "tab", status: t.status === "done" ? "idle" : t.status, seq: i, focused: focus === t.address })),
    focused: () => ({ terminal: focus }),
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  });
  p.herdr.checking = () => false;
  p.context.stop_propagation ??= () => {};
  const render = () => p.instance.render(p.context);
  const hasUnread = address => [...nodes(byId(render(), `ag-${address}`))].some(n =>
    uiState(n).calls.some(([method, color]) => method === "bg" && color === p.herdr.theme().ansi1));
  const click = (address, id) => {
    uiState(byId(render(), `ag-${address}`)).handlers.on_hover(true, p.context);
    uiState(byId(render(), `${id}-${address}`)).handlers.on_click({}, p.context);
  };

  click("t2", "unread");
  for (const f of ["t2", "t1", "t2", "t1"]) {
    focus = f;
    assert.equal(hasUnread("t2"), true, `viewing does not read it (focus ${f})`);
  }
  click("t2", "unread"); // Mark as read: the same button on an unread row
  assert.equal(hasUnread("t2"), false);

  click("t2", "unread");
  t2.status = "working";
  t2.turn++;
  render();
  t2.status = "done";
  assert.equal(hasUnread("t2"), false, "a new turn still clears it");

  // Switching back to clear-on-view while looking at it waits for leave and return.
  click("t2", "unread");
  focus = "t2";
  assert.equal(hasUnread("t2"), true);
  values.set("sidebar.agents.unreadClear", "view");
  assert.equal(hasUnread("t2"), true);
  focus = "t1";
  assert.equal(hasUnread("t2"), true);
  focus = "t2";
  assert.equal(hasUnread("t2"), false);
});

test("the unread color setting colors the Agents dot", () => {
  const t2 = { address: "t2", state: "live", status: "done", turn: 1 };
  const values = new Map([["sidebar.unread", { t2: { left: true, turn: 1 } }], ["sidebar.agents.unreadColor", "blue"]]);
  const p = init("sidebar-agents", {
    terminals: () => [t2],
    agents: () => [{ address: "t2", status: "idle", seq: 1, title: "Agent" }],
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
  });
  p.herdr.checking = () => false;
  const colors = () => [...nodes(byId(p.instance.render(p.context), "ag-t2"))].flatMap(n =>
    uiState(n).calls.filter(([method]) => method === "bg").map(([, color]) => color));
  const t = p.herdr.theme();
  assert.ok(colors().includes(t.ansi4));
  values.set("sidebar.agents.unreadColor", "purple");
  assert.ok(colors().includes(t.ansi5));
  values.delete("sidebar.agents.unreadColor");
  assert.ok(colors().includes(t.ansi1), "red by default");
});
