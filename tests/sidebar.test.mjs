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
  for (const key of ["git.showBranch", "git.showChanges", "git.showSync", "spaces.showUsage", "spaces.showPorts", "spaces.expandTerminals", "spaces.showCup", "agents.expandChildren"]) {
    const toggle = uiState(byId(dialog, `setting-sidebar.${key}`)).handlers.on_click;
    toggle();
    assert.equal(shared(`sidebar.${key}`), false);
    toggle();
    assert.equal(shared(`sidebar.${key}`), true);
  }
  uiState(byId(dialog, "setting-agents.sort-grouped")).handlers.on_click();
  assert.equal(shared("agents.sort"), "grouped");
  uiState(byId(dialog, "settings-done")).handlers.on_click();
  assert.deepEqual(closed, ["settings-overlay"]);
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
  uiState(area).handlers.on_size_change({ width: 300, height: 200 }, context);
  assert.deepEqual(instance.scroll.items, [3, 1, 1]);
  instance.folded.add("vps");
  instance.render(context);
  assert.equal(instance.activeAt, -1);
  assert.deepEqual(instance.scroll.items, [3, 1, 1], "a hidden row has no scroll target");
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
  const child = { address: "vps/t3", parent: "vps/t2", state: "live", status: "idle" };
  for (const [name, rowId] of [["sidebar-spaces", "task-vps/t3"], ["sidebar-agents", "sub-vps/t3"]]) {
    const calls = [];
    const toasts = [];
    const { instance, context, herdr } = init(name, {
      spaces: () => [local, first, home],
      panes: () => [{ pane: parent.pane, tab: parent.tab, terminal: parent.address }],
      agents: () => [parent],
      terminals: () => [child, { address: "vps/t2", parent: parent.address, state: "live" }],
      run: (command, args) => calls.push([command, args.id ?? args.terminal, args.place]),
    });
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
    herdr.window = () => ({ platform: "macos", push_toast: toast => toasts.push(toast) });
    clickKeep();
    assert.deepEqual(calls, [], name);
    assert.equal(toasts.length, 1, name);
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
  herdr.window = () => ({ push_toast: toast => toasts.push(toast) });
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
