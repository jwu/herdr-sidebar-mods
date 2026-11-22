// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped under a header per machine, even when only this computer is known.
// After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import * as fs from "fs/promises";
import { spaces, machines, panes, terminals, focused, run, openOverlay, exec, hc, appHome, theme, shared, setShared, watchFolder, window, layout, nextCommand, checking } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const SPACE_MARGIN = 20;
const SPACE_PADDING = 8;
const SPACE_GAP = 9;
const SPACE_STATUS_WIDTH = 14;
const WORKTREE_INDENT = 22;
const FOLDER_WIDTH = 16;
const BRANCH_WIDTH = 13;
const TREE_STROKE_WIDTH = 1.5;
const TREE_COLUMN_WIDTH = 13;
const PORT_ROW_HEIGHT = 18;

const spaceTreeInset = worktree => SPACE_PADDING + SPACE_STATUS_WIDTH + SPACE_GAP
  + (worktree ? WORKTREE_INDENT : 0)
  + ((worktree ? BRANCH_WIDTH : FOLDER_WIDTH) - TREE_STROKE_WIDTH) / 2;
// A row shares one line between its name and its git tail: every segment keeps
// one glyph, then they grow in turn until the line is full, so a long name
// cannot crowd the branch out. Sheprd budgets its sidebar labels the same way.
const GLYPH = 8;
const fit = (text, glyphs) => (text.length <= glyphs ? text : `${text.slice(0, Math.max(0, glyphs - 1))}\u2026`);
// The tail is cut to its budget and then sized by its own text, so it ends at
// the row's right edge instead of at the end of a wider measured cell.
const SEG_GAP = 6;
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
const RAIL_CELL = 32;
// How far the bar's lane reaches in from the right edge (it is 6pt wide, drawn
// 4.5pt in): header controls, selection boxes and empty rows stop exactly where
// it starts, so nothing sits under it and nothing leaves a visible gap.
const SCROLL_GUTTER = 11;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);

// A peek does not clear the core's Done report. Remember the viewed turn
// across both panels and let the next turn display Done again.
function viewedTerminalStatuses(all, shown) {
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
    const key = space ?? machineOfTerminal(term.address);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(term);
  }
  return { bySpace, byMachine };
}

function machineOfTerminal(address) {
  const slash = address.indexOf("/");
  return slash < 0 ? null : address.slice(0, slash);
}

// Rows in both sidebars use 26px cells with 1px margins. Extend each
// vertical stroke into those margins so adjacent rows meet.
function treeLines(lines, t) {
  const color = t.dim;
  return lines.map(line => div().relative().w(9).h(26).mr(TREE_COLUMN_WIDTH - 9).flex_none()
    .when(Boolean(line), el => el.child(div().absolute().left(0).top(-1).w_full()
      .border_l(TREE_STROKE_WIDTH).border_color(color)
      .when(line === "└", stroke => stroke.h(15).border_b(TREE_STROKE_WIDTH).rounded_bl(5))
      .when(line !== "└", stroke => stroke.bottom(-1))))
    .when(line === "├", el => el.child(div().absolute().left(TREE_STROKE_WIDTH).right(0).top(12.5).h(TREE_STROKE_WIDTH).bg(color))));
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

// A space, tab, pane or terminal id without its machine prefix: a process on
// that machine names its own terminal the bare way.
const bare = (id) => id.slice(id.lastIndexOf("/") + 1);
// A listening socket's port, from `127.0.0.1:3000` or `[::1]:3000`.
const portOf = (address) => {
  const n = Number(address.slice(address.lastIndexOf(":") + 1));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};
// The host a machine answers to, taken from its ssh target (`jwu@192.168.3.81`,
// `[::1]`, or either with a port): a copied port names that host, not the
// window's `localhost`.
const hostOf = (target) => {
  if (!target) return null;
  let s = String(target).trim();
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 0) return s.slice(1, end);
  }
  const colon = s.indexOf(":");
  return colon > 0 ? s.slice(0, colon) : s;
};
// Bound the work across machines; a slow repository must not hold up the list.
const AT_ONCE = 6;

