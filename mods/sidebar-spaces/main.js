// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped under a header per machine, even when only this computer is known.
// After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, nextCommand } from "herdr";

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
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
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
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

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
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.stats = {}; // machine -> { cpu, mem, cores }, percentages or null
    this.history = {}; // machine -> its last CPU shares, oldest first
    this.ticks = {}; // machine -> its last Linux CPU counters
    this.statsAt = {}; // machine -> when it was last asked
    this.sampling = new Set(); // machines a sample is in flight for
    this.ports = {}; // machine "" -> { space -> [{ number, address }] }
    this.portAt = {}; // machine -> when its ports were last read
    this.portScan = new Set(); // machines a port scan is in flight for
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // The machine order the user dragged into place, by name (null is this one).
    // Machines it never lists keep the catalog's order after the arranged ones.
    this.order = JSON.parse(localStorage.getItem("machines.order") ?? "[]");
    this.machinePress = null; // { m } while a header's press may become a reorder
    this.machineOver = null; // { m } the header under the pointer
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
    cx.timer.every(2000, cx => { this.refreshStats(cx); this.refreshPorts(cx); });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
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
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
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
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
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
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.upstream ")) info.upstream = line.slice(18);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
        // Work in the tree: `1`/`2` changed or renamed, `?` untracked, `u` a conflict.
        else if (line.startsWith("u ")) { info.dirty++; info.conflicts++; }
        else if (/^[12?] /.test(line)) info.dirty++;
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
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
    // regroups them in the order dragged here (see `displayed`); a space cannot
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
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
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

  // The rows as the panel draws them: the machines in the order dragged here,
  // each its own rows in Herdr's order. This is what ctrl-1..9 count.
  displayed() {
    const rows = this.ordered();
    return this.arranged(this.machineNames()).flatMap((m) => rows.filter((r) => (r.w.machine ?? null) === m));
  }

  // Shows the space the panel lists at `n` (1-based). Herdr's own `space.select`
  // counts the daemon's order instead, which a machine dragged here no longer
  // matches, so keys.json sends ctrl-1..9 to `pick1`..`pick9`.
  pick(n) {
    const row = this.displayed()[n - 1];
    if (row) run("space.select", { id: row.w.id });
  }

  // The rows, under a header per machine. The header stays for this computer
  // alone, so a single-machine panel keeps showing its load.
  grouped(t, collapsed) {
    const rows = this.ordered();
    // A space draws as its row and, under it, the ports its servers listen on;
    // both sit inside one selection box (see `spaceBox`).
    const draw = (r) => collapsed
      ? [this.compact(r, t)]
      : [this.spaceBox(r, t)];
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : 20).mr(collapsed ? 0 : 8).my(1).px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    const machineNames = this.arranged(this.machineNames());
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      // Elements are single-use: the rail and the wide head each build their own.
      const icon = () => svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.muted);
      const badge = () => div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.muted);
      const toggle = (cx) => {
        folded ? this.folded.delete(m) : this.folded.add(m);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      };
      const row1 = h_flex().gap(7).items_center()
        .child(icon())
        .child(div().flex_1().truncate().child(m ?? "Local"))
        .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
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
          .tooltip(m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "Local")
          .cursor_pointer().hover(s => s.bg(t.hover))
          .when(this.machinePress?.m === m && carrying, (el) => el.opacity(0.5))
          .when(carrying && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(div().relative().flex_none().child(icon()).when(Boolean(m), el => el.child(badge()))))
        : drag(v_flex().id(`machine-${m ?? "local"}`).relative().flex_none().mt(4).mb(1).pl(collapsed ? 0 : 18).pr(collapsed ? 0 : 10).pt(5).pb(6).bg(t.surface)
          .text_size(13.5).font_medium().text_color(connected ? t.foreground : t.muted)
          .cursor_pointer().hover(s => s.bg(t.hover))
          .when(this.machinePress?.m === m && carrying, (el) => el.opacity(0.5))
          .when(carrying && this.machineOver?.m === m, (el) => el.child(drop()))
          .child(row1)
          .child(this.usage(m, t, connected)));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().ml(collapsed ? 0 : 20).mr(collapsed ? 0 : 8).my(1).px(collapsed ? 0 : 8).gap(7).items_center().rounded(4)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(4).justify_center().tooltip(`New space on ${m ?? "Local"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
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
  nameLine(parts, room) {
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
        ...kept.map((p, i) => div()
          .when(i === 0, (el) => el.flex_1().min_w(0))
          .when(i > 0, (el) => el.flex_none())
          .truncate()
          .text_size(p.size ?? 11.5).text_color(p.color).child(i === 0 ? p.text : fit(p.text, widths[i]))),
        ...fixed.map((p) => div().flex_none().text_size(p.size ?? 11.5).text_color(p.color).child(p.text)),
      ]);
  }

  row({ w, i, g, tree }, t) {
    const px = find(layout(), "sidebar")?.size?.px ?? Infinity;
    // Everything the row shows up to the status slot and the folder icon.
    const room = Math.max(0, px - (tree ? 118 : 96));
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
    ], room);
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
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
          .gap(9)
          .items_center()
          .child(div().w(14).flex_none().flex().justify_center().when(Boolean(w.status), el => el.child(mark(w.status, t))))
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(svg("mods/workspace-chrome/folder.svg").size(16).flex_none().text_color(t.dim)))
          .when(Boolean(lines), el => el.child(lines)),
      );
  }

  // A space's row and the ports under it share one selection box: selecting or
  // hovering a space highlights the ports with it, not only its first line.
  spaceBox(row, t) {
    const { w } = row;
    const on = w.active;
    const has = Boolean(this.ports[w.machine ?? ""]?.[w.id]?.length);
    return v_flex()
      .id(`space-box-${w.id}`)
      .flex_none()
      .ml(20)
      .mr(8)
      .my(1)
      .rounded(4)
      .when(on, (el) => el.bg(t.ansi5 + "33"))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .child(this.row(row, t))
      .when(has, (el) => el.child(this.portRow(w, t, row.tree)));
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
      .h(18)
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

  compact({ w, i }, t) {
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
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
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
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.machinePress = null; this.machineOver = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
