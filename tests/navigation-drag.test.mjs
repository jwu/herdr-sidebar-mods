import test from "node:test";
import assert from "node:assert/strict";
import { loadMod, uiState } from "./load-mod.mjs";

function* nodes(root) {
  const state = uiState(root);
  if (!state) return;
  yield root;
  for (const child of state.children) yield* nodes(child);
}
const byId = (root, id) => [...nodes(root)].find(node => uiState(node).id === id);
const call = (node, method) => uiState(node)?.calls.find(([name]) => name === method);

function agentsPanel() {
  const data = {
    agents: [
      { address: "t1", pane: "p1", tab: "tab1", space: "s1", space_name: "One", status: "working", seq: 3 },
      { address: "vps/t2", pane: "p2", tab: "tab2", space: "s2", space_name: "Two", status: "idle", seq: 1 },
    ],
    terminals: [],
    focus: { terminal: "t1" },
    width: 300,
  };
  const loaded = loadMod("sidebar-agents", {
    agents: () => data.agents,
    terminals: () => data.terminals,
    panes: () => [
      { pane: "p1", terminal: "t1", tab: "tab1", cwd: "/live/first" },
      { pane: "p2", terminal: "vps/t2", tab: "tab2", cwd: "/remote/second" },
    ],
    spaces: () => [
      { id: "s1", name: "One", folder: "/original/one", tabs: [{ id: "tab1", name: "One" }] },
      { id: "s2", name: "Two", machine: "vps", folder: "/original/two", tabs: [{ id: "tab2", name: "Two" }] },
    ],
    focused: () => data.focus,
    layout: () => ({ id: "sidebar", size: { px: data.width } }),
  });
  const instance = new loaded.Class();
  instance.init({}, loaded.context);
  return { ...loaded, instance, data, render: () => instance.render(loaded.context) };
}

test("Agents scrolls to the focused row, counts headers, and leaves manual scroll alone", () => {
  const p = agentsPanel();
  let root = p.render();
  assert.equal(p.instance.activeAt, 1); // Working header, t1, Idle header, t2
  assert.deepEqual(p.instance.scroll.items, [1]);
  assert.strictEqual(call(byId(root, "ag-list"), "track_scroll")[1], p.instance.scroll);
  p.render();
  assert.deepEqual(p.instance.scroll.items, [1]);
  p.data.focus = { terminal: "vps/t2" };
  root = p.render();
  assert.equal(p.instance.activeAt, 3);
  assert.deepEqual(p.instance.scroll.items, [1, 3]);
  uiState(byId(root, "ag-list")).handlers.on_size_change({ width: 300, height: 150 }, p.context);
  assert.deepEqual(p.instance.scroll.items, [1, 3, 3]);
});

test("Agents unfolds a newly focused group but respects folding the current group", () => {
  const p = agentsPanel();
  p.render();
  p.instance.folded.add("sec-1");
  p.data.focus = { terminal: "vps/t2" };
  let root = p.render();
  assert.equal(p.instance.folded.has("sec-1"), false);
  assert.ok(byId(root, "ag-vps/t2"));
  uiState(byId(root, "sec-1")).handlers.on_click({}, p.context);
  root = p.render();
  assert.equal(p.instance.folded.has("sec-1"), true);
  assert.equal(byId(root, "ag-vps/t2"), undefined);
  assert.equal(p.instance.activeAt, -1);
  p.data.focus = { terminal: "t1" };
  p.render();
  p.data.focus = { terminal: "vps/t2" };
  assert.ok(byId(p.render(), "ag-vps/t2"));
});

