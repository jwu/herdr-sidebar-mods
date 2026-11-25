// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left. An idle agent can be marked unread.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, checking, setBadge, nextCommand } from "herdr";
import {
  find, sidebarPx, narrow, shown, GLYPH, SEG_GAP, SCROLL_GUTTER, fit, segmentBudgets,
  TREE_STROKE_WIDTH, treeLines, machineOf, keepTerminal, viewedTerminalStatuses, mark, statusDot,
  unreadStatuses, markUnread, markRead, unreadColor,
  AGENT_SORT, EXPAND_CHILDREN, SHOW_GIT_BRANCH, SHOW_GIT_CHANGES, SHOW_GIT_SYNC, enabled, statusAtStart,
  GIT_DIRTY_EVERY, GIT_REFS_EVERY, gitKey, checkGit, readGitStore, gitRecordOf, writeGitStore,
} from "./shared.js";
import { settingsButton, settingsDialog, settingsOverlay } from "./settings.js";
import { checkForUpdate } from "./update.js";

const openSettings = () => openOverlay(settingsOverlay("sidebar-agents"));

const AGENT_PADDING = 8;
const AGENT_GAP = 8;
const AGENT_STATUS_WIDTH = 16;
const AGENT_ICON_WIDTH = 20;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), node => node.id === "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Keep opening brackets, quotes and emoji in real titles. Strip known status marks.
const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // Test the original title: clean() strips a path's leading ~ or /.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
// Section order: what waits for you before what runs. An unread agent waits too.
const RANK = { blocked: 4, done: 3, unread: 2.5, working: 2, idle: 1 };
// One dot for many agents (a folded group or tree) shows activity before a
// mark you left yourself, as Spaces and the pane header do.
const DOT_RANK = { blocked: 4, done: 3, working: 2, unread: 1.5, idle: 1 };
const topStatus = statuses => statuses.reduce((m, s) => ((DOT_RANK[s] ?? 0) > (DOT_RANK[m] ?? 0) ? s : m), null);
// Prefer the pane's display status when available. A child without a pane
// keeps the core's Done state, as in Spaces.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared(AGENT_SORT)) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2.5: "Unread", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2.5: "unread", 2: "working" };
const tone = (t, status) => status === "unread" ? unreadColor(t) : t[status];

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The folder an agent works in, by its last path segment (a Windows path too).
const base = (path) => (path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// A machine's core runs sixteen execs at once and the spaces panel may be using
// six looks of two, so two places here keep a slow repository from crowding the
// others out while leaving that room.
const AT_ONCE = 2;
const GIT_CURRENT_DIRTY_EVERY = 15000;

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    const view = props();
    if (view?.sortMenu || view?.sidebarSettings) return;
    this.folded = new Set();
    this.openChildren = new Map();
    this.hoveredChild = null;
    this.scroll = ScrollHandle.new();
    this.activeAt = -1;
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    this.changed = Object.fromEntries(Object.entries(this.changed).filter(([, c]) => c && typeof c.s === "string" && Number.isFinite(c.at)));
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    this.pendingPins = Array.isArray(this.pendingPins) ? this.pendingPins.filter(p => typeof p === "string") : [];
    this.migratingPins = new Set();
    this.git = {}; // gitKey() -> { branch, upstream, ahead, behind, dirty }, null: no repo
    this.gitRecords = {}; // separate refs/worktree ages survive shared-cache eviction
    this.gitAt = {}; // gitKey() -> when it was last looked at
    this.gitBranches = new Map(); // gitKey() -> last live branch
    this.gitForced = new Map(); // gitKey() -> when a branch change asked for refs
    this.gitBusy = false;
    if (checking()) return;
    this.badgeOwner = true;
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    // "sort-priority" and "sort-grouped" from the command palette (mod.json).
    cx.spawn(async () => {
      for (;;) {
        const command = String(await nextCommand());
        const sort = SORTS.find(s => `sort-${s.id}` === command);
        if (sort) setShared(AGENT_SORT, sort.id);
      }
    });
    // Out of sight, Git lookups and age ticks wait for the window to show again.
    cx.timer.every(5000, (cx) => { if (shown()) this.refreshGit(cx); });
    cx.timer.every(30000, (cx) => { if (shown()) cx.notify(); });
    // A newer release: asked at most once a day, shared with the Spaces panel.
    cx.spawn(() => checkForUpdate());
    cx.timer.every(3600 * 1000, (cx) => { if (shown()) cx.spawn(() => checkForUpdate()); });
  }

  close() {
    if (this.badgeOwner) setBadge(null);
  }

  updateBadge(list) {
    if (checking()) return;
    // Count actual agents before grouping/folding, not the parent's promoted rank.
    const count = list.filter(a => a.status === "blocked" || a.status === "done" || a.status === "unread").length;
    const badge = count ? String(count) : null;
    if (badge === this.badge) return;
    this.badge = badge;
    setBadge(badge);
  }

  // Use the same rows as render: a pane-less row gets its folder from core.
  places(list, ps, focus) {
    if (!list) return this.gitPlaces ?? [];
    const paneOf = new Map(ps.map(p => [p.pane, p]));
    const address = focus?.shown ?? focus?.terminal ?? focus?.agent;
    const out = new Map();
    for (const a of list) {
      const pane = paneOf.get(a.pane);
      const cwd = pane?.cwd ?? a.cwd;
      if (!cwd) continue;
      const on = machineOf(a.address);
      const key = gitKey(on, cwd);
      const current = a.focused || a.address === address || (focus?.space != null && a.space === focus.space);
      const dirtyEvery = current ? GIT_CURRENT_DIRTY_EVERY : GIT_DIRTY_EVERY;
      const prev = out.get(key);
      out.set(key, { on, cwd, branch: pane?.branch ?? prev?.branch ?? null, dirtyEvery: Math.min(prev?.dirtyEvery ?? GIT_DIRTY_EVERY, dirtyEvery) });
    }
    return [...out.entries()];
  }

  trackGitBranches(places, now) {
    const branches = new Map(places.map(([key, place]) => [key, place.branch]));
    for (const [key, branch] of branches) {
      if (this.gitBranches.has(key) && this.gitBranches.get(key) !== branch) this.gitForced.set(key, now);
    }
    this.gitBranches = branches;
    for (const key of this.gitForced.keys()) if (!branches.has(key)) this.gitForced.delete(key);
  }

  // The record this panel has of a place, in the shape the shared cache keeps.
  gitRecord(key) {
    if (this.gitRecords[key]) return this.gitRecords[key];
    if (!(key in this.git)) return null;
    const at = this.gitAt[key] ?? 0;
    return { at, refsAt: at, dirtyAt: at, info: this.git[key] ?? null, unsure: false };
  }

  // What the other panel (or an earlier run of this one) already knows about a
  // place: read into the list as it is, with no command and no write. `live`
  // limits it to the places this panel shows now.
  adoptGit(live) {
    const cache = readGitStore();
    for (const key of live) {
      const record = gitRecordOf(cache[key]);
      if (!record || record.at <= (this.gitAt[key] ?? 0)) continue;
      this.gitRecords[key] = record;
      this.gitAt[key] = record.at;
      this.git[key] = record.info;
    }
  }

  // Places looked at together, refs every half minute and the worktree walk less
  // often. A machine that is away keeps what it showed and is asked again on the
  // next pass.
  refreshGit(cx) {
    if (this.gitBusy) return;
    const places = this.places();
    // Agents that moved or ended leave nothing behind.
    const live = new Set(places.map(([key]) => key));
    for (const key of Object.keys(this.git)) {
      if (live.has(key)) continue;
      delete this.git[key];
      delete this.gitAt[key];
      delete this.gitRecords[key];
    }
    this.adoptGit(live);
    const now = Date.now();
    const due = [];
    for (const [key, place] of places) {
      const record = this.gitRecord(key);
      const force = this.gitForced.has(key);
      if (!force && record?.unsure && now - record.at < GIT_REFS_EVERY) continue;
      const walk = !record || now - record.dirtyAt >= (record.info ? (place.dirtyEvery ?? GIT_DIRTY_EVERY) : GIT_DIRTY_EVERY);
      if (walk || force || now - record.refsAt >= GIT_REFS_EVERY) due.push({ key, place, walk });
    }
    due.sort((a, b) => a.place.dirtyEvery - b.place.dirtyEvery);
    if (!due.length) return;
    this.gitBusy = true;
    cx.spawn(async (cx) => {
      let next = 0;
      const results = new Map();
      try {
        await Promise.allSettled(Array.from({ length: Math.min(AT_ONCE, due.length) }, async () => {
          while (next < due.length) {
            const { key, place, walk } = due[next++];
            const since = this.gitForced.get(key);
            this.gitForced.delete(key);
            const record = await checkGit(key, place, this.gitRecord(key), { walk, force: since != null, since: since ?? now, results });
            this.gitRecords[key] = record;
            this.gitAt[key] = record.at;
            this.git[key] = record.info;
          }
        }));
      } finally {
        this.gitBusy = false;
        writeGitStore(results);
        cx.notify();
        if (this.gitForced.size && shown()) this.refreshGit(cx);
      }
    });
  }

  // One line of segments sharing `room`: measured against the glyph estimate,
  // each keeps one glyph and grows in turn. The tail goes before the machine
  // name is left without a readable share.
  // `fixed` parts keep their own width and color at the end of the line (ahead
  // and behind counts); the rest share the room by budget.
  nameLine(parts, room) {
    const MIN_NAME = 6;
    const fixed = parts.filter((p) => p.fixed && p.text);
    let kept = parts.filter((p) => !p.fixed && p.text);
    const reserved = fixed.reduce((n, p) => n + p.text.length * GLYPH + SEG_GAP, 0);
    const glyphs = (n) => Math.floor((room - reserved - SEG_GAP * Math.max(0, n - 1)) / GLYPH);
    while (kept.length > 1 && (glyphs(kept.length) < kept.length || glyphs(kept.length) < MIN_NAME + kept.length - 1)) kept.pop();
    if (!kept.length && !fixed.length) return null;
    const budget = Math.max(1, glyphs(kept.length));
    const widths = segmentBudgets(kept.map((p) => p.text.length), budget);
    // The name takes what the tail's budget leaves, so the tail sits flush right.
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(SEG_GAP)
      .items_center()
      .children([
        ...kept.map((p, i) => div()
          .when(i === 0, (el) => el.flex_1().min_w(0))
          .when(i > 0, (el) => el.flex_none())
          .truncate()
          .text_size(11).text_color(p.color).child(i === 0 ? p.text : fit(p.text, widths[i]))),
        ...fixed.map((p) => div().flex_none().text_size(11).text_color(p.color).child(p.text)),
      ]);
  }

  // Stamps agents whose state changed. Done, unread and idle count as one: looking
  // at or marking a finished agent isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" || a.status === "unread" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared(AGENT_SORT, s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
    viewedTerminalStatuses(terminals(), addr);
  }

  // Skip plain terminals in the tree while keeping any agents they started.
  agentChildren(addr) {
    return (this.liveChildren.get(addr) ?? []).flatMap(k =>
      this.listed.has(k.address) || RANK[kidStatus(k, this.listed)]
        ? [k]
        : this.agentChildren(k.address));
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(addr) {
    const cached = this.trees.get(addr);
    if (cached) return cached;
    const walk = (parent, lead) => {
      const kids = this.agentChildren(parent);
      return kids.flatMap((k, i) => {
        const last = i === kids.length - 1;
        return [
          { t: k, lines: [...lead, last ? "└" : "├"] },
          ...walk(k.address, [...lead, last ? "" : "│"]),
        ];
      });
    };
    const rows = walk(addr, []);
    this.trees.set(addr, rows);
    return rows;
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const leading = statusAtStart();
    const treeInset = (AGENT_ICON_WIDTH - TREE_STROKE_WIDTH) / 2;
    const status = this.statusCell(t, { status: st });
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(leading ? AGENT_PADDING : AGENT_PADDING + treeInset)
      .pr(AGENT_PADDING)
      .rounded(4)
      .my(1)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.ansi5 + "26"))
      .when(this.hoveredChild === k.address, el => el.bg(t.hover))
      .on_mouse_move((_e, cx) => {
        if (this.hoveredChild === k.address) return;
        this.hoveredChild = k.address;
        cx.notify();
      })
      .on_hover((on, cx) => {
        if (on || this.hoveredChild !== k.address) return;
        this.hoveredChild = null;
        cx.notify();
      })
      .on_click((_e, cx) => {
        this.hoveredChild = null;
        cx.notify();
        if (this.listed.has(k.address)) run("pane.focus", { terminal: k.address });
        else this.peek(k.address);
      })
      .when(leading, el => el.child(status.mr(treeInset + AGENT_GAP)))
      .children(treeLines(s.lines, t))
      .child(h_flex().ml(4).flex_1().min_w(0).items_center()
        .when(Boolean(pic), el => el.child(div().mr(8).flex_none().child(pic)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(k.name || k.template || k.program?.name || k.address)))
      .when(!this.listed.has(k.address), row => row.child(div().ml(4).size(18).flex_none()
        .when(this.hoveredChild === k.address, el => el.child(div().id(`keep-child-${k.address}`)
          .size_full().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).cursor_default().tooltip("Keep as tab")
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.hoveredChild = null;
            keepTerminal(k.address);
            cx.notify();
          })
          .child(svg("mods/sidebar-agents/keep.svg").size(12))))))
      .child(div().ml(4).size(18).flex_none()
        .when(this.hoveredChild === k.address, el => el.child(div().id(`close-child-${k.address}`)
          .size_full().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).tooltip("Close terminal")
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.hoveredChild = null;
            run("terminal.kill", { terminal: k.address });
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/x.svg").size(12)))))
      .when(!leading, el => el.child(status.ml(AGENT_GAP)));
  }

  statusCell(t, a) {
    return div().w(AGENT_STATUS_WIDTH).flex_none().flex().justify_center().child(this.status(t, a, true));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    if (a.status === "blocked" && !compact) return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (a.status === "done") return statusDot(t.done ?? t.dim);
    if (a.status === "unread") return statusDot(unreadColor(t));
    return mark(a.status, t) ?? statusDot(t.dim + "00");
  }

  render(cx) {
    const t = theme();
    const view = props();
    if (view?.sortMenu) return this.sortMenu(t);
    if (view?.sidebarSettings) return settingsDialog(t, view.overlay, "cursor_default");
    const collapsed = narrow();
    const leading = statusAtStart();
    const expandChildren = enabled(EXPAND_CHILDREN);
    const showBranch = enabled(SHOW_GIT_BRANCH);
    const showChanges = enabled(SHOW_GIT_CHANGES);
    const showSync = enabled(SHOW_GIT_SYNC);
    const px = sidebarPx();
    const sort = sortOf();
    const focus = focused();
    const focusAddress = focus?.shown ?? focus?.terminal ?? focus?.agent ?? null;
    const all = unreadStatuses(viewedTerminalStatuses(terminals(), focus?.shown), focusAddress);
    const unread = new Set(all.filter(term => term.status === "unread").map(term => term.address));
    let list = agents().map(a => a.status === "idle" && unread.has(a.address) ? { ...a, status: "unread" } : a);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    // `agents()` requires a pane. Use core reports for agents that have
    // neither a pane nor a row in an attached agent's tree.
    const ps = panes();
    const paneByTerminal = new Map(ps.filter(p => p.terminal).map(p => [p.terminal, p]));
    const terminalByAddress = new Map();
    this.liveChildren = new Map();
    this.trees = new Map();
    for (const term of all) {
      terminalByAddress.set(term.address, term);
      if (term.state !== "live" || !term.parent) continue;
      const kids = this.liveChildren.get(term.parent);
      if (kids) kids.push(term);
      else this.liveChildren.set(term.parent, [term]);
    }
    const nestedUnderPane = new Set(list.flatMap(a => this.tree(a.address).map(s => s.t.address)));
    for (const term of all) {
      const status = term.status === "error" ? "blocked" : term.status;
      if (term.state !== "live" || !RANK[status] || paneByTerminal.has(term.address) ||
          this.listed.has(term.address) || nestedUnderPane.has(term.address)) continue;
      list.push({
        address: term.address,
        status,
        title: term.name || term.template || term.title || term.program?.name || term.address,
        program: term.program,
        cwd: term.cwd,
        seq: term.status_ms ?? term.created_ms ?? 0,
        pinned: Boolean(term.labels?.["herdr.pinned"]),
        focused: focus?.shown === term.address,
      });
    }
    this.updateBadge(list);
    const agentAddresses = new Set(list.map(a => a.address));
    const modelSpaces = spaces();
    const spaceByTab = new Map(modelSpaces.flatMap(s => s.tabs.map(tab => [tab.id, s])));
    if (!collapsed) {
      const parents = new Map();
      for (const a of list) {
        const address = terminalByAddress.get(a.address)?.parent;
        if (!address || agentAddresses.has(address) || nestedUnderPane.has(a.address) || parents.has(address)) continue;
        const parent = terminalByAddress.get(address);
        const pane = paneByTerminal.get(address);
        if (parent?.state !== "live" && !pane) continue;
        const space = spaceByTab.get(pane?.tab);
        const program = parent?.program ?? pane?.program;
        const name = parent?.name || program?.name || parent?.foreground?.name || "Terminal";
        parents.set(address, {
          address, pane: pane?.pane, tab: pane?.tab, space: space?.id,
          space_name: space?.name, program, title: `${name} · ${address}`,
          cwd: parent?.cwd, seq: a.seq, focused: pane?.focused,
          terminalParent: true, childAddress: a.address,
        });
      }
      for (const parent of parents.values()) {
        // A higher terminal parent already shows this branch's agents.
        const seen = new Set([parent.address]);
        let ancestor = terminalByAddress.get(parent.address)?.parent;
        while (ancestor && !seen.has(ancestor) && terminalByAddress.get(ancestor)?.state === "live") {
          if (parents.has(ancestor) || agentAddresses.has(ancestor)) break;
          seen.add(ancestor);
          ancestor = terminalByAddress.get(ancestor)?.parent;
        }
        if (!parents.has(ancestor) && !agentAddresses.has(ancestor)) list.push(parent);
      }
    }
    if (!checking()) this.migratePins(all);
    const active = focus?.shown ?? focus?.terminal ?? focus?.agent ?? list.find(a => a.focused)?.address ?? null;
    // Only a new navigation unfolds the target. A manually folded current group
    // stays folded until focus leaves and returns.
    const navigated = active !== this.revealed;
    const now = Date.now();
    if (!checking()) this.track(list, now);
    this.hold(list);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const firstGit = !this.gitPlaces;
    const places = this.gitPlaces = this.places(list, ps, focus);
    this.adoptGit(new Set(places.map(([key]) => key)));
    this.trackGitBranches(places, now);
    if (!checking() && shown() && (firstGit || this.gitForced.size)) this.refreshGit(cx);
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map(a => {
      const childRanks = this.tree(a.address).map(({ t }) => {
        const status = kidStatus(t, this.listed);
        // Done belongs to the child. A plain terminal header has no status of its own.
        return (status === "done" || status === "unread") && !a.terminalParent ? RANK.idle : (RANK[status] ?? 0);
      });
      return [a.address, Math.max(this.rank(a), ...childRanks)];
    }));
    const rankOf = (a) => urgency.get(a.address);
    const sinceOf = (a) => a.terminalParent ? this.since({ address: a.childAddress }) : this.since(a);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || sinceOf(y) - sinceOf(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    if (!checking()) setAgentOrder(list.flatMap(a => a.terminalParent
      ? this.tree(a.address).map(s => s.t.address).filter(address => agentAddresses.has(address))
      : [a.address]));

    let offset = 0;
    this.activeAt = -1;
    const indexed = (el, address) => {
      if (active && address === active) this.activeAt = offset;
      offset++;
      return el;
    };
    const childrenOpen = address => this.openChildren.get(address) ?? expandChildren;
    const toggleChildren = (address, cx) => {
      cx.stop_propagation();
      this.openChildren.set(address, !childrenOpen(address));
      cx.notify();
    };
    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(a.address);
      if (navigated && !childrenOpen(a.address) && subs.some(s => s.t.address === active)) this.openChildren.set(a.address, true);
      const r = indexed(row(a, i, subs), a.address);
      if (!childrenOpen(a.address)) return [r];
      return [r, ...subs.map(s => indexed(this.subRow(t, s, active), s.t.address))];
    };

    // When folded, show the child count and use the most urgent child's color.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = topStatus(sts);
      const open = childrenOpen(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .flex_none()
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.muted : (tone(t, top) ?? t.muted))
        .cursor_default()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => toggleChildren(a.address, cx))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, el => el.child(String(subs.length)));
    };

    const leads = leadPanes(ps);
    const cwdOf = new Map(ps.map((p) => [p.pane, p.cwd]));
    const tabs = new Map(modelSpaces.flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      if (a.terminalParent) return [a.address, a.title];
      // A name someone gave the pane (Rename, Herdr 0.1.17+) wins, as in the pane header.
      if (a.pane_name) return [a.address, a.pane_name];
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, AGENT_ICON_WIDTH, t.foreground);
      const open = () => {
        if (a.pane) run("pane.focus", { pane: a.pane });
        else if (a.terminalParent) this.peek(a.address);
        else keepTerminal(a.address);
      };
      // An agent on another machine (`vps/t7`) says which.
      const machine = machineOf(a.address);
      if (collapsed) {
        const on = a.address === active;
        const status = h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true));
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .mx(6)
          .px(2)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .when(on, el => el.bg(t.ansi5 + "33"))
          .hover((s) => s.bg(t.hover))
          .on_click(open)
          .tooltip(label(a))
          .when(leading, el => el.child(status))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(on ? t.foreground : t.muted).child(String(i + 1)))
          .when(!leading, el => el.child(status));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_default()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // An idle agent (one you looked at) can go back to wait for you, and back again.
      const isUnread = a.status === "unread";
      const unreadButton = div()
        .id(`unread-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_default()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isUnread ? "Mark as read" : "Mark as unread")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (isUnread) markRead([a.address]);
          else markUnread(a.address, focusAddress);
          this.hovered = null;
          cx.notify();
        })
        .child(svg(isUnread ? "mods/workspace-chrome/check.svg" : "mods/sidebar-agents/eye-off.svg").size(13));
      const canMark = !a.terminalParent && (isUnread || a.status === "idle");
      // The program and state flank the working folder and machine details.
      const cwd = cwdOf.get(a.pane) ?? a.cwd ?? null;
      const folder = a.pane_name || (a.pane || a.terminalParent ? base(cwd) || cwd || a.space_name || label(a) : label(a));
      const g = cwd ? this.git[gitKey(machine, cwd)] : null;
      const remote = g?.upstream?.includes("/") ? `\u25b8 ${g.upstream.slice(0, g.upstream.indexOf("/"))}` : "";
      const tail = showBranch ? [g?.branch, remote].filter(Boolean).join(" ") : "";
      // The row's own columns, off the sidebar width: this is what is left.
      const line = this.nameLine([
        { text: machine ?? "Local", color: t.dim },
        ...(tail ? [{ text: tail, color: t.dim }] : []),
        ...(showChanges && g?.dirty > 0 ? [{ text: `*${g.dirty}`, color: t.ansi3, fixed: true }] : []),
        ...(showChanges && g?.conflicts > 0 ? [{ text: `\u2718${g.conflicts}`, color: t.ansi1, fixed: true }] : []),
        ...(showSync && g?.ahead > 0 ? [{ text: `\u2191${g.ahead}`, color: t.ansi2, fixed: true }] : []),
        ...(showSync && g?.behind > 0 ? [{ text: `\u2193${g.behind}`, color: t.ansi1, fixed: true }] : []),
      ], Math.max(0, px - 88));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(AGENT_PADDING)
        .py(3)
        .my(1)
        .flex_none()
        .gap(AGENT_GAP)
        .items_center()
        .rounded(4)
        .when(a.focused, (el) => el.bg(t.ansi5 + "33"))
        .cursor_default()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(open)
        .when(a.terminalParent, el => el.tooltip([cwd, a.title].filter(Boolean).join(" · ")))
        // A named pane hides its folder from the row; the tooltip keeps it.
        .when(Boolean(a.pane_name && !a.terminalParent && cwd), el => el.tooltip(cwd))
        .when(leading, el => el.child(this.statusCell(t, a)))
        .when(Boolean(pic), (el) => el.child(div().id(`agent-fold-${a.address}`).flex_none()
          .when(subs.length > 0, (el) => el.on_click((_e, cx) => toggleChildren(a.address, cx))).child(pic)))
        .when(!pic, (el) => el.child(div().w(AGENT_ICON_WIDTH).flex_none()))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().h(18).flex_none().gap(6).items_center()
            .child(h_flex().flex_1().min_w(0).gap(3).items_center()
              .child(div().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(folder))
              .when(subs.length > 0, el => el.child(fold(a, subs))))
            .when(canMark && this.hovered === a.address, (el) => el.child(unreadButton))
            .when(!a.terminalParent && this.hovered === a.address, (el) => el.child(pin))
            .when(this.hovered !== a.address && Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when)))))
          .child(h_flex().h(16).w_full().min_w(0).gap(4).items_center()
            .child(svg(`mods/workspace-chrome/${machine ? "server" : "monitor"}.svg`).size(12).flex_none().text_color(t.dim))
            .when(Boolean(line), (el) => el.child(line))))
        .when(!leading, el => el.child(this.statusCell(t, a)));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      const group = groups.find(g => g.id === id);
      if (group) group.members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "Unattached", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = topStatus(g.members.map(a => a.status));
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_default()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(tone(t, g.status) ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(g.status === "unread", (el) => el.child(div()
          .id("mark-all-read")
          .flex_none()
          .p(2)
          .rounded(4)
          .text_color(t.dim)
          .cursor_default()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Mark all as read")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            markRead(g.members.map(a => a.address));
            cx.notify();
          })
          .child(svg("mods/sidebar-agents/read-all.svg").size(13))))
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    if (navigated) for (const g of groups) {
      if (g.members.some(a => a.address === active || this.tree(a.address).some(s => s.t.address === active))) this.folded.delete(g.id);
    }
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap(g => [indexed(header(g), null), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);
    if (navigated || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(h_flex().items_center().gap(4)
              .when(!find(layout(), node => node.content?.mod === "sidebar-spaces"), el =>
                el.child(settingsButton(t, openSettings, "cursor_default")))
              .child(div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "sidebar-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)))),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).when(!collapsed, (el) => el.pl(8).pr(SCROLL_GUTTER)).overflow_y_scrollbar().mode("always")
        .track_scroll(this.scroll)
        .on_size_change((size, cx) => {
          // Herdr can report the same viewport size again after a list update.
          if (size.width === this.scrollSize?.width && size.height === this.scrollSize?.height) return;
          this.scrollSize = size;
          if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); }
        })
        .children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
