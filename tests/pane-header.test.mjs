import assert from "node:assert/strict";
import test from "node:test";
import { loadMod, uiState } from "./load-mod.mjs";

test("the pane title prefers a custom name and falls back after it is cleared", () => {
  const pane = {
    pane: "p1",
    name: "Review",
    program: { agent: true, name: "Pi" },
    title: "Terminal title",
  };
  const { createInstance } = loadMod("pane-header", {
    panes: () => [pane],
    props: () => ({ pane: pane.pane }),
  });
  const view = createInstance();
  view.init();

  const title = () => uiState(uiState(view.render()).children[0]).children[0];
  assert.equal(title(), "Review");

  pane.name = null;
  assert.equal(title(), "Pi");

  delete pane.name;
  assert.equal(title(), "Pi");
});

test("the pane header shows an agent marked unread until its next turn", () => {
  const pane = { pane: "p1", terminal: "t1", status: "done", program: { agent: true, name: "Pi" }, title: "Pi" };
  const term = { address: "t1", state: "live", status: "done", turn: 1 };
  const marks = { t1: { left: true, turn: 1 } };
  const { createInstance, herdr } = loadMod("pane-header", {
    panes: () => [pane],
    props: () => ({ pane: pane.pane }),
    terminals: () => [term],
    shared: key => key === "sidebar.unread" ? marks : undefined,
  });
  const view = createInstance();
  view.init();
  const dots = () => {
    const out = [];
    const walk = n => { const s = uiState(n); if (!s) return; out.push(...s.calls.filter(([m]) => m === "bg").map(([, c]) => c)); s.children.forEach(walk); };
    walk(view.render());
    return out;
  };
  assert.ok(dots().includes(herdr.theme().ansi1));
  term.turn++;
  assert.ok(!dots().includes(herdr.theme().ansi1));
  assert.ok(dots().includes(herdr.theme().done));
});

test("the pane header uses the unread color chosen in sidebar settings", () => {
  const pane = { pane: "p1", terminal: "t1", status: "done", program: { agent: true, name: "Pi" }, title: "Pi" };
  const term = { address: "t1", state: "live", status: "done", turn: 1 };
  const values = { "sidebar.unread": { t1: { left: true, turn: 1 } }, "sidebar.agents.unreadColor": "purple" };
  const { createInstance, herdr } = loadMod("pane-header", {
    panes: () => [pane],
    props: () => ({ pane: pane.pane }),
    terminals: () => [term],
    shared: key => values[key],
  });
  const view = createInstance();
  view.init();
  const colors = [];
  const walk = n => { const s = uiState(n); if (!s) return; colors.push(...s.calls.filter(([m]) => m === "bg").map(([, c]) => c)); s.children.forEach(walk); };
  walk(view.render());
  assert.ok(colors.includes(herdr.theme().ansi5));
});
