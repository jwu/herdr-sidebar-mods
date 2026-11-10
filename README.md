# Herdr sidebar mods

Two Herdr app mods that replace the left sidebar's **Spaces** and **Agents**
panels: per-machine CPU and memory on the machine headers, a git tail on every
space, agent state icons in front of each row, and a quieter purple selection.

![The two panels](preview.png)

## Mods

| Mod | Replaces | What it adds |
| --- | --- | --- |
| `sidebar-spaces` | the shipped `spaces` mod | full-width machine headers with a CPU sparkline and a memory meter, a branch ▸ remote tail per space, state icons, 2px row gaps |
| `sidebar-agents` | the shipped `agents` mod | state icon first in every row, 2px row gaps, the same purple selection and 4px corners |

They are meant to be used together, but each works on its own.

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

## Requirements

- Herdr app 0.1.14 or newer (`herdr-app --version`).
- A layout whose sidebar block has `"id": "sidebar"` (the shipped `main`
  layout does): both mods read its width to fall back to a compact rendering.
- The machine headers sample each machine with a POSIX shell over `exec`; a
  machine without one (plain Windows) shows `—` for CPU and memory.

## License

Apache-2.0. Both mods start from Herdr's shipped `spaces` and `agents` mods
(c) Herdr, Apache-2.0; see `LICENSE`.
