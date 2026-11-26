# Changelog

Entries go under **Unreleased** as changes land. `scripts/release.sh` turns
that section into the release's notes. Releases up to 0.8.1 are listed on
[GitHub Releases](https://github.com/jwu/herdr-sidebar-mods/releases).

## Unreleased

## 0.12.0 - 2026-11-26

- Hover over a parent or child agent in Agents, or a child terminal in Spaces, to reveal a copy icon next to its terminal ID. Clicking it shows a brief **Copied** label at the top right of that sidebar. Local addresses copy as `id` and remote addresses as `machine/id`.

## 0.11.0 - 2026-11-25

- Top-level rows in Agents show the short terminal ID after the machine name, separated by a middle dot. Sidebar settings lets you show or hide parent and child terminal IDs independently.

## 0.10.0 - 2026-11-25

- Child terminal rows in Spaces and Agents show the short terminal ID next to the name, in the same color as Git branch names.

## 0.9.1 - 2026-11-25

- **Update check works.** In 0.9.0 GitHub refused every check, so no update was ever found. Sidebar settings now also says when a check fails and why.

## 0.9.0 - 2026-11-25

- **Update check.** Once a day the sidebar asks GitHub whether a newer release is out. A new version shows a toast once and a dot on the gear. **Updates** in Sidebar settings links the release and copies a line your agent can use to update the mods. Turn off **Check for updates daily** to stop the daily check.

