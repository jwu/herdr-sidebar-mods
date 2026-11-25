// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped under a header per machine, even when only this computer is known.
// After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, machines, panes, terminals, focused, run, openOverlay, props, exec, hc, appHome, theme, shared, setShared, watchFolder, window, nextCommand, checking, notify } from "herdr";
import {
  sidebarPx, narrow, shown, GLYPH, SEG_GAP, SCROLL_GUTTER, fit, segmentBudgets,
  TREE_STROKE_WIDTH, treeLines, machineOf, keepTerminal, viewedTerminalStatuses, unreadStatuses, unreadColor, mark,
  SHOW_USAGE, SHOW_PORTS, SHOW_CUP, EXPAND_TERMINALS,
  SHOW_GIT_BRANCH, SHOW_GIT_CHANGES, SHOW_GIT_SYNC, enabled, statusAtStart,
  GIT_DIRTY_EVERY, GIT_REFS_EVERY, gitKey, checkGit, latestGitRecord, readGitStore, gitRecordOf, writeGitStore,
} from "./shared.js";
import { hostOf, sampleScript, sampleSections, parsePorts, parseStats } from "./probe.js";
import { CUP_PID, CUP_VERIFY, hasCaffeinate, cupPidAlive, readCupPid, removeCupPid, changeCupHold } from "./cup.js";
import { settingsButton, settingsDialog, settingsOverlay } from "./settings.js";

const openSettings = () => openOverlay(settingsOverlay("sidebar-spaces"));

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const SPACE_MARGIN = 8;
const SPACE_PADDING = 8;
const SPACE_GAP = 8;
const SPACE_STATUS_WIDTH = 16;
const SPACE_ICON_WIDTH = 20;
const FOLDER_WIDTH = 16;
const BRANCH_WIDTH = 13;
const PORT_ROW_HEIGHT = 18;
const DRAG_THRESHOLD = 4;

function startDrag(press, position) {
  if (!press || press.dragging) return false;
  if (Math.hypot(position.x - press.position.x, position.y - press.position.y) < DRAG_THRESHOLD) return false;
  press.dragging = true;
  return true;
}

const SPACE_TREE_INSET = SPACE_PADDING + (SPACE_ICON_WIDTH - TREE_STROKE_WIDTH) / 2;
const statusOffset = () => statusAtStart() ? SPACE_STATUS_WIDTH + SPACE_GAP : 0;

function statusCell(status, t) {
  return div().w(SPACE_STATUS_WIDTH).flex_none().flex().justify_center()
    .when(Boolean(status), el => el.child(mark(status, t)));
}
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => gitKey(s.machine, place(s, ps));

function terminalGroups(sp, ps, all) {
  const spaceOfTab = new Map(sp.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, s.id])));
  const spaceOfTerminal = new Map(ps.filter(p => p.terminal).map(p => [p.terminal, spaceOfTab.get(p.tab)]));
  const byAddress = new Map(all.map(term => [term.address, term]));
  const bySpace = new Map();
  const byMachine = new Map();
  for (const term of all) {
    if (term.state !== "live" || spaceOfTerminal.has(term.address)) continue;
    const seen = new Set([term.address]);
    let parent = term.parent;
    let space;
    while (parent && !seen.has(parent)) {
      space = spaceOfTerminal.get(parent);
      if (space) break;
      seen.add(parent);
      parent = byAddress.get(parent)?.parent;
    }
    const groups = space ? bySpace : byMachine;
    const key = space ?? machineOf(term.address);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(term);
  }
  return { bySpace, byMachine };
}

function terminalTree(terms) {
  const addresses = new Set(terms.map(term => term.address));
  const children = new Map();
  for (const term of terms) {
    const parent = addresses.has(term.parent) ? term.parent : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(term);
  }
  const rows = [];
  const visited = new Set();
  const visit = (term, lead, last) => {
    if (visited.has(term.address)) return;
    visited.add(term.address);
    rows.push({ term, lines: [...lead, last ? "└" : "├"] });
    const kids = children.get(term.address) ?? [];
    kids.forEach((child, i) => visit(child, [...lead, last ? "" : "│"], i === kids.length - 1));
  };
  const roots = children.get(null) ?? [];
  roots.forEach((root, i) => visit(root, [], i === roots.length - 1));
  for (const term of terms) visit(term, [], true); // Keep any cyclic parent links reachable.
  return rows;
}

// Bound the work across machines; a slow repository must not hold up the list.
const AT_ONCE = 6;

const SAMPLE_EVERY = 5000;
const CPU_WARN = 75;
const MEM_WARN = 80;
// A machine row's CPU sparkline: samples kept, bar width and gap, its height.
const HISTORY = 16;
const BAR_W = 3;
const BAR_GAP = 1;
const GRAPH_H = 14;
const METER_W = 36;

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" || status === "unread" ? "●" : "·";
}

