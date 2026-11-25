// Keep this file identical in both mod folders so each can be installed on its own.
import { div, svg } from "gpui-kit";
import { checking, exec, layout, notify, panes, run, setShared, shared, spaces, terminals, window } from "herdr";

export function find(node, matches) {
  if (node && matches(node)) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, matches);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
export const sidebarPx = () => find(layout(), node => node.id === "sidebar")?.size?.px ?? Infinity;
export const narrow = () => sidebarPx() < 160;

// Whether the platform presents the window (Herdr 0.1.18+). Older Herdr has no
// flag, so only an explicit false pauses the polls.
export const shown = () => window()?.visible !== false;

export const STATUS_POSITION_KEY = "sidebar.statusPosition";
export const SHOW_USAGE = "sidebar.spaces.showUsage";
export const SHOW_PORTS = "sidebar.spaces.showPorts";
export const SHOW_CUP = "sidebar.spaces.showCup";
export const EXPAND_TERMINALS = "sidebar.spaces.expandTerminals";
export const SHOW_GIT_BRANCH = "sidebar.git.showBranch";
export const SHOW_GIT_CHANGES = "sidebar.git.showChanges";
export const SHOW_GIT_SYNC = "sidebar.git.showSync";
export const EXPAND_CHILDREN = "sidebar.agents.expandChildren";
export const AGENT_SORT = "agents.sort";
// "view": leaving a marked agent and coming back reads it. "manual": only Mark
// as read does. Either way a new turn or an ended terminal clears the mark.
export const UNREAD_CLEAR = "sidebar.agents.unreadClear";
export const unreadClearsOnView = () => shared(UNREAD_CLEAR) !== "manual";
export const enabled = key => shared(key) !== false;
export const statusAtStart = () => shared(STATUS_POSITION_KEY) === "start";

// A row shares one line between a label and its git tail: every segment keeps
// one glyph, then they grow in turn until the line is full, so a long name
// cannot crowd the branch out.
export const GLYPH = 8;
export const fit = (text, glyphs) => (text.length <= glyphs ? text : `${text.slice(0, Math.max(0, glyphs - 1))}\u2026`);
// The tail is cut to its budget and then sized by its own text, so it ends at
// the row's right edge instead of at the end of a wider measured cell.
export const SEG_GAP = 6;
export function segmentBudgets(lengths, available) {
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
// How far the bar's lane reaches in from the right edge (it is 6pt wide, drawn
// 4.5pt in): header controls, selection boxes and empty rows stop exactly where
// it starts, so nothing sits under it and nothing leaves a visible gap.
export const SCROLL_GUTTER = 11;

export const TREE_STROKE_WIDTH = 1.5;
export const TREE_COLUMN_WIDTH = 13;

// Rows in both sidebars use 26px cells with 1px margins. Extend each
// vertical stroke into those margins so adjacent rows meet.
export function treeLines(lines, t) {
  const color = t.dim;
  return lines.map(line => div().relative().w(9).h(26).mr(TREE_COLUMN_WIDTH - 9).flex_none()
    .when(Boolean(line), el => el.child(div().absolute().left(0).top(-1).w_full()
      .border_l(TREE_STROKE_WIDTH).border_color(color)
      .when(line === "└", stroke => stroke.h(15).border_b(TREE_STROKE_WIDTH).rounded_bl(5))
      .when(line !== "└", stroke => stroke.bottom(-1))))
    .when(line === "├", el => el.child(div().absolute().left(TREE_STROKE_WIDTH).right(0).top(12.5).h(TREE_STROKE_WIDTH).bg(color))));
}

// A space's state, drawn as the agents list draws an agent's: a spinner while
// working, a badge when blocked, a ring when idle, a dot when done.
export function mark(status, t) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  if (status === "done") return statusDot(t.done);
  if (status === "unread") return statusDot(unreadColor(t));
  return null;
}

export function statusDot(color) {
  return div().size(7).mx(3).flex_none().rounded(4).bg(color);
}

export function machineOf(address) {
  const slash = address.indexOf("/");
  return slash < 0 ? null : address.slice(0, slash);
}

