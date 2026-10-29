# dawg

Windows DAW for quick sound design: drag WAVs or MP3s onto tracks, shape
clips with volume envelopes, export WAV or MP3. "Edit in dawg" in Explorer
opens a file in a scratch session. AI works as a coproducer through MCP only (no in-app panel).

Plan and spec: the "dawg: design" Claude Doc. UI reference: the design mockup
(`design/mockup.html` in the project files).

## Layout

- `crates/dawg-core`: headless project model and mixer. No UI, no device I/O.
  The app, the future `dawg-cli` and the MCP server all drive it.
  `wav` (format-preserving RIFF codec), `mp3` (Symphonia decode, LAME
  encode, gapless, tags kept), `file` (WAV or MP3 behind one type, and
  converting between them), `save` (safe replace and backups),
  `command` (edits as serde data; tracks and clips by stable id), `session`
  (the session opened from a file, plus files added onto other tracks, with
  undo; exports the original's format while it is one clip, else a
  mixdown), `resample` (offline rate conversion for added files), `player`
  (the audio callback minus the device), `peaks`.
- `src-tauri`: the Tauri app crate (`dawg`). `commands.rs` (IPC),
  `audio.rs` (cpal output), plugins, installer config.
- `integrations/unity`: Unity package (git URL install) that opens audio clips in dawg on
  double-click.
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
- **One render path**: playback and mixdown export both go through
  `Renderer::process`, so what you hear is what you export. The one
  exception is saving an edited WAV (`wav::WavFile::render_clip`): it keeps
  the file's own format and copies untouched sample bytes, using the same
  `Clip::gain_at` as the renderer; `golden.rs::saved_file_matches_playback`
  holds the two together.
- **Never damage a user's file**: writes over an existing file go through
  `save::replace` (verified temp, backup, `ReplaceFileW`). An untouched
  file must save byte-identical and a crop must be a slice of the source
  bytes; `wav.rs` tests enforce both. MP3 can't avoid re-encoding an edit,
  but an untouched MP3 saves byte-identical and saving over one keeps its
  length, rate, bitrate and ID3 tags (`mp3.rs` and `session.rs` tests).
- **Licenses**: LAME (MP3 encoder) is LGPL and Symphonia is MPL-2.0; see
  `THIRD_PARTY.md`. Don't add GPL code.
- **Golden renders**: `crates/dawg-core/tests/golden.rs` compares scenes with
  WAVs in `tests/golden/`. A mismatch means the sound changed. Re-bless with
  `DAWG_BLESS=1 cargo test -p dawg-core --test golden` only when that was the
  intent, and say so in the commit.
- **Test signals** use integer arithmetic only (no `sin`) so goldens match on
  every platform.
- **No PRs, fast iteration**: Peter doesn't review code. Commit and push
  straight to `dev`; don't open pull requests or use feature branches. You
  are the reviewer: run the checks below and make CI green before moving on.
  Releases are checkpoints cut from `dev` with the user-level release skill
  (`.claude/release.md`); `main` only moves at release time, fast-forwarded.
- **Commits**: conventional (`feat:`, `fix:`, `refactor:`, `chore:` …); release
  notes are built from `feat`/`fix` subjects.
- **Updates reach every install**, so `.dawg` format changes stay additive and
  versioned, and the updater never restarts the app on its own. See
  `.claude/release.md` for the full breaker list.
- The release app id is `com.sph3ricalpeter.dawg`. "dawg dev"
  (`tauri.dev.conf.json`, `com.sph3ricalpeter.dawg.dev`) reports channel
  "dev". CI publishes every push to `dev` as a signed `x.y.z-dev.<run>` build
  to the rolling `dev-build` prerelease, and installed "dawg dev" copies
  update from it, so a push to `dev` reaches Peter's test install within the
  hour: keep `dev` working. Local and debug builds never self-update.