export function tone(t, status) {
  return status === "unread" ? unreadColor(t) : t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.sidebarSettings) return;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.gitRecords = {}; // separate refs/worktree ages survive shared-cache eviction
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.gitInFlight = new Set(); // places already being checked
    this.gitWalk = new Set(); // where()s to walk for changed files, not only refs
    this.gitForced = new Set(); // where()s whose refs to read now, freshness aside
    this.gitRequested = new Map(); // when each pending look was requested
    this.gitBranches = new Map(); // where() -> last live branch
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repo -> its pending folder watch
    this.hidden = false;
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.spacePress = null;
    this.spaceOver = null;
    this.scroll = ScrollHandle.new();
    this.scrollSize = null;
    this.activeAt = -1;
    this.machineFoldChanged = false;
    this.machines = [];
    this.stats = {}; // machine -> { cpu, mem, cores }, percentages or null
    this.history = {}; // machine -> its last CPU shares, oldest first
    this.ticks = {}; // machine -> its last Linux CPU counters
    this.sampleAt = {}; // machine -> when it was last asked
    this.sampling = new Set(); // machines a sample is in flight for
    this.ports = {}; // machine "" -> { space -> [{ number, address }] }
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const [name, state] of Object.entries(this.reconnecting)) {
        const machine = state?.machine;
        if (!state || typeof state !== "object" || Array.isArray(state) || machine?.name !== name || typeof machine.target !== "string") {
          delete this.reconnecting[name];
          continue;
        }
        state.busy = false;
        if (typeof state.error !== "string") state.error = null;
        if (typeof machine.state !== "string") delete machine.state;
      }
    } catch { this.reconnecting = {}; }
    let folded;
    try { folded = JSON.parse(localStorage.getItem("machines.folded") ?? "[]"); } catch {}
    this.folded = new Set(Array.isArray(folded) ? folded.filter(m => m === null || typeof m === "string") : []);
    this.openTerminals = new Map();
    this.clearingFinished = new Set();
    this.finishedCounts = new Map();
    this.finishedRevision = 0;
    this.liveTerminalAddresses = null;
    this.finishedCountsDirty = false;
    this.refreshingFinishedCounts = false;
    this.hoveredChild = null;
    // The machine order the user dragged into place, by name (null is this one).
    // Machines it never lists keep the catalog's order after the arranged ones.
    let order;
    try { order = JSON.parse(localStorage.getItem("machines.order") ?? "[]"); } catch {}
    this.order = Array.isArray(order) ? [...new Set(order.filter(m => m === null || typeof m === "string"))] : [];
    this.machinePress = null; // { m, position, dragging } for the current header gesture
    this.machineOver = null; // { m } the header under the pointer
    // Initialize render state even in a check, but never run helpers or touch files.
    this.cup = "off"; // "off" | "on" | "busy"
    this.cupPid = null;
    this.cupHere = false;
    this.cupFile = `${appHome()}/${CUP_PID}`;
    if (checking()) return;
    // "pick1".."pick9" from keys.json: the panel's own row numbering, which the
    // machines dragged here can put out of step with `space.select`.
    // "settings" and "keep-awake" come from the command palette (mod.json).
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "settings") openSettings();
        else if (command === "keep-awake") {
          if (this.cupHere) this.toggleCup(cx);
          else notify({ title: "Keep awake needs caffeinate (macOS)", level: "info" });
        } else {
          const n = Number(command.replace(/^pick/, ""));
          if (n >= 1 && n <= 9) this.pick(n);
        }
      }
    });
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => { if (shown()) this.refreshMachines(cx); });
    // The Local header's cup is available wherever `caffeinate` exists.
    cx.spawn(async (cx) => {
      this.cupHere = await hasCaffeinate();
      if (this.cupHere) await this.syncCup(cx);
      cx.notify();
    });
    cx.timer.every(CUP_VERIFY, (cx) => this.verifyCup(cx));
    // Out of sight, the samples, scans and lookups wait; back in view, the
    // machines are asked at once rather than at the next 15s.
    cx.timer.every(2000, cx => {
      if (!shown()) { this.hidden = true; return; }
      if (this.hidden) { this.hidden = false; this.refreshMachines(cx); }
      this.refreshSample(cx);
    });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => { if (shown()) this.checkNew(cx); });
  }

  checkNew(cx) {
    if (this.finishedCountsDirty) this.refreshFinishedCounts(cx);
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const live = new Set(sp.map(s => where(s, ps)));
    this.adoptGit(live);
    const due = this.due(now, sp, ps);
    // Keep watches for live repositories first answered by the other panel.
    for (const key of live) {
      const repo = this.git[key]?.repo;
      if (repo && JSON.parse(key)[0] === null) this.watch(JSON.parse(repo)[1], cx);
    }
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      delete this.gitRecords[k];
      this.unsure.delete(k);
    }
    for (const k of this.pending) if (!keys.has(k)) this.pending.delete(k);
    for (const k of this.gitWalk) if (!keys.has(k)) this.gitWalk.delete(k);
    for (const k of this.gitForced) if (!keys.has(k)) this.gitForced.delete(k);
    for (const k of this.gitRequested.keys()) if (!keys.has(k)) this.gitRequested.delete(k);
    const repos = new Set(Object.values(this.git).filter(Boolean).map(g => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    // A place nobody has looked at needs its repo and its worktree; a change in
    // view (a new folder, a finished command, a machine back) needs the walk too.
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const k of due) this.gitWalk.add(k);
    const walked = (k) => { due.add(k); this.gitWalk.add(k); };
    const branches = new Map(sp.filter(s => keys.has(at[s.id])).map(s => [at[s.id], s.branch ?? null]));
    for (const [key, branch] of branches) {
      if (this.gitBranches.has(key) && this.gitBranches.get(key) !== branch) this.forceGitRefs(key, now);
    }
    this.gitBranches = branches;
    for (const key of this.gitForced) due.add(key);
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) walked(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach(walked);
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) walked(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      // The fallback looks are for what moves without this machine seeing it (a
      // commit elsewhere, an editor saving): the refs alone every half minute,
      // the worktree's work less often.
      for (const k of keys) {
        if (!(this.git[k] || this.unsure.has(k)) || this.folded.has(JSON.parse(k)[0])) continue;
        const record = latestGitRecord(k, this.gitRecord(k));
        if (record?.unsure && now - record.at < GIT_REFS_EVERY) continue;
        const refsAt = Math.max(record?.refsAt ?? 0, this.checked[k] ?? 0);
        if (now - (record?.dirtyAt ?? this.checked[k] ?? 0) > GIT_DIRTY_EVERY) walked(k);
        else if (now - refsAt > GIT_REFS_EVERY) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    this.refreshFinishedCounts(cx);
    cx.spawn(async cx => {
      try {
        const result = await hc(["machine", "ls", "--json"]);
        if (result.code === 0) this.machines = (JSON.parse(result.stdout).machines ?? []).filter(m => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  refreshFinishedCounts(cx) {
    if (this.refreshingFinishedCounts) return;
    this.refreshingFinishedCounts = true;
    this.finishedCountsDirty = false;
    const revision = this.finishedRevision;
    cx.spawn(async cx => {
      try {
        const result = await hc(["ls", "--all", "--json"]);
        if (result.code !== 0 || revision !== this.finishedRevision) return;
        const counts = new Map();
        for (const term of JSON.parse(result.stdout).terminals) {
          if (term.state !== "finished") continue;
          const machine = machineOf(term.address);
          counts.set(machine, (counts.get(machine) ?? 0) + 1);
        }
        this.finishedCounts = counts;
        cx.notify();
      } catch {} finally {
        this.refreshingFinishedCounts = false;
      }
    });
  }

  // One look per connected machine. A slow machine skips its turn without
  // holding up the others, and only a complete section replaces old data.
  refreshSample(cx) {
    const usage = enabled(SHOW_USAGE), ports = enabled(SHOW_PORTS);
    if (!usage && !ports) return;
    const script = sampleScript(usage, ports);
    const now = Date.now();
    for (const m of [null, ...this.machines.filter(k => k.state === "connected").map(k => k.name)]) {
      const key = m ?? "";
      if (this.sampling.has(key) || now - (this.sampleAt[key] ?? 0) < SAMPLE_EVERY) continue;
      this.sampleAt[key] = now;
      this.sampling.add(key);
      cx.spawn(async (cx) => {
        let stats, listeners;
        try {
          const r = await exec("sh", ["-c", script], { on: m, timeout: 15000 });
          if (r.code === 0) ({ stats, listeners } = sampleSections(r.stdout, usage, ports));
        } catch {} finally {
          this.sampling.delete(key);
        }
        if (stats != null) this.takeStats(key, stats);
        else if (usage && this.stats[key]) this.stats[key].stale = true;
        if (listeners != null) this.takePorts(key, listeners);
        cx.notify();
      });
    }
  }

  takePorts(key, out) {
    this.ports[key] = parsePorts(out, key || null, spaces(), panes());
  }

  takeStats(key, out) {
    const { cpu, mem, cores, ticks } = parseStats(out, this.ticks[key]);
    if (ticks) this.ticks[key] = ticks;
    if (cpu != null) {
      const hist = (this.history[key] ??= []);
      hist.push(cpu);
      if (hist.length > HISTORY) hist.shift();
    }
    this.stats[key] = { cpu, mem, cores, stale: false, at: Date.now() };
  }

  // --- the Local machine's coffee cup -------------------------------------

  // The cup as it is now: the hold named by the pid file if it still runs, else
  // off. A reloaded mod, or a cup killed elsewhere, comes back right here.
  async syncCup(cx) {
    const pid = await readCupPid(this.cupFile);
    const held = await cupPidAlive(pid);
    this.cupPid = held ? pid : null;
    this.cup = held ? "on" : "off";
    if (!held) await removeCupPid(this.cupFile);
    cx.notify();
  }

  toggleCup(cx) {
    if (this.cup === "busy") return;
    const held = this.cup === "on";
    this.cup = "busy";
    cx.notify();
    cx.spawn(async (cx) => {
      await changeCupHold(this.cupFile, this.cupPid, held);
      await this.syncCup(cx);
    });
  }

  // A cup left on: `caffeinate` gone (killed, or quit without `-w` taking it)
  // means off, and the file goes with it.
  verifyCup(cx) {
    if (this.cup !== "on" || !this.cupPid) return;
    cx.spawn(async (cx) => {
      if (await cupPidAlive(this.cupPid)) return;
      await this.syncCup(cx);
    });
  }

  // CPU and memory shares under a machine's name, as Sheprd's host rows:
  // `CPU ▁▂▃ 12%  MEM ━━─ 61%` while the sidebar has room, small gauges
  // where it is narrower (Sheprd's compact density), the numbers always. A
  // stale reading keeps its numbers gray.
  usage(m, t, live) {
    const key = m ?? "";
    const s = live ? (this.stats[key] ?? {}) : {};
    const hist = live ? this.history[key] ?? [] : [];
    const width = sidebarPx();
    const graphs = width >= 260 ? "full" : width >= 200 ? "gauge" : "none";
    // Numbers only, and not much room for them: tuck the line in under the icon.
    const tight = graphs === "none";
    const stale = s.stale === true;
    const tone = (v, warn) => (v >= 90 ? t.ansi1 : v >= warn ? t.ansi3 : stale ? t.muted : t.foreground);
    const share = (v, warn) => div().flex_none().min_w(28).flex().justify_end()
      .text_color(stale ? t.muted : v == null ? t.dim : v >= 90 ? t.ansi1 : v >= warn ? t.ansi3 : t.foreground)
      .child(v == null ? "\u2014" : `${Math.round(v)}%`);
    const pad = HISTORY - hist.length;
    const spark = h_flex().flex_none().items_end().gap(BAR_GAP).h(GRAPH_H)
      .children(Array.from({ length: HISTORY }, (_, i) => {
        const v = i < pad ? null : hist[i - pad];
        return v == null
          ? div().w(BAR_W).h(2).rounded(1).bg(t.border)
          : div().w(BAR_W).h(Math.max(1, Math.round((v / 100) * GRAPH_H))).rounded(0.5).bg(tone(v, CPU_WARN));
      }));
    const meter = div().w(METER_W).h(6).flex_none().rounded_full().overflow_hidden().bg(t.input)
      .child(div().h_full().w(Math.round(((s.mem ?? 0) / 100) * METER_W)).rounded_full().bg(tone(s.mem ?? 0, MEM_WARN)));
    // Sheprd's compact density: a 3px gauge filling from the bottom.
    const gauge = (v, warn) => div().w(3).h(GRAPH_H).flex_none().flex().flex_col().justify_end()
      .rounded(1).overflow_hidden().bg(t.input)
      .child(div().w_full().h(Math.max(1, Math.round(((v ?? 0) / 100) * GRAPH_H))).bg(tone(v ?? 0, warn)));
    return h_flex().pl(tight ? 8 : 21).gap(tight ? 6 : 10).items_center().overflow_hidden().text_size(11).text_color(t.muted)
      .child(h_flex().flex_none().gap(5).items_center().child("CPU")
        .when(graphs === "full", el => el.child(spark))
        .when(graphs === "gauge", el => el.child(gauge(s.cpu, CPU_WARN)))
        .child(share(s.cpu, CPU_WARN)))
      .when(s.mem != null, el => el.child(h_flex().flex_none().gap(5).items_center().child("MEM")
        .when(graphs === "full", el => el.child(meter))
        .when(graphs === "gauge", el => el.child(gauge(s.mem, MEM_WARN)))
        .child(share(s.mem, MEM_WARN))));
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  clearFinished(machine, cx) {
    if (this.clearingFinished.has(machine)) return;
    this.clearingFinished.add(machine);
    cx.notify();
    cx.spawn(async cx => {
      const label = machine ?? "Local";
      try {
        const result = await hc(["ls", "--all", "--json"]);
        if (result.code !== 0) throw new Error("Could not list terminals");
        const { terminals: records, machines: peers } = JSON.parse(result.stdout);
        if (machine && !peers.some(peer => peer.name === machine && peer.state === "connected")) {
          throw new Error("Machine is disconnected");
        }
        const finished = records.filter(term => term.state === "finished" && machineOf(term.address) === machine);
        let removed = 0;
        for (const term of finished) {
          try {
            const reply = await hc(["rm", term.address, "--json"]);
            if (reply.code === 0) removed++;
          } catch { /* Continue clearing other records if one request fails. */ }
        }
        const failed = finished.length - removed;
        this.finishedRevision++;
        this.finishedCounts.set(machine, failed);
        notify({
          title: failed ? `${label}: removed ${removed}, could not remove ${failed}`
            : removed ? `${label}: removed ${removed} finished ${removed === 1 ? "terminal" : "terminals"}`
            : `${label}: no finished terminals`,
          level: failed ? "error" : "info",
        });
      } catch (error) {
        notify({ title: `${label}: ${error.message}`, level: "error" });
      } finally {
        this.clearingFinished.delete(machine);
        cx.notify();
      }
    });
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  forceGitRefs(key, now) {
    this.gitForced.add(key);
    this.gitRequested.set(key, now);
  }

  // Each place has one look in flight. A watch event or checkout during a look
  // can queue another look once it finishes.
  refreshGit(keys, cx) {
    const now = Date.now();
    for (const key of keys) {
      if (this.gitInFlight.has(key) && !this.gitForced.has(key)) continue;
      if (!this.gitRequested.has(key)) this.gitRequested.set(key, now);
      if (!this.gitInFlight.has(key)) this.pending.add(key);
    }
    if (this.refreshing || !this.pending.size) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      const results = new Map();
      try {
        const done = await Promise.allSettled(Array.from({ length: AT_ONCE }, async () => {
          while (this.pending.size) {
            const key = this.pending.values().next().value;
            this.pending.delete(key);
            this.gitInFlight.add(key);
            try { await this.check(key, cx, results); }
            finally { this.gitInFlight.delete(key); }
            if (this.gitForced.has(key) && shown()) this.pending.add(key);
            cx.notify();
          }
        }));
        // Even an unexpected failure must not release the pool while peers run.
        const failed = done.find(d => d.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        this.refreshing = false;
        writeGitStore(results);
        cx.notify();
      }
    });
  }

  // The record this panel has of a place, in the shape the shared cache keeps.
  gitRecord(key) {
    if (this.gitRecords[key]) return this.gitRecords[key];
    if (this.git[key] === undefined && !this.unsure.has(key)) return null;
    const at = this.checked[key] ?? 0;
    return { at, refsAt: at, dirtyAt: at, info: this.git[key] ?? null, unsure: this.unsure.has(key) };
  }

  // What the other panel (or an earlier run of this one) already knows about a
  // place: read into the list as it is, with no command and no write. `live`
  // limits it to the places this panel shows now.
  adoptGit(live) {
    const cache = readGitStore();
    for (const key of live) {
      const record = gitRecordOf(cache[key]);
      if (!record || record.at <= (this.checked[key] ?? 0)) continue;
      this.gitRecords[key] = record;
      this.checked[key] = record.at;
      this.git[key] = record.info;
      if (record.unsure) this.unsure.add(key);
      else this.unsure.delete(key);
    }
  }

  // One place's git, shared with the agents panel at the end of the pool pass.
  async check(key, cx, results) {
    const [on, cwd] = JSON.parse(key);
    const walk = this.gitWalk.delete(key);
    const force = this.gitForced.delete(key);
    const since = this.gitRequested.get(key);
    this.gitRequested.delete(key);
    const record = await checkGit(key, { on, cwd }, this.gitRecord(key), { walk, force, since, results });
    this.gitRecords[key] = record;
    this.checked[key] = record.at;
    this.git[key] = record.info;
    if (record?.unsure) this.unsure.add(key);
    else this.unsure.delete(key);
    const repo = record?.info?.repo;
    if (!on && repo) this.watch(JSON.parse(repo)[1], cx);
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter(k => this.git[k]?.repo === mine);
          if (!keys.length) break;
          // Something in the repository changed (a commit, a checkout, a staged
          // file): read the refs now, not when the fallback comes round.
          const now = Date.now();
          for (const key of keys) {
            this.forceGitRefs(key, now);
            this.gitWalk.delete(key);
          }
          if (shown()) this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    // Herdr's own order: this machine first, then machines by name. The panel
    // regroups them in the order dragged here (see `machineGroups`); a space cannot
    // move into another machine's block, so that order stays local to the mod.
    const showUnread = w => this.unreadSpaces?.has(w.id) && (!w.status || w.status === "idle")
      ? { ...w, status: "unread" } : w;
    const list = sp.map((w, i) => ({ w: showUnread(w), i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (!checking() && (this.ordering?.key !== key || this.orderingDue(Date.now()))) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // Every machine the panel lists: this computer, then the others as the
  // catalog saves them.
  machineNames() {
    const remote = [...new Set([...spaces().map(s => s.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    return [null, ...remote];
  }

  // `names` in the user's order: the machines they arranged first, the rest as
  // `names` lists them, so a machine saved later lands after the arranged ones
  // instead of at the top. Sheprd's device order works the same way.
  arranged(names) {
    const rank = (m) => { const i = this.order.indexOf(m); return i < 0 ? this.order.length : i; };
    return names.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  }

  // Drops machine `from` where `to` was, the way a space row follows another:
  // dragged down it lands after `to`, dragged up before it. Remembers the whole
  // visible order. This computer moves too: it leads only until it is dragged away.
  moveMachine(from, to, names) {
    const a = names.indexOf(from), b = names.indexOf(to);
    if (a === -1 || b === -1 || a === b) return;
    const next = names.filter((m) => m !== from);
    next.splice(b, 0, from);
    this.order = next;
    localStorage.setItem("machines.order", JSON.stringify(next));
  }

  machineGroups(collapsed, taskMachines = []) {
    const rows = this.ordered();
    const names = [...new Set([...this.machineNames(), ...taskMachines])];
    return this.arranged(names).map((m) => {
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const visible = !folded && (collapsed || !rebuilt);
      return { m, machine, repair, rebuilt, folded, rows: visible ? rows.filter(r => (r.w.machine ?? null) === m) : [] };
    });
  }

  // Shows the space at `n` (1-based) in the same order as the drawn rows.
  // `space.select` by index uses the daemon's order, so select by id instead.
  pick(n) {
    const row = this.machineGroups(narrow()).flatMap(group => group.rows)[n - 1];
    if (row) run("space.select", { id: row.w.id });
  }

  // The rows, under a header per machine. The header stays for this computer
  // alone, so a single-machine panel keeps showing its load.
  grouped(t, collapsed) {
    const all = terminals();
    const live = new Set(all.filter(term => term.state === "live").map(term => term.address));
    if (this.liveTerminalAddresses && [...this.liveTerminalAddresses].some(address => !live.has(address))) {
      this.finishedCountsDirty = true;
    }
    this.liveTerminalAddresses = live;
    const focus = focused();
    const shown = focus?.shown;
    const statuses = unreadStatuses(viewedTerminalStatuses(all, shown), shown ?? focus?.terminal ?? focus?.agent ?? null);
    // A space with an agent marked unread says so only when nothing else in it is
    // going on: blocked > done > working > unread > idle.
    const unread = new Set(statuses.filter(term => term.status === "unread").map(term => term.address));
    const spaceOfTab = new Map(spaces().flatMap(s => (s.tabs ?? []).map(tab => [tab.id, s.id])));
    this.unreadSpaces = new Set(panes().filter(p => unread.has(p.terminal)).map(p => spaceOfTab.get(p.tab)));
    const tasks = collapsed ? null : terminalGroups(spaces(), panes(), statuses);
    const groups = this.machineGroups(collapsed, tasks?.byMachine.keys());
    this.activeAt = -1;
    let before = 0; // direct children before this machine, including guidance rows
    let number = 0; // one-based space number in the rail
    // A space draws as its row and, under it, the ports its servers listen on;
    // both sit inside one selection box (see `spaceBox`).
    const draw = (r) => {
      if (collapsed) return this.compact(r, t, ++number);
      const terms = tasks.bySpace.get(r.w.id);
      const id = `space-${r.w.id}`;
      const box = this.spaceBox(r, t, terms?.length ?? 0);
      if (!terms?.length) return box;
      return v_flex().flex_none().child(box)
        .child(v_flex().id(`terminal-section-${id}`).ml(SPACE_MARGIN).mr(SCROLL_GUTTER).flex_none()
          .children(this.terminalRows(id, terms, t, shown)));
    };
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : SPACE_MARGIN).mr(collapsed ? 0 : SCROLL_GUTTER).my(1).px(collapsed ? 0 : SPACE_PADDING).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    const machineNames = groups.map(group => group.m);
    return groups.flatMap(({ m, machine, repair, rebuilt, folded, rows }) => {
      const connected = !m || machine?.state === "connected";
      const statusColor = connected ? t.ansi2 : machine?.state === "connecting" ? t.ansi3 : t.muted;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      // Elements are single-use: the rail and the wide head each build their own.
      const icon = () => svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.muted);
      const badge = () => div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(statusColor);
      const warning = () => div().id(`machine-logout-${m}`).flex_none().text_color(t.blocked)
        .tooltip("Agents stop when you disconnect. Click for the fix.")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); })
        .child("⚠");
      const toggle = (cx) => {
        if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
        folded ? this.folded.delete(m) : this.folded.add(m);
        this.machineFoldChanged = true;
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      };
      // The Local header's cup, as Sheprd's status bar: a full cup holds this
      // Mac awake with `caffeinate`, an empty one lets it sleep. Only this
      // computer has one; a remote machine's hold would need that machine.
      const cup = () => div().id("machine-cup-local").flex_none().size(18).flex().items_center().justify_center()
        .rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(this.cup === "on" ? "Keeping this Mac awake \u00b7 click to let it sleep"
          : this.cup === "busy" ? "Changing the keep-awake hold\u2026"
          : "Keep this Mac awake (caffeinate)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleCup(cx); })
        .child(svg(`mods/sidebar-spaces/${this.cup === "on" ? "coffee-full" : "coffee"}.svg`)
          .size(13).text_color(this.cup === "on" ? t.ansi3 : this.cup === "busy" ? t.dim : t.muted));
      const count = this.finishedCounts.get(m) ?? 0;
      const busy = this.clearingFinished.has(m);
      const trash = () => h_flex().id(`machine-clear-${m ?? "local"}`).h(18).px(3).gap(3).items_center().flex_none()
        .rounded(4).text_size(11).text_color(count ? t.muted : t.dim).cursor_pointer()
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`Remove ${count} finished ${count === 1 ? "terminal record" : "terminal records"} and saved output on this machine`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.clearFinished(m, cx); })
        .child(svg(`mods/${busy ? "workspace-chrome/spinner" : "sidebar-spaces/trash"}.svg`).size(13).flex_none()
          .when(busy, el => el.spin(900)))
        .child(String(count));
      const row1 = h_flex().pr(SPACE_PADDING).gap(7).items_center()
        .child(icon())
        .child(div().flex_1().min_w_0().flex().items_center().gap(6)
          .child(div().min_w_0().truncate().child(m ?? "Local"))
          .when(m === null && this.cupHere && (enabled(SHOW_CUP) || this.cup !== "off"), el => el.child(cup()))
          .when(connected && !rebuilt, el => el.child(trash())))
        .when(machine?.keeps_running_after_logout === false, el => el.child(warning()))
        .when(!connected && !rebuilt && !login, el => el.child(div().flex_none()
          .when(machine?.state === "connecting", label => label.text_color(statusColor))
          .child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
          .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
          .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
            .hover(s => s.text_color(t.foreground))
            .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
            .child(repair?.busy ? "Connecting…" : "Connect"))))
        .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).w(16).h(18).flex_none().flex().items_center().justify_center()
          .rounded(4).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("New space there")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); })
          .child(svg("mods/workspace-chrome/plus.svg").size(12).flex_none())))
        .child(div().size(6).rounded(3).flex_none().bg(statusColor))
        .child(div().w(SPACE_STATUS_WIDTH).flex_none().flex().justify_center()
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const from = machineNames.indexOf(this.machinePress?.m);
      const dragging = this.machinePress?.dragging;
      const drop = () => div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(from < machineNames.indexOf(m), (el) => el.bottom(0))
        .when(from > machineNames.indexOf(m), (el) => el.top(0));
      const press = (e, cx) => {
        this.machinePress = { m, position: e.position, dragging: false };
        this.machineOver = { m };
        cx.notify();
      };
      const over = (e, cx) => {
        if (!this.machinePress) return;
        const started = startDrag(this.machinePress, e.position);
        if (!started && this.machineOver?.m === m) return;
        this.machineOver = { m };
        cx.notify();
      };
      const release = (e, cx) => {
        startDrag(this.machinePress, e.position);
        const start = this.machinePress;
        this.machinePress = null;
        this.machineOver = null;
        if (start?.dragging && start.m !== m) this.moveMachine(start.m, m, machineNames);
        else if (start && !start.dragging && start.m === m) toggle(cx);
        cx.notify();
      };
      const drag = (el) => el[dragging || this.spacePress?.dragging ? "cursor_grabbing" : "cursor_default"]()
        .on_mouse_down("left", press)
        .on_mouse_move(over)
        .on_mouse_up("left", release);
      const head = collapsed
        ? drag(v_flex().id(`machine-${m ?? "local"}`).relative().flex_none().mt(4).w(RAIL_CELL).h(30).items_center().justify_center().rounded(4).bg(t.surface)
          .tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "Local")
          .hover(s => s.bg(t.hover))
          .when(dragging && this.machinePress.m === m, (el) => el.opacity(0.5))
          .when(dragging && this.machinePress.m !== m && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(div().relative().flex_none().child(icon()).when(Boolean(m), el => el.child(badge()))
            .when(m === null && this.cup === "on", el => el.child(div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.surface).bg(t.ansi3))))
          .when(machine?.keeps_running_after_logout === false, el => el.child(warning())))
        : drag(v_flex().id(`machine-${m ?? "local"}`).relative().flex_none().mt(4).mb(1).pl(collapsed ? 0 : 18).pr(collapsed ? 0 : SCROLL_GUTTER).pt(5).pb(6).bg(t.surface)
          .text_size(13.5).font_medium().text_color(connected ? t.foreground : t.muted)
          .hover(s => s.bg(t.hover))
          .when(dragging && this.machinePress.m === m, (el) => el.opacity(0.5))
          .when(dragging && this.machinePress.m !== m && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(row1)
          .when(enabled(SHOW_USAGE), el => el.child(this.usage(m, t, connected))));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : SPACE_MARGIN).mr(collapsed ? 0 : SCROLL_GUTTER).my(1).px(collapsed ? 0 : SPACE_PADDING).gap(7).items_center().rounded(4)
        .text_size(12).text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(4).justify_center().tooltip(`New space on ${m ?? "Local"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before++; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().pl(20).pr(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : rows.length ? rows.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const unattached = tasks?.byMachine.get(m);
      if (!folded && unattached?.length) {
        items.push(this.unattachedSection(`machine-${m ?? "local"}`, unattached, t, shown));
      }
      const first = rows.findIndex(r => r.w.active);
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  unattachedSection(id, terms, t, shown) {
    const open = this.terminalsOpen(id);
    return v_flex().id(`terminal-section-${id}`).ml(SPACE_MARGIN).mr(SCROLL_GUTTER).flex_none()
      .child(h_flex().id(`terminals-${id}`).h(rowHeight({ tree: false })).my(1).px(SPACE_PADDING)
        .gap(SPACE_GAP).items_center().rounded(4).flex_none()
        .text_size(13).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleTerminals(id, cx))
        .when(statusAtStart(), el => el.child(statusCell(null, t)))
        .child(h_flex().w(SPACE_ICON_WIDTH).flex_none().items_center().justify_center()
          .child(svg("mods/sidebar-spaces/unplug.svg").size(FOLDER_WIDTH).text_color(t.dim)))
        .child(open ? "Unattached" : `Unattached ${terms.length}`)
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.muted)))
      .children(this.terminalRows(id, terms, t, shown));
  }

  terminalsOpen(id) {
    return this.openTerminals.get(id) ?? enabled(EXPAND_TERMINALS);
  }

  toggleTerminals(id, cx) {
    this.openTerminals.set(id, !this.terminalsOpen(id));
    cx.notify();
  }

  terminalRows(id, terms, t, shown) {
    if (!this.terminalsOpen(id)) return [];
    const leading = statusAtStart();
    return terminalTree(terms).map(({ term, lines }) => {
      const program = term.foreground?.name || term.program?.name || term.argv?.[0]?.split(/[\\/]/).pop();
      const title = term.name || term.template || program || term.address;
      const iconPath = term.program?.icon;
      const icon = iconPath && !term.program.tint
        ? image(iconPath).w(14).h(14).flex_none()
        : svg(iconPath || "mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.foreground);
      const status = term.status === "error" ? "blocked" : term.status;
      return h_flex().id(`task-${term.address}`).h(26).my(1).pl(leading ? SPACE_PADDING : SPACE_TREE_INSET).pr(SPACE_PADDING)
        .items_center().rounded(4).text_size(12).text_color(t.muted)
        .when(shown === term.address, el => el.bg(t.ansi5 + "33").text_color(t.foreground))
        .when(this.hoveredChild === term.address, el => el.bg(t.hover).text_color(t.foreground))
        .on_mouse_move((_e, cx) => {
          if (this.hoveredChild === term.address) return;
          this.hoveredChild = term.address;
          cx.notify();
        })
        .on_hover((on, cx) => {
          if (on || this.hoveredChild !== term.address) return;
          this.hoveredChild = null;
          cx.notify();
        })
        .on_click((_e, cx) => {
          this.hoveredChild = null;
          cx.notify();
          run("terminal.peek", { terminal: term.address });
          viewedTerminalStatuses(terminals(), term.address);
        })
        .when(leading, el => el.child(statusCell(status, t).mr(SPACE_TREE_INSET - SPACE_PADDING + SPACE_GAP)))
        .children(treeLines(lines, t))
        .child(h_flex().ml(4).flex_1().min_w(0).gap(8).items_center()
          .child(icon)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title)))
        .child(div().ml(4).size(18).flex_none()
          .when(this.hoveredChild === term.address, el => el.child(div().id(`keep-child-${term.address}`)
            .size_full().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).cursor_default().tooltip("Keep as tab")
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.hoveredChild = null;
              keepTerminal(term.address);
              cx.notify();
            })
            .child(svg("mods/sidebar-spaces/keep.svg").size(12)))))
        .child(div().ml(4).size(18).flex_none()
          .when(this.hoveredChild === term.address, el => el.child(div().id(`close-child-${term.address}`)
            .size_full().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).tooltip("Close terminal")
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.hoveredChild = null;
              run("terminal.kill", { terminal: term.address });
              cx.notify();
            })
            .child(svg("mods/workspace-chrome/x.svg").size(12)))))
        .when(!leading, el => el.child(statusCell(status, t).ml(SPACE_GAP)));
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  // One line of segments sharing `room`: measured against the glyph estimate,
  // each segment keeps one glyph and grows in turn. Segments past the space go,
  // lowest priority first, so the name stays and the tail gives way.
  // `fixed` parts keep their own width and color at the end of the line (ahead
  // and behind counts); the rest share the room by budget.
  nameLine(parts, room, fold) {
    const MIN_NAME = 8;
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
        ...kept.map((p, i) => {
          const text = div().min_w(0).truncate().text_size(p.size ?? 11.5).text_color(p.color)
            .child(i === 0 ? p.text : fit(p.text, widths[i]));
          return i === 0
            ? h_flex().flex_1().min_w(0).gap(3).items_center().child(text)
              .when(Boolean(fold), el => el.child(fold))
            : text.flex_none();
        }),
        ...fixed.map((p) => div().flex_none().text_size(p.size ?? 11.5).text_color(p.color).child(p.text)),
      ]);
  }

  row(row, t, terminalCount) {
    const { w, g, tree } = row;
    const px = sidebarPx();
    const id = `space-${w.id}`;
    const leading = statusAtStart();
    const open = this.terminalsOpen(id);
    const fold = terminalCount > 0 ? h_flex().id(`terminals-${id}`).h(18).px(3).gap(3)
      .flex_none().items_center().rounded(4).cursor_pointer().text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.cancelDrag(cx);
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleTerminals(id, cx);
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!open, el => el.child(String(terminalCount))) : null;
    const foldWidth = fold ? 20 + (open ? 0 : 3 + String(terminalCount).length * 7) : 0;
    const rowChrome = SPACE_MARGIN + SCROLL_GUTTER + SPACE_PADDING * 2 + SPACE_ICON_WIDTH + SPACE_STATUS_WIDTH + SPACE_GAP * 2;
    const room = Math.max(0, px - rowChrome - foldWidth);
    const remote = g?.upstream?.includes("/") ? `\u25b8 ${g.upstream.slice(0, g.upstream.indexOf("/"))}` : "";
    // The tail reads as one segment, so the name keeps the larger share; the
    // counts keep their own colors, green ahead and red behind as starship's.
    const tail = enabled(SHOW_GIT_BRANCH) ? [g?.branch, remote].filter(Boolean).join(" ") : "";
    const showChanges = enabled(SHOW_GIT_CHANGES);
    const showSync = enabled(SHOW_GIT_SYNC);
    const lines = this.nameLine([
      { text: w.name, color: t.foreground, size: 13 },
      ...(tail ? [{ text: tail, color: t.dim }] : []),
      ...(showChanges && g?.dirty > 0 ? [{ text: `*${g.dirty}`, color: t.ansi3, fixed: true }] : []),
      ...(showChanges && g?.conflicts > 0 ? [{ text: `\u2718${g.conflicts}`, color: t.ansi1, fixed: true }] : []),
      ...(showSync && g?.ahead > 0 ? [{ text: `\u2191${g.ahead}`, color: t.ansi2, fixed: true }] : []),
      ...(showSync && g?.behind > 0 ? [{ text: `\u2193${g.behind}`, color: t.ansi1, fixed: true }] : []),
    ], room, fold);
    return this.spaceRowDrag(v_flex()
      .relative()
      .id(id)
      .px(SPACE_PADDING)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center(), row, t)
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .w_full()
          .min_w(0)
          .gap(SPACE_GAP)
          .items_center()
          .when(leading, el => el.child(statusCell(w.status, t)))
          .child(h_flex().w(SPACE_ICON_WIDTH).flex_none().items_center().justify_center()
            .child(svg(`mods/workspace-chrome/${tree ? "branch" : "folder"}.svg`).size(tree ? BRANCH_WIDTH : FOLDER_WIDTH).text_color(t.dim)))
          .child(lines ?? div().flex_1())
          .when(!leading, el => el.child(statusCell(w.status, t))),
      );
  }

  // A space's row and the ports under it share one selection box: selecting or
  // hovering a space highlights the ports with it, not only its first line.
  spaceBox(row, t, terminalCount = 0) {
    const { w } = row;
    const on = w.active;
    const has = enabled(SHOW_PORTS) && Boolean(this.ports[w.machine ?? ""]?.[w.id]?.length);
    return v_flex()
      .id(`space-box-${w.id}`)
      .relative()
      .flex_none()
      .ml(SPACE_MARGIN)
      .mr(SCROLL_GUTTER)
      .my(1)
      .rounded(4)
      .when(on, (el) => el.bg(t.ansi5 + "33"))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.spacePress?.dragging && this.spacePress.id === w.id, (el) => el.opacity(0.5))
      .child(this.row(row, t, terminalCount))
      .when(has, el => el.child(this.portRow(w, t)))
      .when(has && terminalCount > 0 && this.terminalsOpen(`space-${w.id}`), el => el.child(
        div().id(`space-port-tree-${w.id}`).absolute().left(SPACE_TREE_INSET + statusOffset()).bottom(-1)
          .w(TREE_STROKE_WIDTH).h(PORT_ROW_HEIGHT + 1).bg(t.dim),
      ));
  }

  // A space's listening ports under its row, `|` between them: each opens
  // where that server answers. A port on another machine has no tunnel from
  // this side, so clicking it copies `host:port` instead of opening a page
  // that would not load.
  portRow(w, t) {
    const ports = this.ports[w.machine ?? ""]?.[w.id] ?? [];
    if (!ports.length) return null;
    const local = !w.machine;
    const host = local
      ? "localhost"
      : hostOf(this.machines.find((m) => m.name === w.machine)?.target) ?? w.machine;
    return h_flex()
      .id(`space-ports-${w.id}`)
      .flex_none()
      .w_full()
      .h(PORT_ROW_HEIGHT)
      .pr(SPACE_PADDING)
      .pl(SPACE_PADDING + SPACE_ICON_WIDTH + SPACE_GAP + statusOffset())
      .gap(5)
      .items_center()
      .overflow_hidden()
      .text_size(10.5)
      // The row under a space's ports selects that space when clicked on its
      // air; a port itself stops the press so it only opens (or copies) and
      // leaves the current space alone.
      .on_mouse_down("left", (e, cx) => this.pressSpace(w, e.position, cx))
      .on_mouse_up("left", (e, cx) => {
        const press = this.spacePress;
        startDrag(press, e.position);
        this.cancelDrag(cx);
        if (press?.id === w.id && !press.dragging) run("space.select", { id: w.id });
      })
      .on_mouse_down("right", () => this.menu(w))
      .children(ports.flatMap((p, i) => [
        ...(i ? [div().flex_none().text_color(t.dim).child("|")] : []),
        div()
          .flex_none()
          .cursor_pointer()
          .text_color(t.ansi4)
          .hover(s => s.text_color(t.foreground).underline())
          .tooltip(local ? `${p.address} \u00b7 opens in a browser` : `${host}:${p.number} \u00b7 click to copy`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_up("left", (_e, cx) => {
            cx.stop_propagation();
            this.cancelDrag(cx);
          })
          .on_click((_e, cx) => {
            if (local) cx.open_url(`http://localhost:${p.number}/`);
            else {
              cx.write_to_clipboard(`${host}:${p.number}`);
              notify({ title: `${host}:${p.number}`, level: "info" });
            }
          })
          .child(`:${p.number}`),
      ]));
  }

  compact(row, t, number) {
    const { w } = row;
    const leading = statusAtStart();
    return railCell(this.spaceRowDrag(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(4)
      .justify_center()
      .items_center(), row, t)
      .when(w.active, (el) => el.bg(t.ansi5 + "33"))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.spacePress?.dragging && this.spacePress.id === w.id, (el) => el.opacity(0.5))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(number)))
      .child(div().absolute().when(leading, el => el.left(5)).when(!leading, el => el.right(5))
        .text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const view = props();
    if (view?.sidebarSettings) return settingsDialog(t, view.overlay);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ps = panes();
    this.adoptGit(new Set(sp.map(s => where(s, ps))));
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed && !checking()) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    const active = sp.find(p => p.active)?.id;
    // Folding can move the active row without changing the selected space.
    const reveal = active !== this.revealed || (!this.machineFoldChanged && this.activeAt !== this.revealedAt);
    this.machineFoldChanged = false;
    this.revealed = active;
    this.revealedAt = this.activeAt;
    if (reveal && this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(h_flex().items_center()
          .when(!collapsed, el => el.child(settingsButton(t, openSettings)))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover))
            .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(this.followDrag(v_flex()).flex_1().min_h(0).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        .when(Boolean(this.machinePress?.dragging || this.spacePress?.dragging), el => el.cursor_grabbing())
        .on_size_change((size, cx) => {
          // Herdr can report the same viewport size again after a list update.
          if (size.width === this.scrollSize?.width && size.height === this.scrollSize?.height) return;
          this.scrollSize = size;
          if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => this.cancelDrag(cx))
        .children(list));
  }

  pressSpace(w, position, cx) {
    this.spacePress = { id: w.id, machine: w.machine ?? null, position, dragging: false };
    this.spaceOver = w.id;
    cx.notify();
  }

  spaceRowDrag(el, { w, i }, t) {
    const press = this.spacePress;
    const fromIndex = press?.dragging ? spaces().findIndex(s => s.id === press.id) : -1;
    return el[press?.dragging || this.machinePress?.dragging ? "cursor_grabbing" : "cursor_default"]()
      .when(fromIndex !== -1 && this.spaceOver === w.id && press.id !== w.id, row => row.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", (e, cx) => this.pressSpace(w, e.position, cx))
      .on_mouse_move((e, cx) => {
        const press = this.spacePress;
        if (!press) return;
        const started = startDrag(press, e.position);
        const over = press.machine === (w.machine ?? null) ? w.id : null;
        if (!started && this.spaceOver === over) return;
        this.spaceOver = over;
        cx.notify();
      })
      .on_mouse_up("left", (e, cx) => {
        const press = this.spacePress;
        if (!press) return;
        startDrag(press, e.position);
        this.cancelDrag(cx);
        if (!press.dragging) {
          if (press.id === w.id) run("space.select", { id: w.id });
          return;
        }
        if (press.id === w.id || press.machine !== (w.machine ?? null)) return;
        const entries = spaces();
        const index = entries.findIndex(s => s.id === w.id);
        if (index !== -1 && entries.some(s => s.id === press.id && (s.machine ?? null) === press.machine)) {
          run("space.move", { id: press.id, index: index + 1 });
        }
      });
  }

  // A drag let go outside the list (over a terminal, or outside the window)
  // ends without a drop instead of waiting for the pointer to come back. Herdr
  // 0.1.18+ reports releases and moves anywhere in the window; older Herdr
  // keeps the list's own release.
  // Only registered while a press is held, so ordinary pointer moves cost nothing.
  followDrag(el) {
    if (!this.spacePress && !this.machinePress) return el;
    if (typeof el.on_window_mouse_up !== "function" || typeof el.on_window_mouse_move !== "function") return el;
    const outside = (e) => {
      const b = e.bounds, p = e.position;
      return Boolean(b && p) && (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height);
    };
    return el
      .on_window_mouse_up("left", (e, cx) => { if (outside(e)) this.cancelDrag(cx); })
      .on_window_mouse_move((e, cx) => {
        if (!this.spacePress && !this.machinePress) return;
        // No left button on a move: it was released outside the window.
        if (e.pressed_button !== "left") { this.cancelDrag(cx); return; }
        const started = startDrag(this.spacePress ?? this.machinePress, e.position);
        if (outside(e) && (this.spaceOver !== null || this.machineOver)) {
          this.spaceOver = null;
          this.machineOver = null;
          cx.notify();
        } else if (started) cx.notify();
      });
  }

  cancelDrag(cx) {
    if (!this.spacePress && !this.machinePress) return;
    this.spacePress = null;
    this.spaceOver = null;
    this.machinePress = null;
    this.machineOver = null;
    cx.notify();
  }
}
