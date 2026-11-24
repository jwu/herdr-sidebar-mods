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