// The Local header's coffee cup: `caffeinate` holds the power assertion, as
// Sheprd's status-bar cup holds one through `keepawake`. The pid lives in a
// file in the app folder, so a reloaded mod takes the same hold back instead of
// starting a second cup; `-w` ties the hold to the window's process, so
// quitting Herdr lets go. Only macOS has `caffeinate`.
const CUP_PID = "sidebar-spaces.caffeine.pid";
// A cup nobody clicked off: checked this often, so one killed by hand shows off.
const CUP_VERIFY = 5000;
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Start the hold: `-d -i` like Sheprd (display and idle, no lid override), then
// the pid of the window, found up the process tree past herdr-core helpers.
const CUP_START = (file) => [
  `f=${shellQuote(file)}`,
  'mkdir -p "$(dirname "$f")"',
  'p=$$',
  'while [ "$p" -gt 1 ]; do',
  '  c=$(ps -o comm= -p "$p" 2>/dev/null)',
  '  case "$c" in',
  '    */herdr-core|*/hc|herdr-core|hc) ;;',
  '    *Herdr*|*herdr-app*) break ;;',
  '  esac',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  '  p=${p:-1}',
  'done',
  'if [ "$p" -gt 1 ]; then',
  '  caffeinate -d -i -w "$p" </dev/null >/dev/null 2>&1 &',
  'else',
  '  caffeinate -d -i </dev/null >/dev/null 2>&1 &',
  'fi',
  'echo $! > "$f"',
].join("\n");
const CUP_STOP = (file, pid) => [
  `f=${shellQuote(file)}`,
  'p=$(cat "$f" 2>/dev/null)',
  `[ -n "$p" ] || p=${Number.isInteger(pid) ? pid : ""}`,
  '[ -n "$p" ] && kill "$p" 2>/dev/null',
  'rm -f "$f"',
  'exit 0',
].join("\n");
// A pid that is still the `caffeinate` this mod started, not a reused one.
const CUP_ALIVE = (pid) => `kill -0 ${pid} 2>/dev/null && ps -o comm= -p ${pid} 2>/dev/null`;

// The second line under a machine's name: CPU and memory, read from that
// machine's own shell. Linux counters are compared with the previous reading;
// macOS has no such counters a shell can read, so `ps` sums what is running.
// A machine without a POSIX shell (Windows) keeps the placeholders.
const STAT_EVERY = 5000;
const CPU_WARN = 75;
const MEM_WARN = 80;
// A machine row's CPU sparkline: samples kept, bar width and gap, its height.
const HISTORY = 16;
const BAR_W = 3;
const BAR_GAP = 1;
const GRAPH_H = 14;
const METER_W = 36;
const STAT_SCRIPT = [
  'os=$(uname -s 2>/dev/null) || exit 1',
  'echo "os $os"',
  'case "$os" in',
  '  Linux|MINGW*|MSYS*|CYGWIN*)',
  '    echo "cores $(getconf _NPROCESSORS_ONLN 2>/dev/null)"',
  '    head -n 1 /proc/stat',
  "    grep -E '^(MemTotal|MemAvailable|MemFree):' /proc/meminfo",
  '    ;;',
  '  Darwin)',
  '    echo "cores $(sysctl -n hw.ncpu 2>/dev/null)"',
  '    echo "memsize $(sysctl -n hw.memsize 2>/dev/null)"',
  '    vm_stat',
  '    ps -A -o %cpu=',
  '    ;;',
  'esac',
].join("\n");
const clamp = (v) => Math.min(100, Math.max(0, v));

