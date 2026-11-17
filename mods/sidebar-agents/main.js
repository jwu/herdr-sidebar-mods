// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, checking, setBadge } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const sidebarPx = () => find(layout(), "sidebar")?.size?.px ?? Infinity;
const narrow = () => sidebarPx() < 160;
// A row shares one line between its machine and its git tail: every segment
// keeps one glyph, then they grow in turn until the line is full, so neither
// crowds the other out (sheprd budgets its labels the same way).
const GLYPH = 8;
const fit = (text, glyphs) => (text.length <= glyphs ? text : `${text.slice(0, Math.max(0, glyphs - 1))}\u2026`);
// The tail is cut to its budget and then sized by its own text, so it ends at
// the row's right edge instead of at the end of a wider measured cell.
const SEG_GAP = 6;
// How far the bar's lane reaches in from the right edge (it is 6pt wide, drawn
// 4.5pt in): rows stop exactly where it starts, so nothing sits under it and
// nothing leaves a visible gap either.
const SCROLL_GUTTER = 11;
function segmentBudgets(lengths, available) {
  const budgets = lengths.map((n) => (n > 0 ? 1 : 0));
  let left = available - budgets.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let grew = false;
    for (let i = 0; i < budgets.length; i++) {
      if (budgets[i] > 0 && budgets[i] < lengths[i]) {
        budgets[i]++;
        left--;
        grew = true;
        if (left === 0) break;
      }
    }
    if (!grew) break;
  }
  return budgets;
}

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Keep opening brackets/quotes in real titles, but drop Codex's status prefix.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

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
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The folder an agent works in, by its last path segment (a Windows path too).
const base = (path) => (path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// --- shared git cache: keep this block identical in both sidebar mods ---
// The Spaces and Agents panels show the same places, so they keep one answer per
// place in shared state, and one of them looks at a place while the other reads
// what it found. A place is (machine, live folder), and the machine stays in the
// key, so two machines' /repo never mix. A look either walks the worktree for
// changed files or only reads the refs: on a big repository the walk is the
// expensive part, and a folder watch or a finished command already says the refs
// may have moved. Entries nobody looked at for a while go, and the store is
// bounded, so it cannot grow with the window's history.
const GIT_CACHE = "sidebar.git.v1";
const GIT_OWNER = Math.random().toString(36).slice(2); // this copy, not the other panel
const GIT_REFS_EVERY = 30000; // how stale branch, upstream and ahead/behind may get
const GIT_DIRTY_EVERY = 60000; // how stale the worktree's changed files may get
const GIT_STALE = 900000; // a place not looked at for a quarter of an hour is dropped
const GIT_MAX = 64; // places kept in shared state
const GIT_TIMEOUT = 20000; // one look at a place, then ask again later
const GIT_LEASE = GIT_TIMEOUT * 2 + 5000; // both sequential exec phases can take their full timeout

// Runs finished, not returned as they finish: a look is not over while one of
// its runs still holds an exec slot, and a failure waits for its peers.
async function allSettledValues(...runs) {
  const done = await Promise.allSettled(runs);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// The store as read: a damaged or absent value is an empty one.
function readGitStore() {
  const store = shared(GIT_CACHE);
  const part = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { places: part(store?.places), leases: part(store?.leases) };
}

// One place's record, if it is one this panel can use: another copy's damaged
// write is not this panel's answer.
function gitRecordOf(r) {
  if (!r || typeof r !== "object" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (Date.now() - r.at > GIT_STALE) return null;
  if (r.info !== null) {
    const g = r.info;
    if (!g || typeof g !== "object" || Array.isArray(g) || typeof g.name !== "string"
      || (g.branch !== null && typeof g.branch !== "string")
      || (g.upstream !== null && typeof g.upstream !== "string")
      || !["ahead", "behind", "dirty", "conflicts"].every(k => Number.isFinite(g[k]) && g[k] >= 0)) return null;
    try {
      const repo = JSON.parse(g.repo);
      if (!Array.isArray(repo) || repo.length !== 2 || (repo[0] !== null && typeof repo[0] !== "string") || typeof repo[1] !== "string") return null;
    } catch { return null; }
  }
  return {
    at: r.at,
    refsAt: Number.isFinite(r.refsAt) ? r.refsAt : 0,
    dirtyAt: Number.isFinite(r.dirtyAt) ? r.dirtyAt : 0,
    info: r.info ?? null,
    unsure: r.unsure === true,
  };
}

function readGitRecord(key) {
  return gitRecordOf(readGitStore().places[key]);
}

// Writes the store: places nobody looked at for a while and leases left behind
// go. A check (`herdr-app check`) never writes.
function writeGitStore(places, leases) {
  if (checking()) return;
  const now = Date.now();
  const kept = {};
  for (const [k, r] of Object.entries(places)) {
    if (!r || typeof r !== "object" || !Number.isFinite(r.at) || now - r.at > GIT_STALE) continue;
    kept[k] = r;
  }
  const newest = Object.entries(kept).sort((a, b) => b[1].at - a[1].at).slice(0, GIT_MAX);
  const held = {};
  for (const [k, l] of Object.entries(leases)) {
    if (!l || typeof l !== "object" || !Number.isFinite(l.at) || now - l.at >= GIT_LEASE) continue;
    held[k] = l;
  }
  setShared(GIT_CACHE, { places: Object.fromEntries(newest), leases: held });
}

// One place's answer, for the other panel to read; it also gives up this copy's
// claim on the place.
function publishGit(key, record) {
  if (checking()) return record;
  const { places, leases } = readGitStore();
  record = { ...record, at: Date.now() };
  places[key] = record;
  delete leases[key];
  writeGitStore(places, leases);
  return record;
}

// Claims a place for the look about to run, so the other panel reads its answer
// instead of running Git again. A claim older than a look is stale (that copy
// reloaded or died), so it does not block.
function claimGit(key) {
  if (checking()) return true;
  const { places, leases } = readGitStore();
  const held = leases[key];
  if (held && held.owner !== GIT_OWNER && Date.now() - (Number(held.at) || 0) < GIT_LEASE) return false;
  leases[key] = { owner: GIT_OWNER, at: Date.now() };
  writeGitStore(places, leases);
  return true;
}

// The repo's own name: its .git folder names it, and a worktree's top differs.
function gitRepoName(repo) {
  const last = (path) => path.replace(/\/+$/, "").split("/").pop();
  return repo.endsWith("/.git") ? last(repo.slice(0, -5)) : last(repo).replace(/\.git$/, "");
}

// A `status --porcelain=v2 --branch` answer: branch, upstream, ahead/behind and
// the worktree's work — `1`/`2` changed or renamed, `?` untracked, `u` a conflict.
function gitBranchInfo(stdout) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0 };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) info.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      info.ahead = Math.abs(parseInt(a, 10)) || 0;
      info.behind = Math.abs(parseInt(b, 10)) || 0;
    } else if (line.startsWith("u ")) { info.dirty++; info.conflicts++; }
    else if (/^[12?] /.test(line)) info.dirty++;
  }
  if (info.branch === "(detached)") info.branch = null;
  return info;
}