test("Agents reveals a focused kept sub-agent through both folds", () => {
  const p = agentsPanel();
  const child = { address: "t3", parent: "t1", state: "live", status: "idle", cwd: "/child" };
  p.data.terminals = [child];
  p.data.agents.push({ address: "t3", pane: "p3", tab: "tab1", space: "s1", status: "idle", seq: 0 });
  const before = p.render();
  uiState(byId(before, "fold-t1")).handlers.on_click({}, { ...p.context, stop_propagation() {} });
  assert.equal(byId(p.render(), "sub-t3"), undefined);
  p.instance.folded.add("sec-2");
  p.data.focus = { terminal: "t3" };
  const root = p.render();
  assert.equal(p.instance.folded.has("sec-2"), false);
  assert.ok(byId(root, "sub-t3"));
  assert.equal(p.instance.activeAt, 2); // group header, parent, child
  assert.equal(p.instance.scroll.items.at(-1), 2);
});

test("a kept child's Done stays on its row while the parent stays Working", () => {
  const p = agentsPanel();
  p.data.terminals = [{ address: "t3", parent: "t1", state: "live", status: "idle" }];
  const child = { address: "t3", pane: "p3", tab: "tab1", space: "s1", status: "done", seq: 4 };
  p.data.agents.push(child);
  let root = p.render();
  assert.ok(byId(root, "sec-2"));
  assert.equal(byId(root, "sec-3"), undefined);
  assert.ok([...nodes(byId(root, "sub-t3"))].some(node => call(node, "bg")?.[1] === p.herdr.theme().done));
  child.status = "blocked";
  root = p.render();
  assert.ok(byId(root, "sec-4"));
  assert.equal(byId(root, "sec-2"), undefined);
});

test("Agents follows peek and agent-block focus, including pinned and reordered rows", () => {
  const p = agentsPanel();
  p.data.terminals = [{ address: "t3", parent: "t1", state: "live", status: "blocked" }];
  p.data.focus = { terminal: "t1", shown: "t3" };
  p.render();
  assert.equal(p.instance.activeAt, 2);
  p.data.focus = { agent: "vps/t2" };
  p.data.agents[1].pinned = true;
  p.render();
  assert.equal(p.instance.activeAt, 1); // Pinned header, target
  p.data.agents[1].pinned = false;
  p.render();
  assert.equal(p.instance.activeAt, 4); // Needs you header, parent, child, Idle header, target
  assert.equal(p.instance.scroll.items.at(-1), 4);
});

test("Agents rail counts only rows and an unfocused list has no scroll target", () => {
  const p = agentsPanel();
  p.data.width = 76;
  p.data.focus = { terminal: "vps/t2" };
  let root = p.render();
  assert.equal(p.instance.activeAt, 1);
  assert.ok(call(byId(root, "ag-vps/t2"), "bg"));
  assert.equal(call(byId(root, "ag-t1"), "bg"), undefined);
  p.data.focus = { terminal: "t1" };
  root = p.render();
  assert.ok(call(byId(root, "ag-t1"), "bg"));
  assert.equal(call(byId(root, "ag-vps/t2"), "bg"), undefined);
  p.data.focus = null;
  p.render();
  assert.equal(p.instance.activeAt, -1);
  p.data.width = 300;
  p.render();
  assert.equal(p.instance.activeAt, -1, "a header is never a null-focus target");
});

test("Agents and sub-agents keep click actions without exposing terminal path drags", () => {
  const p = agentsPanel();
  p.data.terminals = [{ address: "vps/t3", parent: "t1", state: "live", status: "idle", cwd: "/child" }];
  const actions = [];
  p.herdr.run = (...args) => actions.push(args);
  for (const width of [300, 76]) {
    p.data.width = width;
    const root = p.render();
    assert.equal([...nodes(root)].some(node => call(node, "drag_paths")), false);
    uiState(byId(root, "ag-t1")).handlers.on_click();
    assert.equal(actions.at(-1)[0], "pane.focus");
    assert.equal(actions.at(-1)[1].pane, "p1");
    if (width >= 160) {
      uiState(byId(root, "sub-vps/t3")).handlers.on_click({}, p.context);
      assert.equal(actions.at(-1)[0], "terminal.peek");
      assert.equal(actions.at(-1)[1].terminal, "vps/t3");
    }
  }
});

