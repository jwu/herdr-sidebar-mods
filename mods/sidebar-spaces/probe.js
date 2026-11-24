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
export const hostOf = (target) => {
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

// The second line under a machine's name: CPU and memory, read from that
// machine's own shell. Linux counters are compared with the previous reading;
// macOS has no such counters a shell can read, so `ps` sums what is running.
// A machine without a POSIX shell (Windows) keeps the placeholders.
const STAT_SCRIPT = [
  "printf '[stats]\\n'",
  '(',
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
  ") && printf '[/stats]\\n'",
].join("\n");
const clamp = (v) => Math.min(100, Math.max(0, v));

// The ports a space's servers listen on, read the way Sheprd reads its sidebar:
// a listener proves where it was started by the terminal it inherited, never by
// a process tree or a working folder. herdr-core exports HC_TERMINAL_ID into
// every terminal it opens and Herdr exports HERDR_WORKSPACE_ID into every pane
// it starts; a listener with neither (a system service, a container, anything
// started outside Herdr) belongs to no space and is dropped. `L` is one
// listening socket, `O` one owner a listener named.
const PORT_SCRIPT = [
  "printf '[ports]\\n'",
  '(',
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
  `  herdr_ports=$(lsof -nP -a -u "$(id -u)" -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '`,
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
  ") && printf '[/ports]\\n'",
].join("\n");

// Each section closes only on success. The shell can finish either one.
export function sampleScript(usage, ports) {
  return [usage ? STAT_SCRIPT : "", ports ? PORT_SCRIPT : "", ":"].join("\n");
}

export function sampleSections(stdout, usage, ports) {
  return {
    stats: usage ? /^\[stats\]\n([\s\S]*?)^\[\/stats\]$/m.exec(stdout)?.[1] : undefined,
    listeners: ports ? /^\[ports\]\n([\s\S]*?)^\[\/ports\]$/m.exec(stdout)?.[1] : undefined,
  };
}

// One machine's answer: its listening sockets, each put in the space whose
// terminal its process named.
export function parsePorts(out, machine, sp, ps) {
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
  const tabSpace = new Map();
  for (const s of sp) {
    if ((s.machine ?? null) !== machine) continue;
    for (const tab of s.tabs ?? []) tabSpace.set(tab.id, s.id);
  }
  // A pane id carries its machine's prefix; the process names only the bare
  // terminal, so both spellings lead to the space.
  const terminalSpace = new Map();
  for (const p of ps) {
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
  return found;
}

// One machine's answer: `os`, cores, memory, CPU counters (Linux) or a
// moment of `ps` (macOS).
export function parseStats(out, prev) {
  const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
  const os = lines[0]?.startsWith("os ") ? lines[0].slice(3) : "";
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const field = (name) => num(lines.find(l => l.startsWith(name + " "))?.slice(name.length + 1));
  const cores = field("cores");
  let cpu = null, mem = null, ticks = null;
  if (/^(Linux|MINGW|MSYS|CYGWIN)/.test(os)) {
    const stat = lines.find(l => l.startsWith("cpu "));
    const f = stat ? stat.split(/\s+/).slice(1).map(Number) : [];
    if (f.length >= 4 && f.every(Number.isFinite)) {
      const total = f.reduce((a, b) => a + b, 0);
      const idle = f[3] + (f[4] ?? 0);
      if (prev && total > prev.total) cpu = clamp((1 - (idle - prev.idle) / (total - prev.total)) * 100);
      ticks = { total, idle };
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
  return { cpu, mem, cores, ticks };
}