// A kept terminal needs a space on its own machine. Match the built-in Peek.
export function keepTerminal(address) {
  const machine = machineOf(address);
  const there = spaces().filter(s => (s.machine ?? null) === machine);
  if (!there.length) {
    notify({ title: "No space on this terminal's machine", level: "error" });
    return;
  }
  if (!there.some(s => s.active)) {
    const byAddress = new Map(terminals().map(term => [term.address, term]));
    const tabByTerminal = new Map(panes().map(p => [p.terminal, p.tab]));
    const seen = new Set([address]);
    let parent = byAddress.get(address)?.parent;
    let target;
    while (parent && !seen.has(parent) && !target) {
      seen.add(parent);
      const tab = tabByTerminal.get(parent);
      target = there.find(s => s.tabs.some(t => t.id === tab));
      parent = byAddress.get(parent)?.parent;
    }
    run("space.select", { id: (target ?? there[0]).id });
  }
  run("terminal.keep", { terminal: address, place: "tab" });
}

// A peek does not clear the core's Done report. Remember the viewed turn
// across both panels and let the next turn display Done again.
export function viewedTerminalStatuses(all, shown) {
  const key = "sidebar.viewedTerminalTurns";
  const viewed = shared(key) ?? {};
  const turnOf = term => term.turn ?? term.status_ms;
  const current = all.find(term => term.address === shown && term.state === "live" && term.status === "done");
  const turn = current && turnOf(current);
  if (turn != null && viewed[shown] !== turn && !checking()) {
    const seen = Object.fromEntries(all.filter(term => term.state === "live" && term.status === "done" &&
      turnOf(term) != null && viewed[term.address] === turnOf(term)).map(term => [term.address, turnOf(term)]));
    setShared(key, { ...seen, [shown]: turn });
  }
  return all.map(term => term.state === "live" && term.status === "done" &&
    (term === current || (turnOf(term) != null && viewed[term.address] === turnOf(term)))
    ? { ...term, status: "idle" } : term);
}

// Marked unread by hand: an idle terminal shows as Unread until focus leaves
// it and comes back, or it starts another turn. Each mark says whether focus
// has left since, so marking the terminal you are on doesn't clear it at once.
export const UNREAD_KEY = "sidebar.unread";
// Settings offer these theme colors for unread; green is Done's.
export const UNREAD_COLOR = "sidebar.agents.unreadColor";
export const UNREAD_COLORS = [["red", "Red", "ansi1"], ["yellow", "Yellow", "ansi3"], ["blue", "Blue", "ansi4"], ["purple", "Purple", "ansi5"]];
export const unreadColor = t => t[(UNREAD_COLORS.find(([id]) => id === shared(UNREAD_COLOR)) ?? UNREAD_COLORS[0])[2]] ?? t.blocked;
const unreadMarks = () => {
  const marks = shared(UNREAD_KEY);
  return marks && typeof marks === "object" && !Array.isArray(marks) ? marks : {};
};

// The core keeps reporting a looked-at agent as done, so a new turn shows as a
// changed turn number rather than as a status.
const turnOf = term => term?.turn ?? term?.status_ms ?? null;

export function markUnread(address, active) {
  const turn = turnOf(terminals().find(term => term.address === address));
  setShared(UNREAD_KEY, { ...unreadMarks(), [address]: { left: address !== active, turn } });
}

export function markRead(addresses) {
  const marks = { ...unreadMarks() };
  for (const address of addresses) delete marks[address];
  setShared(UNREAD_KEY, marks);
}

const RESTING = new Set(["idle", "done"]);

// Statuses after viewedTerminalStatuses, with marked resting terminals as "unread".
// A terminal missing from the list keeps its mark: the list is empty right
// after a start.
export function unreadStatuses(all, active) {
  const marks = unreadMarks();
  const byAddress = new Map(all.map(term => [term.address, term]));
  const onView = unreadClearsOnView();
  let next = null;
  for (const [address, mark] of Object.entries(marks)) {
    const term = byAddress.get(address);
    if (!term) continue;
    const here = address === active;
    const spent = term.state !== "live" || !RESTING.has(term.status) || turnOf(term) !== (mark?.turn ?? null) ||
      (onView && mark?.left && here);
    // `left` follows focus, so switching to clear-on-view while looking at a
    // marked agent waits until you leave it and come back.
    if (spent) {
      next ??= { ...marks };
      delete next[address];
    } else if (Boolean(mark?.left) === here) {
      next ??= { ...marks };
      next[address] = { ...mark, left: !here };
    }
  }
  if (next && !checking()) setShared(UNREAD_KEY, next);
  const live = next ?? marks;
  return all.map(term => term.state === "live" && RESTING.has(term.status) && live[term.address]
    ? { ...term, status: "unread" } : term);
}

