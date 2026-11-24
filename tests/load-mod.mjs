// Load a Herdr sidebar mod into a node:vm context with small, inspectable mocks.
//
// The mods are plain scripts for Herdr: no package.json, no installed `gpui-kit`
// or `herdr` packages. This loader evaluates local imports in their own scopes,
// replaces host imports with mocks, and exposes the default View as `globalThis.Mod`.
//
// Deliberately not a browser or Herdr emulator. UI builders are a fluent proxy:
// chains work, `.when(cond, fn)` runs `fn` only when `cond` is true, and the
// resulting id/children/handlers are inspectable with `uiState()` for later
// auto-scroll, machine-hint and agents tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);

export function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(check, { timeout = 1000, interval = 1 } = {}) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function flushTurns(turns = 6) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

export function createStorage(initial = {}) {
  if (initial && typeof initial.getItem === "function") return initial;
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    get length() {
      return data.size;
    },
  };
}

const uiStates = new WeakMap();

// The id, children, handlers and `.when` conditions recorded for a UI chain.
export function uiState(node) {
  return uiStates.get(node) ?? null;
}

function makeChain() {
  const state = { id: null, children: [], handlers: {}, conditions: [], calls: [] };
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined; // never promise-assimilate a chain
        if (prop === "inspect") return () => state;
        if (prop === "toJSON") return () => state;
        if (prop === Symbol.toStringTag) return "UI";
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop === "id") {
          return (value) => {
            state.id = value;
            return proxy;
          };
        }
        if (prop === "child") {
          return (value) => {
            state.children.push(value);
            return proxy;
          };
        }
        if (prop === "children") {
          return (values) => {
            state.children.push(...(Array.isArray(values) ? values : [values]));
            return proxy;
          };
        }
        if (prop === "when") {
          return (condition, fn) => {
            state.conditions.push(condition);
            if (condition) fn(proxy);
            return proxy;
          };
        }
        return (...args) => {
          state.calls.push([prop, ...args]);
          if (typeof prop === "string" && prop.startsWith("on_")) {
            state.handlers[prop] = args.at(-1);
            if (typeof args[0] === "string") state.handlers[`${prop}:${args[0]}`] = args.at(-1);
          }
          return proxy;
        };
      },
      set(_target, prop, value) {
        state[prop] = value;
        return true;
      },
    },
  );
  uiStates.set(proxy, state);
  return proxy;
}

function gpuiMocks() {
  class View {
    constructor(props) {
      this.props = props;
    }
  }
  return {
    View,
    div: () => makeChain(),
    svg: () => makeChain(),
    image: () => makeChain(),
  };
}

function gpuiBaseMocks() {
  const scrollHandles = [];
  return {
    v_flex: () => makeChain(),
    h_flex: () => makeChain(),
    scrollHandles,
    ScrollHandle: { new() {
      const handle = { items: [], scroll_to_item(index) { this.items.push(index); } };
      scrollHandles.push(handle);
      return handle;
    } },
  };
}

function herdrMocks() {
  const colors = {
    working: "#3b82f6",
    blocked: "#ef4444",
    done: "#22c55e",
    idle: "#94a3b8",
    dim: "#94a3b8",
    muted: "#94a3b8",
    foreground: "#e5e7eb",
    border: "#334155",
    input: "#1e293b",
    popover: "#1e293b",
    hover: "#334155",
    ansi1: "#ef4444",
    ansi3: "#f59e0b",
    unknown: "#94a3b8",
  };
  const noop = () => {};
  return {
    spaces: () => [],
    machines: () => [],
    panes: () => [],
    agents: () => [],
    terminals: () => [],
    focused: () => null,
    props: () => ({}),
    run: noop,
    openOverlay: noop,
    closeOverlay: noop,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    hc: async () => ({ code: 1, stdout: "", stderr: "" }),
    appHome: () => "/tmp/herdr-test",
    theme: () => colors,
    shared: () => undefined,
    setShared: noop,
    setAgentOrder: noop,
    checking: () => true,
    setBadge: noop,
    notify: noop,
    // A watch that never fires: tests that care pass their own deferred.
    watchFolder: () => new Promise(() => {}),
    window: () => ({ active: false, platform: "macos" }),
    layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: 300 } }] }),
    // The pick loop waits forever; tests do not run init here.
    nextCommand: () => new Promise(() => {}),
  };
}