// What Git answers when there is nothing unusual to report: a detached or unborn
// HEAD, a branch without an upstream. Anything else (ssh, a folder gone) is a
// look Git did not make, and the panel keeps what it showed.
const GIT_NO_REF = /not a symbolic ref|does not point to a branch|not a git repository/i;
const GIT_NO_UPSTREAM = /no upstream configured|no such branch|does not point to a branch|ambiguous argument|unknown revision|not a git repository/i;
const gitNoRepo = (r) => r.code !== 0 && /not a git repository/i.test(r.stderr ?? "");
const gitUnanswered = (r, quiet) => r.code !== 0 && !quiet.test(r.stderr ?? "")
  && !(quiet === GIT_NO_REF && r.code === 1 && !(r.stderr ?? "").trim());

// One place's git answer. `prev` is the record this panel already has; `walk`
// asks for the worktree's changed files too, `force` reads the refs even when
// they were read a moment ago (a folder watch or a finished command). `at`,
// `refsAt` and `dirtyAt` say when each part was read; `unsure` marks an answer
// Git would not give, so a panel keeps what it showed and asks again.
async function checkGit(key, place, prev, { walk = false, force = false } = {}) {
  const on = place.on ?? null;
  const opts = { cwd: place.cwd, on, timeout: GIT_TIMEOUT };
  const info = prev?.info ?? null;
  const asked = Number(prev?.at) || 0;
  const refsAt = Number(prev?.refsAt) || 0;
  const dirtyAt = Number(prev?.dirtyAt) || 0;
  const now = Date.now();
  // Another panel answered while this place waited its turn: that is the answer.
  const peer = readGitRecord(key);
  if (peer && peer.at > asked && (!walk || peer.dirtyAt > dirtyAt)) return peer;
  const full = walk || !info;
  // The refs alone, and only when they could have moved since.
  if (!full && !force && now - refsAt < GIT_REFS_EVERY) return prev;
  if (!claimGit(key)) return prev; // the other panel is looking at it now
  try {
    if (!full) {
      // A checkout, a commit or a fetch shows here without walking this
      // repository's worktree.
      const [ref, up] = await allSettledValues(
        exec("git", ["symbolic-ref", "-q", "HEAD"], opts),
        exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], opts),
      );
      if (gitUnanswered(ref, GIT_NO_REF) || gitUnanswered(up, GIT_NO_UPSTREAM)) {
        return publishGit(key, { at: now, refsAt, dirtyAt, info, unsure: true });
      }
      if (gitNoRepo(ref) || gitNoRepo(up)) {
        return publishGit(key, { at: now, refsAt: now, dirtyAt: now, info: null, unsure: false });
      }
      // `HEAD...@{upstream}` counts ahead then behind; no upstream has nothing to count.
      const counts = up.code === 0
        ? await exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], opts)
        : null;
      if (counts && gitUnanswered(counts, GIT_NO_UPSTREAM)) {
        return publishGit(key, { at: now, refsAt, dirtyAt, info, unsure: true });
      }
      const branch = ref.code === 0 ? ref.stdout.trim().replace(/^refs\/heads\//, "") : "";
      const upstream = up.code === 0 ? up.stdout.trim() || null : null;
      const [ahead, behind] = counts?.code === 0
        ? counts.stdout.trim().split(/\s+/).map((n) => Math.abs(parseInt(n, 10)) || 0)
        : [0, 0];
      return publishGit(key, {
        at: now, refsAt: now, dirtyAt, unsure: false,
        info: { ...info, branch: branch || null, upstream, ahead, behind },
      });
    }
    // The walk: the repo's own folders, then the worktree. Two `rev-parse` runs
    // because a folder name may itself contain a newline; `status` takes no
    // optional locks and no fsmonitor cookie, so it writes nothing under .git and
    // does not wake the folder watch the spaces panel keeps on the repository.
    const [top, common] = await allSettledValues(
      exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], opts),
      exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts),
    );
    if (gitNoRepo(top) || gitNoRepo(common)) {
      return publishGit(key, { at: now, refsAt: now, dirtyAt: now, info: null, unsure: false });
    }
    if (top.code !== 0 || common.code !== 0) {
      // Git would not answer (a machine away, a folder it lost): keep the last.
      return publishGit(key, { at: now, refsAt, dirtyAt, info, unsure: true });
    }
    const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], opts);
    // Strip only Git's final newline: a folder name may contain whitespace.
    const tree = top.stdout.replace(/\n$/, "");
    const repo = common.stdout.replace(/\n$/, "");
    if (gitNoRepo(status)) {
      return publishGit(key, { at: now, refsAt: now, dirtyAt: now, info: null, unsure: false });
    }
    if (status.code !== 0 || !tree || !repo) {
      return publishGit(key, { at: now, refsAt, dirtyAt, info, unsure: true });
    }
    return publishGit(key, {
      at: now, refsAt: now, dirtyAt: now, unsure: false,
      info: { ...gitBranchInfo(status.stdout), name: gitRepoName(repo), repo: JSON.stringify([on, repo]), linked: repo !== `${tree}/.git` },
    });
  } catch {
    // Couldn't ask (the machine is away): keep what it showed, look again later.
    return publishGit(key, { at: now, refsAt, dirtyAt, info, unsure: true });
  }
}
// --- end shared git cache ---