export const gitKey = (on, cwd) => JSON.stringify([on ?? null, cwd]);

// Spaces and Agents share their answers for places they both show. A place is
// (machine, live folder), so two machines' /repo never mix. A look can walk the
// worktree for changed files or read only refs, which is cheaper. Unused entries
// expire and the store stays bounded.
const GIT_CACHE = "sidebar.git.v1";
export const GIT_REFS_EVERY = 30000; // how stale branch, upstream and ahead/behind may get
export const GIT_DIRTY_EVERY = 60000; // how stale the worktree's changed files may get
const GIT_STALE = 900000; // a place not looked at for a quarter of an hour is dropped
const GIT_MAX = 64; // places kept in shared state
const GIT_TIMEOUT = 20000; // one look at a place, then ask again later

// Runs finished, not returned as they finish: a look is not over while one of
// its runs still holds an exec slot, and a failure waits for its peers.
async function allSettledValues(...runs) {
  const done = await Promise.allSettled(runs);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// The store as read: a damaged or absent value is an empty one.
export function readGitStore() {
  const places = shared(GIT_CACHE)?.places;
  return places && typeof places === "object" && !Array.isArray(places) ? places : {};
}

// One place's record, if it is one this panel can use: another copy's damaged
// write is not this panel's answer.
export function gitRecordOf(r) {
  if (!r || typeof r !== "object" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (Date.now() - r.at > GIT_STALE) return null;
  let info = r.info;
  if (info !== null) {
    const g = info;
    if (!g || typeof g !== "object" || Array.isArray(g) || typeof g.name !== "string"
      || (g.branch !== null && typeof g.branch !== "string")
      || (g.upstream !== null && typeof g.upstream !== "string")
      || !["ahead", "behind", "dirty", "conflicts"].every(k => Number.isFinite(g[k]) && g[k] >= 0)) return null;
    try {
      const repo = JSON.parse(g.repo);
      if (!Array.isArray(repo) || repo.length !== 2 || (repo[0] !== null && typeof repo[0] !== "string") || typeof repo[1] !== "string") return null;
      if (g.name === ".bare" && repo[1].endsWith("/.bare")) info = { ...g, name: gitRepoName(repo[1]) };
    } catch { return null; }
  }
  return {
    at: r.at,
    refsAt: Number.isFinite(r.refsAt) ? r.refsAt : 0,
    dirtyAt: Number.isFinite(r.dirtyAt) ? r.dirtyAt : 0,
    info: info ?? null,
    unsure: r.unsure === true,
  };
}

export function latestGitRecord(key, local) {
  const peer = gitRecordOf(readGitStore()[key]);
  return peer && peer.at > (local?.at ?? 0) ? peer : local;
}

// Publish a pool's answers together, keeping anything newer that arrived while
// it ran. Places nobody looked at for a while go.
export function writeGitStore(results) {
  if (checking() || !results.size) return;
  const places = { ...readGitStore() };
  let changed = false;
  for (const [key, record] of results) {
    if ((gitRecordOf(places[key])?.at ?? 0) > record.at) continue;
    places[key] = record;
    changed = true;
  }
  if (!changed) return;
  const now = Date.now();
  const kept = {};
  for (const [k, r] of Object.entries(places)) {
    if (!r || typeof r !== "object" || !Number.isFinite(r.at) || now - r.at > GIT_STALE) continue;
    kept[k] = r;
  }
  const newest = Object.entries(kept).sort((a, b) => b[1].at - a[1].at).slice(0, GIT_MAX);
  setShared(GIT_CACHE, { places: Object.fromEntries(newest) });
}

// The repo's own name: its .git folder names it, and a worktree's top differs.
function gitRepoName(repo) {
  const last = (path) => path.replace(/\/+$/, "").split("/").pop();
  if (repo.endsWith("/.git")) return last(repo.slice(0, -5));
  if (repo.endsWith("/.bare")) return last(repo.slice(0, -6)) || ".bare";
  return last(repo).replace(/\.git$/, "");
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
// they were read a moment ago (a folder watch or live branch change).
export async function checkGit(key, place, prev, { walk = false, force = false, since = 0, results } = {}) {
  prev = latestGitRecord(key, prev);
  const full = walk || !prev?.info?.repo;
  // Another panel's answer can stand in for this request if it read what we need
  // after the request was made. A forced request may share a millisecond with
  // an older read, so give the event priority in a tie.
  const stamp = full ? prev?.dirtyAt : prev?.refsAt;
  if (since && (stamp > since || (!force && stamp === since))) return prev;
  const answer = await lookGit(place, prev, full);
  // A fast refresh of the same place must still be adoptable by the other mod.
  const record = { ...answer, at: Math.max(Date.now(), (prev?.at ?? 0) + 1) };
  results?.set(key, record);
  return record;
}

async function lookGit(place, prev, full) {
  const on = place.on ?? null;
  const opts = { cwd: place.cwd, on, timeout: GIT_TIMEOUT };
  const info = prev?.info ?? null;
  const refsAt = prev?.refsAt ?? 0;
  const dirtyAt = prev?.dirtyAt ?? 0;
  const now = Date.now();
  const unsure = { refsAt, dirtyAt, info, unsure: true };
  const missing = { refsAt: now, dirtyAt: now, info: null, unsure: false };
  try {
    if (!full) {
      // A checkout, a commit or a fetch shows here without walking this
      // repository's worktree.
      const [ref, up] = await allSettledValues(
        exec("git", ["symbolic-ref", "-q", "HEAD"], opts),
        exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], opts),
      );
      if (gitUnanswered(ref, GIT_NO_REF) || gitUnanswered(up, GIT_NO_UPSTREAM)) {
        return unsure;
      }
      if (gitNoRepo(ref) || gitNoRepo(up)) return missing;
      // `HEAD...@{upstream}` counts ahead then behind; no upstream has nothing to count.
      const counts = up.code === 0
        ? await exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], opts)
        : null;
      if (counts && gitUnanswered(counts, GIT_NO_UPSTREAM)) return unsure;
      const branch = ref.code === 0 ? ref.stdout.trim().replace(/^refs\/heads\//, "") : "";
      const upstream = up.code === 0 ? up.stdout.trim() || null : null;
      const [ahead, behind] = counts?.code === 0
        ? counts.stdout.trim().split(/\s+/).map((n) => Math.abs(parseInt(n, 10)) || 0)
        : [0, 0];
      return { refsAt: now, dirtyAt, unsure: false, info: { ...info, branch: branch || null, upstream, ahead, behind } };
    }
    let repoInfo = info;
    if (!repoInfo?.repo) {
      // A folder name may contain a newline, so ask for each path on its own.
      const [top, common] = await allSettledValues(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], opts),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts),
      );
      if (gitNoRepo(top) || gitNoRepo(common)) return missing;
      // Strip only Git's final newline: a folder name may contain whitespace.
      const tree = top.stdout.replace(/\n$/, "");
      const repo = common.stdout.replace(/\n$/, "");
      if (top.code !== 0 || common.code !== 0 || !tree || !repo) return unsure;
      repoInfo = { name: gitRepoName(repo), repo: JSON.stringify([on, repo]), linked: repo !== `${tree}/.git` };
    }
    // Avoid locks and fsmonitor cookies that would wake the repository watch.
    const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], opts);
    if (gitNoRepo(status)) return missing;
    if (status.code !== 0) return unsure;
    return { refsAt: now, dirtyAt: now, unsure: false, info: { ...repoInfo, ...gitBranchInfo(status.stdout) } };
  } catch {
    // Couldn't ask (the machine is away): keep what it showed, look again later.
    return unsure;
  }
}