// The ports a space's servers listen on, read the way Sheprd reads its sidebar:
// a listener proves where it was started by the terminal it inherited, never by
// a process tree or a working folder. herdr-core exports HC_TERMINAL_ID into
// every terminal it opens and Herdr exports HERDR_WORKSPACE_ID into every pane
// it starts; a listener with neither (a system service, a container, anything
// started outside Herdr) belongs to no space and is dropped. `L` is one
// listening socket, `O` one owner a listener named.
const PORT_EVERY = 5000;
const PORT_TIMEOUT = 15000;
const PORT_SCRIPT = [
  'for herdr_dir in /usr/sbin /sbin; do',
  '  case ":$PATH:" in',
  '    *":$herdr_dir:"*) ;;',
  '    *) PATH="$PATH:$herdr_dir" ;;',
  '  esac',
  'done',
  'if command -v ss >/dev/null 2>&1; then',
  "  herdr_ports=$(ss -ltnp 2>/dev/null | awk '{",
  '    rest = $0',
  '    while (match(rest, /\\("[^"]*",pid=[0-9]+/)) {',
  '      entry = substr(rest, RSTART + 2, RLENGTH - 2)',
  '      rest = substr(rest, RSTART + RLENGTH)',
  '      split(entry, part, "\\",pid=")',
  '      print "L", part[2], $4',
  '    }',
  "  }')",
  'elif command -v lsof >/dev/null 2>&1; then',
  "  herdr_ports=$(lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '",
  '    /^p/ { pid = substr($0, 2) }',
  "    /^n/ { print \"L\", pid, substr($0, 2) }')",
  'else',
  '  herdr_ports=N',
  'fi',
  "printf '%s\\n' \"$herdr_ports\"",
  "for herdr_pid in $(printf '%s\\n' \"$herdr_ports\" | awk '$1 == \"L\" { print $2 }' | sort -un | head -n 128); do",
  '  if [ -r "/proc/$herdr_pid/environ" ]; then',
  "    herdr_env=$(tr '\\0' '\\n' < \"/proc/$herdr_pid/environ\")",
  '  else',
  "    herdr_env=$(ps -E -ww -o command= -p \"$herdr_pid\" 2>/dev/null | tr ' ' '\\n')",
  '  fi',
  '  for herdr_key in HERDR_WORKSPACE_ID HC_TERMINAL_ID; do',
  "    herdr_val=$(printf '%s\\n' \"$herdr_env\" | sed -n \"s/^$herdr_key=//p\" | head -n 1)",
  '    [ -n "$herdr_val" ] && printf \'O %s %s %s\\n\' "$herdr_pid" "$herdr_key" "$herdr_val"',
  '  done',
  'done',
  'true',
].join("\n");

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// A space's state, drawn as the agents list draws an agent's: a spinner while
// working, a badge when blocked, a ring when idle, a dot when done.
export function mark(status, t) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
  return null;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.gitRecords = {}; // separate refs/worktree ages survive shared-cache eviction
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.gitInFlight = new Set(); // places already being checked
    this.gitWalk = new Set(); // where()s to walk for changed files, not only refs
    this.gitForced = new Set(); // where()s whose refs to read now, freshness aside
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repo -> its pending folder watch
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new();
    this.activeAt = -1;
    this.machines = [];
    this.stats = {}; // machine -> { cpu, mem, cores }, percentages or null
    this.history = {}; // machine -> its last CPU shares, oldest first
    this.ticks = {}; // machine -> its last Linux CPU counters
    this.statsAt = {}; // machine -> when it was last asked
    this.sampling = new Set(); // machines a sample is in flight for
    this.ports = {}; // machine "" -> { space -> [{ number, address }] }
    this.portAt = {}; // machine -> when its ports were last read
    this.portScan = new Set(); // machines a port scan is in flight for
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
    this.foldedTerminals = new Set();
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
    this.machinePress = null; // { m } while a header's press may become a reorder
    this.machineOver = null; // { m } the header under the pointer
    // Initialize render state even in a check, but never run helpers or touch files.
    this.cup = "off"; // "off" | "on" | "busy"
    this.cupPid = null;
    this.cupHere = false;
    this.cupFile = `${appHome()}/${CUP_PID}`;
    if (checking()) return;
    // "pick1".."pick9" from keys.json: the panel's own row numbering, which the
    // machines dragged here can put out of step with `space.select`.
    cx.spawn(async () => {
      for (;;) {
        const n = Number(String(await nextCommand()).replace(/^pick/, ""));
        if (n >= 1 && n <= 9) this.pick(n);
      }
    });
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // The Local header's cup is available wherever `caffeinate` exists.
    cx.spawn(async (cx) => {
      try { this.cupHere = (await exec("sh", ["-c", "command -v caffeinate"])).code === 0; } catch {}
      if (this.cupHere) await this.syncCup(cx);
      cx.notify();
    });
    cx.timer.every(CUP_VERIFY, (cx) => this.verifyCup(cx));
    cx.timer.every(2000, cx => { this.refreshStats(cx); this.refreshPorts(cx); });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    if (this.finishedCountsDirty) this.refreshFinishedCounts(cx);
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.adoptGit(new Set(sp.map((s) => where(s, ps))));
    // A repository the other panel answered for needs its watch here too, so
    // changes in it reach this panel without another timer.
    for (const [key, info] of Object.entries(this.git)) {
      const repo = info?.repo;
      if (repo && JSON.parse(key)[0] === null) this.watch(JSON.parse(repo)[1], cx);
    }
    const due = this.due(now, sp, ps);
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
    if (window().active) {
      // The fallback looks are for what moves without this machine seeing it (a
      // commit elsewhere, an editor saving): the refs alone every half minute,
      // the worktree's work less often.
      for (const k of keys) {
        if (!(this.git[k] || this.unsure.has(k)) || this.folded.has(JSON.parse(k)[0])) continue;
        const record = readGitRecord(k) ?? this.gitRecord(k);
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
        if (result.code === 0) this.machines = JSON.parse(result.stdout).machines.filter(m => !m.temporary);
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
          const machine = machineOfTerminal(term.address);
          counts.set(machine, (counts.get(machine) ?? 0) + 1);
        }
        this.finishedCounts = counts;
        cx.notify();
      } catch {} finally {
        this.refreshingFinishedCounts = false;
      }
    });
  }

  // Ask each connected machine for its load; a slow or away machine misses its
  // turn without holding the others up.
  refreshStats(cx) {
    const now = Date.now();
    for (const m of [null, ...this.machines.filter(k => k.state === "connected").map(k => k.name)]) {
      const key = m ?? "";
      if (this.sampling.has(key) || now - (this.statsAt[key] ?? 0) < STAT_EVERY) continue;
      this.statsAt[key] = now;
      this.sampling.add(key);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("sh", ["-c", STAT_SCRIPT], { on: m, timeout: 15000 });
          if (r.code === 0) this.takeStats(key, r.stdout);
          else if (this.stats[key]) this.stats[key].stale = true;
        } catch {
          if (this.stats[key]) this.stats[key].stale = true;
        }
        this.sampling.delete(key);
        cx.notify();
      });
    }
  }

  // Each machine's listening ports, grouped by the space whose terminal
  // started the server. One look at a time per machine, five seconds apart; a
  // machine that is away keeps the ports it had.
  refreshPorts(cx) {
    const now = Date.now();
    for (const m of this.machineNames()) {
      const key = m ?? "";
      if (this.portScan.has(key) || now - (this.portAt[key] ?? 0) < PORT_EVERY) continue;
      if (m && !this.machines.some(k => k.name === m && k.state === "connected")) continue;
      this.portAt[key] = now;
      this.portScan.add(key);
      cx.spawn(async (cx) => {
        let out = null;
        try {
          const r = await exec("sh", ["-c", PORT_SCRIPT], { on: m, timeout: PORT_TIMEOUT });
          if (r.code === 0) out = r.stdout;
        } catch {}
        if (out != null) this.takePorts(key, out);
        this.portScan.delete(key);
        cx.notify();
      });
    }
  }

  // One machine's answer: its listening sockets, each put in the space whose
  // terminal its process named.
  takePorts(key, out) {
    const listeners = [];
    const owners = new Map();
    for (const line of out.split("\n")) {
      const f = line.trim().split(" ");
      if (f[0] === "L") {
        const number = portOf(f[2] ?? "");
        if (f[1] && number) listeners.push({ pid: f[1], number, address: f[2] });
      } else if (f[0] === "O" && f[1] && f[3]) {
        const owner = owners.get(f[1]) ?? {};
        owner[f[2] === "HERDR_WORKSPACE_ID" ? "workspace" : "terminal"] = f[3];
        owners.set(f[1], owner);
      }
    }
    const machine = key || null;
    const sp = spaces();
    const tabSpace = new Map();
    for (const s of sp) {
      if ((s.machine ?? null) !== machine) continue;
      for (const tab of s.tabs ?? []) tabSpace.set(tab.id, s.id);
    }
    // A pane id carries its machine's prefix; the process names only the bare
    // terminal, so both spellings lead to the space.
    const terminalSpace = new Map();
    for (const p of panes()) {
      const space = tabSpace.get(p.tab);
      if (!space || !p.terminal) continue;
      terminalSpace.set(p.terminal, space);
      terminalSpace.set(bare(p.terminal), space);
    }
    const spaceOf = (owner) => {
      if (!owner) return null;
      if (owner.terminal) {
        const space = terminalSpace.get(owner.terminal) ?? terminalSpace.get(bare(owner.terminal));
        if (space) return space;
      }
      if (owner.workspace) {
        const want = bare(owner.workspace);
        const space = sp.find(s => (s.machine ?? null) === machine && bare(s.id) === want);
        if (space) return space.id;
      }
      return null;
    };
    const found = {};
    for (const listener of listeners) {
      const space = spaceOf(owners.get(listener.pid));
      if (!space) continue;
      const list = found[space] ??= [];
      if (list.length >= 32 || list.some(p => p.number === listener.number)) continue;
      list.push({ number: listener.number, address: listener.address });
    }
    for (const list of Object.values(found)) list.sort((a, b) => a.number - b.number);
    this.ports[key] = found;
  }

  // One machine's answer: `os`, cores, memory, CPU counters (Linux) or a
  // moment of `ps` (macOS).
  takeStats(key, out) {
    const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
    const os = lines[0]?.startsWith("os ") ? lines[0].slice(3) : "";
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const field = (name) => num(lines.find(l => l.startsWith(name + " "))?.slice(name.length + 1));
    let cpu = null, mem = null, cores = field("cores");
    if (/^(Linux|MINGW|MSYS|CYGWIN)/.test(os)) {
      const stat = lines.find(l => l.startsWith("cpu "));
      const f = stat ? stat.split(/\s+/).slice(1).map(Number) : [];
      if (f.length >= 4 && f.every(Number.isFinite)) {
        const total = f.reduce((a, b) => a + b, 0);
        const idle = f[3] + (f[4] ?? 0);
        const prev = this.ticks[key];
        if (prev && total > prev.total) cpu = clamp((1 - (idle - prev.idle) / (total - prev.total)) * 100);
        this.ticks[key] = { total, idle };
      }
      const kb = (name) => {
        const l = lines.find(x => x.startsWith(name + ":"));
        const v = l ? num(l.slice(name.length + 1).replace(/[^\d.]/g, "")) : null;
        return v == null ? null : v * 1024;
      };
      const total = kb("MemTotal"), free = kb("MemAvailable") ?? kb("MemFree");
      if (total && free != null) mem = clamp((total - free) / total * 100);
    } else if (os === "Darwin") {
      const page = num(/page size of (\d+) bytes/.exec(out)?.[1]) ?? 4096;
      const pages = (name) => {
        const l = lines.find(x => x.startsWith(name + ":"));
        return l ? num(l.slice(name.length + 1).replace(/[^\d.]/g, "")) : null;
      };
      const used = ["Pages active", "Pages speculative", "Pages wired down", "Pages occupied by compressor"]
        .reduce((a, name) => a + (pages(name) ?? 0), 0);
      const total = field("memsize");
      if (total) mem = clamp(used * page / total * 100);
      // `ps` prints one percentage per process, of one core each.
      const sum = lines.filter(l => /^\d+(\.\d+)?$/.test(l)).reduce((a, v) => a + Number(v), 0);
      if (cores && sum > 0) cpu = clamp(sum / cores);
    }
    if (cpu != null) {
      const hist = (this.history[key] ??= []);
      hist.push(cpu);
      if (hist.length > HISTORY) hist.shift();
    }
    this.stats[key] = { cpu, mem, cores, stale: false, at: Date.now() };
  }

  // --- the Local machine's coffee cup -------------------------------------

  async cupPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      const r = await exec("sh", ["-c", CUP_ALIVE(pid)]);
      return r.code === 0 && /caffeinate/.test(r.stdout);
    } catch { return false; }
  }

  // The cup as it is now: the hold named by the pid file if it still runs, else
  // off. A reloaded mod, or a cup killed elsewhere, comes back right here.
  async syncCup(cx) {
    let pid = null;
    try { pid = Number((await fs.readFile(this.cupFile, "utf8")).trim()); } catch {}
    const held = await this.cupPidAlive(pid);
    this.cupPid = held ? pid : null;
    this.cup = held ? "on" : "off";
    if (!held) await fs.unlink(this.cupFile).catch(() => {});
    cx.notify();
  }

  toggleCup(cx) {
    if (this.cup === "busy") return;
    const held = this.cup === "on";
    this.cup = "busy";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await exec("sh", ["-c", held ? CUP_STOP(this.cupFile, this.cupPid) : CUP_START(this.cupFile)]);
      } catch {}
      await this.syncCup(cx);
    });
  }

  // A cup left on: `caffeinate` gone (killed, or quit without `-w` taking it)
  // means off, and the file goes with it.
  verifyCup(cx) {
    if (this.cup !== "on" || !this.cupPid) return;
    cx.spawn(async (cx) => {
      if (await this.cupPidAlive(this.cupPid)) return;
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
    const width = find(layout(), "sidebar")?.size?.px ?? Infinity;
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
        const finished = records.filter(term => term.state === "finished" && machineOfTerminal(term.address) === machine);
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
        window().push_toast({
          title: failed ? `${label}: removed ${removed}, could not remove ${failed}`
            : removed ? `${label}: removed ${removed} finished ${removed === 1 ? "terminal" : "terminals"}`
            : `${label}: no finished terminals`,
          level: failed ? "error" : "info",
        });
      } catch (error) {
        window().push_toast({ title: `${label}: ${error.message}`, level: "error" });
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

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) if (!this.gitInFlight.has(k)) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    // What the cache said when these places were queued: an answer that lands
    // while one waits its turn takes their place instead of a second look.
    this.gitQueued = readGitStore().places;
    cx.spawn(async (cx) => {
      try {
        const done = await Promise.allSettled(Array.from({ length: AT_ONCE }, async () => {
          while (this.pending.size) {
            const key = this.pending.values().next().value;
            this.pending.delete(key);
            this.gitInFlight.add(key);
            try { await this.check(key, cx); }
            finally { this.gitInFlight.delete(key); }
            cx.notify();
          }
        }));
        // Even an unexpected failure must not release the pool while peers run.
        const failed = done.find(d => d.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        this.refreshing = false;
        this.gitQueued = null;
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
  adoptGit(live = null) {
    const cache = readGitStore().places;
    for (const key of live ?? Object.keys(cache)) {
      const record = gitRecordOf(cache[key]);
      if (!record || record.at <= (this.checked[key] ?? 0)) continue;
      this.gitRecords[key] = record;
      this.checked[key] = record.at;
      this.git[key] = record.info;
      if (record.unsure) this.unsure.add(key);
      else this.unsure.delete(key);
    }
  }

  // One place's git, shared with the agents panel. A place this panel watched
  // change (a new folder, a finished command, a folder watch) asks for the
  // worktree too; the fallback look only refreshes what the refs say.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    const queued = this.gitQueued?.[key];
    const prev = (queued ? gitRecordOf(queued) : null) ?? readGitRecord(key) ?? this.gitRecord(key);
    const walk = this.gitWalk.delete(key) || !(key in this.git);
    const force = this.gitForced.delete(key);
    const record = await checkGit(key, { on, cwd }, prev, { walk, force });
    if (!record) return; // a peer owns the first look; adoption will supply its answer
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
          for (const k of keys) { this.gitForced.add(k); this.gitWalk.delete(k); }
          this.refreshGit(keys, cx);
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
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
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
    const shown = focused()?.shown;
    const tasks = collapsed ? null : terminalGroups(spaces(), panes(), viewedTerminalStatuses(all, shown));
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
          .children(this.terminalRows(id, terms, t, shown, r.tree)));
    };
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : 20).mr(collapsed ? 0 : SCROLL_GUTTER).my(1).px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    const machineNames = groups.map(group => group.m);
    return groups.flatMap(({ m, machine, repair, rebuilt, folded, rows }) => {
      const connected = !m || machine?.state === "connected";
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      // Elements are single-use: the rail and the wide head each build their own.
      const icon = () => svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.muted);
      const badge = () => div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.muted);
      const warning = () => div().id(`machine-logout-${m}`).flex_none().text_color(t.blocked)
        .tooltip("Agents stop when you disconnect. Click for the fix.")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); })
        .child("⚠");
      const toggle = (cx) => {
        if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
        folded ? this.folded.delete(m) : this.folded.add(m);
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
      const row1 = h_flex().gap(7).items_center()
        .child(icon())
        .child(div().flex_1().min_w_0().flex().items_center().gap(6)
          .child(div().min_w_0().truncate().child(m ?? "Local"))
          .when(m === null && this.cupHere, el => el.child(cup()))
          .when(connected && !rebuilt, el => el.child(trash())))
        .when(machine?.keeps_running_after_logout === false, el => el.child(warning()))
        .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
          .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
          .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
            .hover(s => s.text_color(t.foreground))
            .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
            .child(repair?.busy ? "Connecting…" : "Connect"))))
        .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
        .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.muted))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none());
      // A press that travels to another header reorders the machines; a press
      // that stays on its own folds it. The carried header fades, and the
      // header under the pointer shows the gap it would land in.
      const from = machineNames.indexOf(this.machinePress?.m);
      const carrying = from !== -1 && this.machineOver?.m !== this.machinePress?.m;
      const drop = () => div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(from < machineNames.indexOf(m), (el) => el.bottom(0))
        .when(from > machineNames.indexOf(m), (el) => el.top(0));
      const press = () => { this.machinePress = { m }; this.machineOver = { m }; };
      const over = (cx) => {
        if (this.machinePress && this.machineOver?.m !== m) {
          this.machineOver = { m };
          cx.notify();
        }
      };
      const release = (cx) => {
        const start = this.machinePress, onto = this.machineOver;
        this.machinePress = null;
        this.machineOver = null;
        if (start && onto && onto.m !== start.m) this.moveMachine(start.m, onto.m, machineNames);
        else if (start) toggle(cx);
        cx.notify();
      };
      const drag = (el) => el
        .on_mouse_down("left", press)
        .on_mouse_move((_e, cx) => over(cx))
        .on_mouse_up("left", (_e, cx) => release(cx));
      const head = collapsed
        ? drag(v_flex().id(`machine-${m ?? "local"}`).relative().flex_none().mt(4).w(RAIL_CELL).h(30).items_center().justify_center().rounded(4).bg(t.surface)
          .tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "Local")
          .cursor_pointer().hover(s => s.bg(t.hover))
          .when(this.machinePress?.m === m && carrying, (el) => el.opacity(0.5))
          .when(carrying && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(div().relative().flex_none().child(icon()).when(Boolean(m), el => el.child(badge()))
            .when(m === null && this.cup === "on", el => el.child(div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.surface).bg(t.ansi3))))
          .when(machine?.keeps_running_after_logout === false, el => el.child(warning())))
        : drag(v_flex().id(`machine-${m ?? "local"}`).relative().flex_none().mt(4).mb(1).pl(collapsed ? 0 : 18).pr(collapsed ? 0 : SCROLL_GUTTER).pt(5).pb(6).bg(t.surface)
          .text_size(13.5).font_medium().text_color(connected ? t.foreground : t.muted)
          .cursor_pointer().hover(s => s.bg(t.hover))
          .when(this.machinePress?.m === m && carrying, (el) => el.opacity(0.5))
          .when(carrying && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(row1)
          .child(this.usage(m, t, connected)));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : 20).mr(collapsed ? 0 : SCROLL_GUTTER).my(1).px(collapsed ? 0 : 8).gap(7).items_center().rounded(4)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
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
    const open = !this.foldedTerminals.has(id);
    return v_flex().id(`terminal-section-${id}`).ml(SPACE_MARGIN).mr(SCROLL_GUTTER).flex_none()
      .child(h_flex().id(`terminals-${id}`).h(rowHeight({ tree: false })).my(1).px(SPACE_PADDING)
        .gap(SPACE_GAP).items_center().rounded(4).flex_none()
        .text_size(13).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleTerminals(id, cx))
        .child(h_flex().w(SPACE_STATUS_WIDTH).flex_none().items_center().justify_center()
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.muted)))
        .child(svg("mods/sidebar-spaces/unplug.svg").size(FOLDER_WIDTH).flex_none().text_color(t.dim))
        .child(open ? "Unattached" : `Unattached ${terms.length}`))
      .children(this.terminalRows(id, terms, t, shown));
  }

  toggleTerminals(id, cx) {
    if (this.foldedTerminals.has(id)) this.foldedTerminals.delete(id);
    else this.foldedTerminals.add(id);
    cx.notify();
  }

  terminalRows(id, terms, t, shown, worktree = false) {
    if (this.foldedTerminals.has(id)) return [];
    const iconWidth = worktree ? BRANCH_WIDTH : FOLDER_WIDTH;
    const statusGap = spaceTreeInset(worktree) - SPACE_PADDING - SPACE_STATUS_WIDTH;
    const labelGap = SPACE_GAP + (iconWidth + TREE_STROKE_WIDTH) / 2 - TREE_COLUMN_WIDTH;
    return terminalTree(terms).map(({ term, lines }) => {
      const program = term.foreground?.name || term.program?.name || term.argv?.[0]?.split(/[\\/]/).pop();
      const title = term.name || term.template || program || term.address;
      const iconPath = term.program?.icon;
      const icon = iconPath && !term.program.tint
        ? image(iconPath).w(14).h(14).flex_none()
        : svg(iconPath || "mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.foreground);
      const tip = [title, term.address, term.parent && `Parent: ${term.parent}`].filter(Boolean).join(" · ");
      const status = term.status === "error" ? "blocked" : term.status;
      return h_flex().id(`task-${term.address}`).h(26).my(1).pl(SPACE_PADDING).pr(6)
        .items_center().rounded(4).text_size(12).text_color(t.muted).cursor_pointer().tooltip(tip)
        .when(shown === term.address, el => el.bg(t.ansi5 + "33").text_color(t.foreground))
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_hover((on, cx) => {
          const hovered = on ? term.address : this.hoveredChild === term.address ? null : this.hoveredChild;
          if (hovered === this.hoveredChild) return;
          this.hoveredChild = hovered;
          cx.notify();
        })
        .on_click((_e, cx) => {
          this.hoveredChild = null;
          cx.notify();
          run("terminal.peek", { terminal: term.address });
          viewedTerminalStatuses(terminals(), term.address);
        })
        .child(div().w(SPACE_STATUS_WIDTH).mr(statusGap).flex_none().flex().justify_center()
          .when(Boolean(status), el => el.child(mark(status, t))))
        .children(treeLines(lines, t))
        .child(h_flex().ml(labelGap).flex_1().min_w(0).gap(8).items_center()
          .child(icon)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title)))
        .child(div().ml(4).size(18).flex_none()
          .when(this.hoveredChild === term.address, el => el.child(div().id(`close-child-${term.address}`)
            .size_full().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).cursor_pointer().tooltip("Close terminal")
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.hoveredChild = null;
              run("terminal.kill", { terminal: term.address });
              cx.notify();
            })
            .child(svg("mods/workspace-chrome/x.svg").size(12)))));
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

  row({ w, i, g, tree }, t, terminalCount) {
    const px = find(layout(), "sidebar")?.size?.px ?? Infinity;
    const id = `space-${w.id}`;
    const open = !this.foldedTerminals.has(id);
    const fold = terminalCount > 0 ? h_flex().id(`terminals-${id}`).h(18).px(3).gap(3)
      .flex_none().items_center().rounded(4).cursor_pointer().text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.pressed = null;
        this.over = null;
        cx.notify();
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleTerminals(id, cx);
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!open, el => el.child(String(terminalCount))) : null;
    const foldWidth = fold ? 20 + (open ? 0 : 3 + String(terminalCount).length * 7) : 0;
    const room = Math.max(0, px - (tree ? 118 : 96) - foldWidth);
    const remote = g?.upstream?.includes("/") ? `\u25b8 ${g.upstream.slice(0, g.upstream.indexOf("/"))}` : "";
    // The tail reads as one segment, so the name keeps the larger share; the
    // counts keep their own colors, green ahead and red behind as starship's.
    const tail = [g?.branch, remote].filter(Boolean).join(" ");
    const lines = this.nameLine([
      { text: w.name, color: t.foreground, size: 13 },
      ...(tail ? [{ text: tail, color: t.dim }] : []),
      ...(g?.dirty > 0 ? [{ text: `*${g.dirty}`, color: t.ansi3, fixed: true }] : []),
      ...(g?.conflicts > 0 ? [{ text: `\u2718${g.conflicts}`, color: t.ansi1, fixed: true }] : []),
      ...(g?.ahead > 0 ? [{ text: `\u2191${g.ahead}`, color: t.ansi2, fixed: true }] : []),
      ...(g?.behind > 0 ? [{ text: `\u2193${g.behind}`, color: t.ansi1, fixed: true }] : []),
    ], room, fold);
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(SPACE_PADDING)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .w_full()
          .min_w(0)
          .gap(SPACE_GAP)
          .items_center()
          .child(div().w(SPACE_STATUS_WIDTH).flex_none().flex().justify_center().when(Boolean(w.status), el => el.child(mark(w.status, t))))
          .when(Boolean(tree), el => el.pl(WORKTREE_INDENT).child(svg("mods/workspace-chrome/branch.svg").size(BRANCH_WIDTH).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(svg("mods/workspace-chrome/folder.svg").size(FOLDER_WIDTH).flex_none().text_color(t.dim)))
          .when(Boolean(lines), el => el.child(lines)),
      );
  }

  // A space's row and the ports under it share one selection box: selecting or
  // hovering a space highlights the ports with it, not only its first line.
  spaceBox(row, t, terminalCount = 0) {
    const { w } = row;
    const on = w.active;
    const has = Boolean(this.ports[w.machine ?? ""]?.[w.id]?.length);
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
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .child(this.row(row, t, terminalCount))
      .when(has, el => el.child(this.portRow(w, t, row.tree)))
      .when(has && terminalCount > 0 && !this.foldedTerminals.has(`space-${w.id}`), el => el.child(
        div().id(`space-port-tree-${w.id}`).absolute().left(spaceTreeInset(row.tree)).bottom(-1)
          .w(TREE_STROKE_WIDTH).h(PORT_ROW_HEIGHT + 1).bg(t.dim),
      ));
  }

  // A space's listening ports under its row, `|` between them: each opens
  // where that server answers. A port on another machine has no tunnel from
  // this side, so clicking it copies `host:port` instead of opening a page
  // that would not load.
  portRow(w, t, tree) {
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
      .px(8)
      .pl(tree ? 75 : 56)
      .gap(5)
      .items_center()
      .overflow_hidden()
      .text_size(10.5)
      // The row under a space's ports selects that space when clicked on its
      // air; a port itself stops the press so it only opens (or copies) and
      // leaves the current space alone.
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_up("left", (_e, cx) => {
        const same = this.pressed === w.id;
        this.pressed = null;
        this.over = null;
        if (same) run("space.select", { id: w.id });
        cx.notify();
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
            // A drag that started on a space row and ended on a port leaves
            // its press behind when the port swallows the release.
            if (this.pressed !== null) {
              this.pressed = null;
              this.over = null;
              cx.notify();
            }
          })
          .on_click((_e, cx) => {
            if (local) cx.open_url(`http://localhost:${p.number}/`);
            else {
              cx.write_to_clipboard(`${host}:${p.number}`);
              window().push_toast({ title: `${host}:${p.number}`, level: "info" });
            }
          })
          .child(`:${p.number}`),
      ]));
  }

  compact({ w }, t, number) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(4)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.ansi5 + "33"))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(number)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    this.adoptGit();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
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
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.machinePress = null; this.machineOver = null; cx.notify(); })
        .children(list));
  }
}
