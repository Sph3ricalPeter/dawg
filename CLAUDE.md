# dawg

Windows DAW for quick sound design: drag WAVs onto tracks, shape clips with
volume envelopes, export WAV. "Edit in dawg" in Explorer opens a file in a
scratch session. AI works as a coproducer through MCP only (no in-app panel).

Plan and spec: the "dawg: design" Claude Doc. UI reference: the design mockup
(`design/mockup.html` in the project files).

## Layout

- `crates/dawg-core`: headless project model and mixer. No UI, no device I/O.
  The app, the future `dawg-cli` and the MCP server all drive it.
- `src-tauri`: the Tauri app crate (`dawg`). Commands, plugins, installer config.
- `src`: React + TypeScript UI (Vite). Plain CSS with the mockup's tokens in
  `src/styles.css`; zustand stores in `src/stores`.
- `.github/workflows`: `ci.yml` (checks, tests, Windows "dawg dev" installer
  artifact) and `release.yml` (tag → signed installer + `latest.json`).

## Commands

```bash
npm run tauri dev
npm run typecheck && npm run lint && npm run build
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build:dev   # local installable "dawg dev" build
```

## Rules

- **Real-time path**: `Renderer::process` and anything the audio callback
  calls never allocates, locks or blocks. `crates/dawg-core/tests/realtime.rs`
  enforces no allocation; extend it when you add to the path.
- **One render path**: playback and export both go through
  `Renderer::process`, so what you hear is what you export.
- **Golden renders**: `crates/dawg-core/tests/golden.rs` compares scenes with
  WAVs in `tests/golden/`. A mismatch means the sound changed. Re-bless with
  `DAWG_BLESS=1 cargo test -p dawg-core --test golden` only when that was the
  intent, and say so in the commit.
- **Test signals** use integer arithmetic only (no `sin`) so goldens match on
  every platform.
- **Branches**: work on `dev` (or a feature branch into `dev`). `main` is
  release-only, fast-forwarded by the release skill.
- **Commits**: conventional (`feat:`, `fix:`, `refactor:`, `chore:` …); release
  notes are built from `feat`/`fix` subjects.
- **Updates reach every install**, so `.dawg` format changes stay additive and
  versioned, and the updater never restarts the app on its own. See
  `.claude/release.md` for the full breaker list.
- The release app id is `com.sph3ricalpeter.dawg`; dev builds
  (`tauri.dev.conf.json`, debug builds) report channel "dev" and never
  self-update.