// A machine's core runs sixteen execs at once and the spaces panel may be using
// six looks of two, so two places here keep a slow repository from crowding the
// others out while leaving that room.
const AT_ONCE = 2;
const gitKey = (on, cwd) => JSON.stringify([on ?? null, cwd]);

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
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
    this.gitBusy = false;
    if (checking()) return;
    this.badgeOwner = true;
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.refreshGit(cx);
    cx.timer.every(5000, (cx) => this.refreshGit(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  close() {
    if (this.badgeOwner) setBadge(null);
  }

  updateBadge(list) {
    if (checking()) return;
    // Count actual agents before grouping/folding, not the parent's promoted rank.
    const count = list.filter(a => a.status === "blocked" || a.status === "done").length;
    const badge = count ? String(count) : null;
    if (badge === this.badge) return;
    this.badge = badge;
    setBadge(badge);
  }

  // Every place a listed agent works in: the machine it is on (null here) and
  // the pane's live folder.
  places() {
    const cwdOf = new Map(panes().map((p) => [p.pane, p.cwd]));
    const out = new Map();
    for (const a of agents()) {
      const cwd = cwdOf.get(a.pane);
      if (!cwd) continue;
      const on = a.address.includes("/") ? a.address.split("/")[0] : null;
      out.set(gitKey(on, cwd), { on, cwd });
    }
    return [...out.entries()];
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
  adoptGit(live = null) {
    const cache = readGitStore().places;
    for (const key of live ?? Object.keys(cache)) {
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
    const due = places.filter(([key]) => {
      const record = readGitRecord(key) ?? this.gitRecord(key);
      if (!record) return true;
      if (record.unsure && now - record.at < GIT_REFS_EVERY) return false;
      return now - record.refsAt >= GIT_REFS_EVERY || now - record.dirtyAt >= GIT_DIRTY_EVERY;
    });
    if (!due.length) return;
    this.gitBusy = true;
    cx.spawn(async (cx) => {
      let next = 0;
      try {
        await Promise.allSettled(Array.from({ length: Math.min(AT_ONCE, due.length) }, async () => {
          while (next < due.length) {
            const [key, place] = due[next++];
            // The record this look starts from: an answer that lands while the
            // place waits its turn takes its place.
            const queued = gitRecordOf(readGitStore().places[key]);
            await this.check(key, place, queued);
          }
        }));
      } finally {
        this.gitBusy = false;
        cx.notify();
      }
    });
  }

  // One place's git: the shared look, and its answer on the row.
  async check(key, place, queued = null) {
    const prev = queued ?? readGitRecord(key) ?? this.gitRecord(key);
    const walk = !this.gitAt[key] || Date.now() - (Number(prev?.dirtyAt) || 0) >= GIT_DIRTY_EVERY;
    const record = await checkGit(key, place, prev, { walk });
    if (!record) return; // a peer owns the first look; adoption will supply its answer
    this.gitRecords[key] = record;
    this.gitAt[key] = record.at;
    this.git[key] = record.info;
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

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
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
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(4)
      .my(1)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.ansi5 + "26"))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    this.adoptGit();
    const collapsed = narrow();
    const px = sidebarPx();
    const sort = sortOf();
    let list = agents();
    this.updateBadge(list);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    if (!checking()) this.migratePins(all);
    const focus = focused();
    const active = focus?.shown ?? focus?.terminal ?? focus?.agent ?? list.find(a => a.focused)?.address ?? null;
    const shown = active;
    // Only a new navigation unfolds the target. A manually folded current group
    // stays folded until focus leaves and returns.
    const navigated = active !== this.revealed;
    const now = Date.now();
    if (!checking()) this.track(list, now);
    this.hold(list);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    if (!checking()) setAgentOrder(list.map((a) => a.address));

    let offset = 0;
    this.activeAt = -1;
    const indexed = (el, address) => {
      if (active && address === active) this.activeAt = offset;
      offset++;
      return el;
    };
    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      if (navigated && subs.some(s => s.t.address === active)) this.folded.delete(a.address);
      const r = indexed(row(a, i, subs), a.address);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map(s => indexed(this.subRow(t, s, shown, byPriority), s.t.address))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // Read the pane snapshot once: every host read copies the whole list into JS.
    const ps = panes();
    const leads = leadPanes(ps);
    const cwdOf = new Map(ps.map((p) => [p.pane, p.cwd]));
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 20, t.foreground);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
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
        .cursor_pointer()
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
      // The state and the program sit between the two lines, both centred on the
      // whole row; the first line is the folder it works in, the second the
      // machine it runs on.
      const cwd = cwdOf.get(a.pane) ?? null;
      const folder = (cwd && base(cwd)) || a.space_name || label(a);
      const g = cwd ? this.git[gitKey(machine, cwd)] : null;
      const remote = g?.upstream?.includes("/") ? `\u25b8 ${g.upstream.slice(0, g.upstream.indexOf("/"))}` : "";
      const tail = [g?.branch, remote].filter(Boolean).join(" ");
      // The row's own columns, off the sidebar width: this is what is left.
      const line = this.nameLine([
        { text: machine ?? "Local", color: t.dim },
        ...(tail ? [{ text: tail, color: t.dim }] : []),
        ...(g?.dirty > 0 ? [{ text: `*${g.dirty}`, color: t.ansi3, fixed: true }] : []),
        ...(g?.conflicts > 0 ? [{ text: `\u2718${g.conflicts}`, color: t.ansi1, fixed: true }] : []),
        ...(g?.ahead > 0 ? [{ text: `\u2191${g.ahead}`, color: t.ansi2, fixed: true }] : []),
        ...(g?.behind > 0 ? [{ text: `\u2193${g.behind}`, color: t.ansi1, fixed: true }] : []),
      ], Math.max(0, px - 88));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .py(3)
        .my(1)
        .flex_none()
        .gap(8)
        .items_center()
        .rounded(4)
        .when(a.focused, (el) => el.bg(t.ansi5 + "33"))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .child(div().w(16).flex_none().flex().justify_center().child(this.status(t, a, true)))
        .when(Boolean(pic), (el) => el.child(div().id(`agent-fold-${a.address}`).flex_none()
          .when(subs.length > 0, (el) => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .when(!pic, (el) => el.child(div().w(20).flex_none()))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().h(18).flex_none().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(folder))
            .when(subs.length > 0, (el) => el.child(fold(a, subs)))
            .when(this.hovered === a.address, (el) => el.child(pin))
            .when(this.hovered !== a.address && Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when)))))
          .child(h_flex().h(16).w_full().min_w(0).gap(4).items_center()
            .child(svg(`mods/workspace-chrome/${machine ? "server" : "monitor"}.svg`).size(12).flex_none().text_color(t.dim))
            .when(Boolean(line), (el) => el.child(line))));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
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
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    if (navigated) for (const g of groups) {
      if (g.members.some(a => a.address === active || this.tree(all, a.address).some(s => s.t.address === active))) this.folded.delete(g.id);
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
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "sidebar-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).when(!collapsed, (el) => el.pl(8).pr(SCROLL_GUTTER)).overflow_y_scrollbar().mode("always")
        .track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
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