function fsMocks() {
  return {
    readFile: async () => {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    unlink: async () => {},
  };
}

// `cx` for a mod: spawn records every promise, timers are inspectable and
// fireable by hand, and notify only counts (there is no renderer here).
function createContext() {
  const tasks = [];
  const timers = [];
  let notifyCount = 0;

  const context = {
    spawn(body) {
      const task = { done: false, error: null, promise: null };
      task.promise = Promise.resolve().then(() => body(context));
      task.promise.then(
        () => {
          task.done = true;
        },
        (error) => {
          task.done = true;
          task.error = error;
        },
      );
      // Keep an ignored rejection from failing the test process; awaiting the
      // promise still rejects.
      task.promise.catch(() => {});
      tasks.push(task);
      return { promise: task.promise, cancel() {} };
    },
    notify() {
      notifyCount++;
    },
    timer: {
      every(ms, fn) {
        const timer = { kind: "every", ms, fn, cancelled: false };
        timers.push(timer);
        return { cancel: () => (timer.cancelled = true) };
      },
      after(ms, fn) {
        const timer = { kind: "after", ms, fn, cancelled: false };
        timers.push(timer);
        return { cancel: () => (timer.cancelled = true) };
      },
    },
    sleep: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
    tasks,
    timers,
    async tick() {
      for (const timer of timers) if (!timer.cancelled) await timer.fn(context);
    },
    async flush({ timeout = 50 } = {}) {
      const deadline = Date.now() + timeout;
      let index = 0;
      while (index < tasks.length) {
        const task = tasks[index++];
        if (task.done) continue;
        const left = deadline - Date.now();
        if (left <= 0) break;
        await Promise.race([
          task.promise.catch(() => {}),
          new Promise((r) => setTimeout(r, Math.min(left, 5))),
        ]);
      }
      await Promise.resolve();
    },
  };
  Object.defineProperty(context, "notifyCount", {
    get: () => notifyCount,
  });
  context.cx = context;
  return context;
}

// The mods use named local imports and declaration exports. Evaluate dependencies
// first and keep each one's declarations scoped to that module.
function evaluateModule(file, sandbox, entry = false) {
  const exports = [];
  const source = readFileSync(file, "utf8")
    .replace(/^import\s+([^;]+?)\s+from\s+"([^"]+)";$/gm, (_line, bindings, specifier) => {
      if (!specifier.startsWith(".")) return "";
      const dependency = new URL(specifier, file);
      if (!sandbox.moduleImports.has(dependency.href)) {
        sandbox.moduleImports.set(dependency.href, evaluateModule(dependency, sandbox));
      }
      return `const ${bindings} = moduleImports.get(${JSON.stringify(dependency.href)});`;
    })
    .replace(/^export\s+default\s+class\s+/m, "globalThis.Mod = class ")
    .replace(/^export\s+((?:async\s+)?(?:function|class|const|let|var)\s+(\w+))/gm, (_line, declaration, name) => {
      exports.push(name);
      return declaration;
    });
  const script = entry ? source : `(() => {\n${source}\nreturn { ${exports.join(", ")} };\n})()`;
  return new vm.Script(script, { filename: fileURLToPath(file) }).runInContext(sandbox);
}

// loadMod("sidebar-spaces", { exec: ... }, { "machines.folded": "[]" })
//
// The second argument overrides any herdr function by name; the third seeds
// localStorage. Mocks are live: after loading, assign `herdr.exec = ...` and the
// mod's `exec(...)` calls see the replacement.
export function loadMod(name, herdrOverrides = {}, storage = {}) {
  const file = new URL(`mods/${name}/main.js`, ROOT);

  const context = createContext();
  const gpui = gpuiMocks();
  const gpuiBase = gpuiBaseMocks();
  const fs = fsMocks();
  const herdr = { ...herdrMocks(), ...herdrOverrides };

  const sandbox = {
    console,
    moduleImports: new Map(),
    localStorage: createStorage(storage),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fs,
    View: gpui.View,
    div: gpui.div,
    svg: gpui.svg,
    image: gpui.image,
    v_flex: gpuiBase.v_flex,
    h_flex: gpuiBase.h_flex,
    ScrollHandle: gpuiBase.ScrollHandle,
  };
  // Delegating wrappers keep the import bindings live when a test swaps a mock.
  for (const key of Object.keys(herdr)) {
    sandbox[key] = (...args) => herdr[key](...args);
  }

  vm.createContext(sandbox);
  evaluateModule(file, sandbox, true);

  const Class = sandbox.Mod;
  if (typeof Class !== "function") throw new Error(`${name}: globalThis.Mod was not created`);

  const mocks = { herdr, gpui, gpuiBase, fs, storage: sandbox.localStorage };
  return {
    Class,
    Mod: Class,
    context,
    vm: sandbox,
    mocks,
    herdr,
    fs,
    storage: sandbox.localStorage,
    createInstance: (overrides = {}) => makeInstance(Class, overrides),
  };
}

// Build a model without calling init(): init starts timers, scans machines and
// spawns waits that are not the subject of these tests. `checking: true` marks
// the panel's checking state as set up, the way init's git isolation does.
export function makeInstance(Class, overrides = {}) {
  const instance = Object.create(Class.prototype);
  Object.assign(
    instance,
    {
      checking: true,
      git: {}, // where() -> info, null: not a repo
      gitRecords: {}, // per-place freshness even after shared-cache eviction
      gitAt: {}, // where() -> when it was last looked at (agents)
      gitBusy: false,
      checked: {}, // where() -> last look (ms)
      unsure: new Set(), // places git could not answer for
      pending: new Set(), // places waiting to be checked
      gitInFlight: new Set(), // places a check already runs for
      gitWalk: new Set(), // places to walk for changed files, not only refs
      gitForced: Class.name === "Agents" ? new Map() : new Set(),
      gitRequested: new Map(), // places waiting for a scan and when it was requested
      gitBranches: new Map(), // places and their last live branch
      watching: new Map(), // local repo -> its pending folder watch
      refreshing: false,
      at: {}, // space -> its where() at the last look
      busy: {},
      ready: {},
      folded: new Set(),
      machines: [],
      shown: new Set(),
      born: {},
    },
    overrides,
  );
  return instance;
}
