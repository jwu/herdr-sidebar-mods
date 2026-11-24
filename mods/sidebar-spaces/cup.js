import * as fs from "fs/promises";
import { exec } from "herdr";

// The Local header's coffee cup: `caffeinate` holds the power assertion, as
// Sheprd's status-bar cup holds one through `keepawake`. The pid lives in a
// file in the app folder, so a reloaded mod takes the same hold back instead of
// starting a second cup; `-w` ties the hold to the window's process, so
// quitting Herdr lets go. Only macOS has `caffeinate`.
export const CUP_PID = "sidebar-spaces.caffeine.pid";
// A cup nobody clicked off: checked this often, so one killed by hand shows off.
export const CUP_VERIFY = 5000;
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

export async function hasCaffeinate() {
  try { return (await exec("sh", ["-c", "command -v caffeinate"])).code === 0; } catch { return false; }
}

export async function cupPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const r = await exec("sh", ["-c", CUP_ALIVE(pid)]);
    return r.code === 0 && /caffeinate/.test(r.stdout);
  } catch { return false; }
}

export async function readCupPid(file) {
  try { return Number((await fs.readFile(file, "utf8")).trim()); } catch { return null; }
}

export function removeCupPid(file) {
  return fs.unlink(file).catch(() => {});
}

export async function changeCupHold(file, pid, held) {
  try { await exec("sh", ["-c", held ? CUP_STOP(file, pid) : CUP_START(file)]); } catch {}
}
