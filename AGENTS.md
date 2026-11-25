# Working on this repository

- Tests: `node --test tests/*.test.mjs`. Check a mod in Herdr with
  `herdr-app check mods/<name>`.
- `shared.js`, `settings.js` and `update.js` are identical in
  `mods/sidebar-spaces/` and `mods/sidebar-agents/`. Edit one, copy it to the
  other (a test fails otherwise).
- Every user-visible change adds a line under `## Unreleased` in
  `CHANGELOG.md`, written for the person using the sidebar (what they see or
  can do), not the code.

## Releasing

When asked to release ("发布", "release", "cut a release"):

1. Make sure everything meant for the release is committed on `main`. If the
   tree has uncommitted work, ask whether it belongs in the release.
2. Read `git log $(git describe --tags --abbrev=0)..HEAD` and check that
   `## Unreleased` in `CHANGELOG.md` covers every user-visible change; add the
   missing lines and commit them (`Update changelog`).
3. Pick the version from the current `VERSION` in `mods/sidebar-spaces/update.js`,
   unless the person named one:
   - patch (`0.8.1` → `0.8.2`): fixes and polish only;
   - minor (`0.8.1` → `0.9.0`): any new feature, setting or behavior change;
   - major: only when the person asks.
4. Run `scripts/release.sh <x.y.z> --push`. It checks the branch, sets
   `VERSION` in both `update.js` files, dates the changelog section, runs the
   tests and `herdr-app check`, commits `Release v<x.y.z>`, tags and pushes.
   If it fails it restores the files; fix the cause and run it again.
5. Watch the Release workflow (`gh run watch …`, printed by the script) until
   it finishes, then check `gh release view v<x.y.z>` has the notes and the
   `herdr-ultimate-sidebar-v<x.y.z>.tar.gz` and `SHA256SUMS` assets.
6. Report the version, the release URL and the notes.

Installed copies learn about the release within a day: the sidebar's update
check reads GitHub's latest release and compares it with `VERSION`. The
workflow refuses a tag that differs from `VERSION`, so never tag by hand.
