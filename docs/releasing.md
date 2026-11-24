# Releasing Herdr Ultimate Sidebar

The mods share one version. Use a patch release for fixes, a minor release
for new features, and a major release for breaking changes after 1.0.

1. Start with a clean working tree and sync `main` to the commit you want to release.
2. Check the mods with Herdr installed.

   ```sh
   node --test tests/*.test.mjs
   herdr-app check mods/sidebar-spaces
   herdr-app check mods/sidebar-agents
   herdr-app check mods/pane-header
   ```

3. Create and push a version tag. Replace `v0.1.0` with the version you intend to publish.

   ```sh
   git tag -a v0.1.0 -m "Herdr Ultimate Sidebar v0.1.0"
   git push origin v0.1.0
   ```

GitHub Actions runs the Node tests on the tagged commit and publishes a GitHub
Release with generated notes and source archives. Users can download a tagged
archive and follow the README install steps. Herdr Gallery continues to index
`main`, the repository’s default branch.
