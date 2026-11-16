# Herdr sidebar mods

Two Herdr app mods that replace the left sidebar's **Spaces** and **Agents**
panels: per-machine CPU and memory on the machine headers, a git tail on every
space, agent state icons in front of each row, and a quieter purple selection.

![The two panels](preview.png)

## Mods

| Mod | Replaces | What it adds |
| --- | --- | --- |
| `sidebar-spaces` | the shipped `spaces` mod | full-width machine headers with a CPU sparkline and a memory meter (drag one onto another to reorder the machines; ctrl-1..9 can follow that order), a branch ▸ remote tail per space, a dim line of listening ports (`:3000 \| :5173`) under the space whose terminal started them, state icons, a coffee cup on the **Local** header that keeps this Mac awake, 2px row gaps |
| `sidebar-agents` | the shipped `agents` mod | two-line rows — folder, machine and that place's git tail on the first, then the program icon and title — state icon first in every row, 2px row gaps, the same purple selection and 4px corners |

They are meant to be used together, but each works on its own.

### Herdr 0.1.16 integration

- Spaces scrolls the active row into view when the selection, displayed order,
  or available height changes, including with a custom machine order.
- Spaces and Agents share Git results by machine and live folder, including
  in-flight deduplication. Between worktree scans, lightweight ref reads update
  branch, upstream and ahead/behind without walking the tree. Normal refresh is
  30 seconds for refs and 60 seconds for dirty/conflict counts; a finished command
  can refresh sooner. Spaces checks up to six places, Agents up to two.
  Temporary failures keep the last result and worktree grouping; leaving a
  repository releases its folder watch.
- Agents scrolls the focused row into view, including sub-agents, pinned rows
  and the compact rail. Navigating into a folded group unfolds it; folding the
  current group manually stays respected until focus leaves and returns.
- Machine headers show the official warning when agents would stop on logout,
  and offer a copyable `hc machine login <name>` when login is needed. The logout
  warning requires herdr-core 0.1.21 or newer on that machine.
- On macOS, Agents sets the Dock badge to the number of agents that are blocked
  **or done**, before grouping or folding. Zero clears it, and closing the panel
  clears its badge. Other badge-setting mods share Herdr's last-writer-wins API.
- Damaged saved panel state falls back safely. `herdr-app check` renders without
  running helpers, starting timers, changing pins, or touching the caffeine PID.

The existing purple selection, machine dragging, resource readings, port rows,
agent sorting and pinning are unchanged. New-space buttons still create and
select a space; no background-create gesture is added.

## Install

```sh
# from a clone of this repository
cp -R mods/sidebar-spaces ~/.config/herdr-app/mods/
cp -R mods/sidebar-agents ~/.config/herdr-app/mods/

# a layout that uses them: point your own layout's blocks at the new mods
herdr-app do layout.clone '{"name":"main","as":"sidebar"}'
# then set "mod": "sidebar-spaces" and "mod": "sidebar-agents" in
# ~/.config/herdr-app/layouts/sidebar.json, and switch to it with ctrl-shift-l
```

The shipped `spaces`/`agents` mods are rewritten by Herdr on every start, so
these live under their own names instead of editing the shipped files.

### ctrl-1..9 numbers the rows the panel shows

Herdr's own `space.select` counts the daemon's order (this machine first, then
machines by name), and `space.move` stays inside a machine's block. A machine
dragged in the panel therefore cannot renumber it. The mod answers
`sidebar-spaces.pick1`..`pick9` instead, counting the rows as drawn. Point the
keys at it in `~/.config/herdr-app/keys.json`, under the layout that shows the
panel (`layout:<name>` beats `global`; every other layout keeps the shipped
behaviour):

```json
"layout:sidebar": {
  "ctrl-1": "sidebar-spaces.pick1",
  "ctrl-2": "sidebar-spaces.pick2",
  "ctrl-3": "sidebar-spaces.pick3",
  "ctrl-4": "sidebar-spaces.pick4",
  "ctrl-5": "sidebar-spaces.pick5",
  "ctrl-6": "sidebar-spaces.pick6",
  "ctrl-7": "sidebar-spaces.pick7",
  "ctrl-8": "sidebar-spaces.pick8",
  "ctrl-9": "sidebar-spaces.pick9"
}
```

`herdr-app check` and `herdr-app do sidebar-spaces.pick5` work without it; the
binding only changes what a keypress reaches.

### Keeping this Mac awake

The coffee cup on the **Local** header holds this computer awake with
`caffeinate -d -i`, the way Sheprd's status-bar cup holds a power assertion: a
filled cup keeps the display on and stops idle sleep, and clicking it again lets
go. A closed lid still sleeps. The button is on this computer only (a remote
machine would need a hold started there) and only where `caffeinate` exists; the
rail, with room for one control per header, shows a small dot while the cup is
full instead of the button.

The hold is one `caffeinate` process named in
`~/.config/herdr-app/sidebar-spaces.caffeine.pid`. That file lets a reloaded mod
take the same cup back instead of starting a second one, and `-w <herdr pid>`
ties the hold to the window's process, so quitting Herdr lets go even when the
mod's own cleanup never ran. A cup killed by hand shows empty within five
seconds.

## Requirements

- Herdr app 0.1.16 or newer (`herdr-app --version`).
- A layout whose sidebar block has `"id": "sidebar"` (the shipped `main`
  layout does): both mods read its width to fall back to a compact rendering.
- The machine headers sample each machine with a POSIX shell over `exec`; a
  machine without one (plain Windows) shows `—` for CPU and memory.
- A space's ports come from `ss -ltnp` (Linux/WSL) or `lsof -nP -iTCP -sTCP:LISTEN`
  (macOS), read in that machine's own shell. Only servers started from a Herdr
  terminal are listed: the scan looks for the terminal a listener inherited
  (`HC_TERMINAL_ID`, or `HERDR_WORKSPACE_ID` for a pane Herdr itself started),
  so anything started outside Herdr — a system service, a container, a server
  from your login shell — stays out of the list. A port on another machine
  copies `IP:PORT` (the host from that machine's ssh target) instead of opening
  a page, because there is no tunnel from this window.

## Development checks

```sh
node --test tests/*.test.mjs
herdr-app check mods/sidebar-spaces
herdr-app check mods/sidebar-agents
```

The Node tests use mocked host APIs; the Herdr checks validate loading and
rendering against the installed app. Checks also refresh the bundled type files.

## License

Apache-2.0. Both mods start from Herdr's shipped `spaces` and `agents` mods
(c) Herdr, Apache-2.0; see `LICENSE`.