function spacesPanel() {
  const data = { width: 300 };
  const loaded = loadMod("sidebar-spaces", {
    spaces: () => [
      { id: "s1", name: "One", folder: "/old", tabs: [{ id: "tab1" }] },
      { id: "s2", name: "Two", folder: "/remote", machine: "vps", tabs: [] },
    ],
    panes: () => [{ tab: "tab1", cwd: "/live/one" }],
    layout: () => ({ id: "sidebar", size: { px: data.width } }),
  });
  const instance = new loaded.Class();
  instance.init({}, loaded.context);
  instance.machines = [{ name: "vps", state: "connected" }];
  return { ...loaded, instance, data, render: () => instance.render() };
}

test("Spaces rows and ports do not expose terminal path drags in full or rail views", () => {
  const p = spacesPanel();
  p.instance.ports = { "": { s1: [{ number: 3000, address: "127.0.0.1:3000" }] } };
  for (const width of [300, 76]) {
    p.data.width = width;
    const root = p.render();
    assert.equal([...nodes(root)].some(node => call(node, "drag_paths")), false);
    if (width >= 160) assert.ok(byId(byId(root, "space-box-s1"), "space-ports-s1"), "ports stay inside the selection box");
  }
});

test("Spaces shortcuts and rail numbers follow the rows shown after reordering or folding", () => {
  const p = spacesPanel();
  const selections = [];
  p.herdr.run = (name, args) => {
    if (name === "space.select") selections.push(args.id);
  };
  p.instance.shown = new Set(["s1", "s2"]);
  p.instance.moveMachine("vps", null, [null, "vps"]);

  const check = (expected) => {
    const root = p.render();
    const rows = [...nodes(root)].filter(node => /^space-s[12]$/.test(uiState(node).id));
    assert.deepEqual(rows.map(node => uiState(node).id.slice("space-".length)), expected);
    if (p.data.width < 160) {
      const labels = rows.map(node => {
        const [label] = uiState(node).children;
        return uiState(label).children[0];
      });
      assert.deepEqual(labels, expected.map((_, i) => String(i + 1)));
    }
    selections.length = 0;
    for (let n = 1; n <= expected.length + 1; n++) p.instance.pick(n);
    assert.deepEqual(selections, expected);
  };

  for (const width of [300, 76]) {
    p.data.width = width;
    p.instance.folded.clear();
    check(["s2", "s1"]);
    p.instance.folded.add("vps");
    check(["s1"]);
    p.instance.folded.clear();
    p.instance.machines[0].state = "unreachable";
    p.instance.machines[0].why = 'a different core answers there ("new-core")';
    check(width < 160 ? ["s2", "s1"] : ["s1"]);
    p.instance.machines[0].state = "connected";
  }
});

test("Spaces preserves its original sidebar reorder and click-to-select gestures", () => {
  const p = spacesPanel();
  const actions = [];
  p.herdr.run = (...args) => actions.push(args);
  p.herdr.spaces = () => [
    { id: "s1", name: "One", folder: "/one", tabs: [] },
    { id: "s2", name: "Two", folder: "/two", tabs: [] },
  ];
  p.instance.shown = new Set(["s1", "s2"]);
  let root = p.render();
  uiState(byId(root, "space-s1")).handlers["on_mouse_down:left"]({}, p.context);
  uiState(byId(root, "space-s2")).handlers.on_mouse_move({}, p.context);
  uiState(byId(root, "space-s2")).handlers.on_mouse_up({}, p.context);
  assert.equal(actions[0][0], "space.move");
  assert.equal(actions[0][1].id, "s1");
  assert.equal(actions[0][1].index, 2);
  actions.length = 0;
  root = p.render();
  uiState(byId(root, "space-s1")).handlers["on_mouse_down:left"]({}, p.context);
  uiState(byId(root, "space-s1")).handlers.on_mouse_up({}, p.context);
  assert.equal(p.instance.pressed, null);
  assert.equal(p.instance.over, null);
  assert.equal(actions[0][0], "space.select");
  assert.equal(actions[0][1].id, "s1");
});
