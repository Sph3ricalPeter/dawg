# dawg

Windows DAW for quick sound design: drag WAVs or MP3s onto tracks, shape
clips with volume envelopes, export WAV or MP3. "Edit in dawg" in Explorer
opens a file in a scratch session. AI works as a coproducer through MCP only (no in-app panel).

Plan and spec: the "dawg: design" Claude Doc. UI reference: the design mockup
(`design/mockup.html` in the project files).

## Layout

- `crates/dawg-core`: headless project model and mixer. No UI, no device I/O.
  The app and `dawg-cli` (with its MCP server) both drive it.
  `wav` (format-preserving RIFF codec), `mp3` (Symphonia decode, LAME
  encode, gapless, tags kept), `file` (WAV or MP3 behind one type, and
  converting between them), `save` (safe replace and backups),
  `command` (edits as serde data; tracks and clips by stable id), `category`
  (track categories: Drums, Bass…; the UI's `lib/categories.ts` mirrors the
  list and maps Browser Type labels to them), `session`
  (a scratch session opened from a file, or a project, plus files added onto
  other tracks, with undo; a scratch session exports the original's format
  while it is one clip, else a mixdown), `project_file` (the versioned
  `.dawg` JSON format: relative and absolute source paths, missing files open
  as silence and can be relinked), `resample` (offline rate conversion for added files),
  `stretch` (offline clip time-stretch and pitch-shift: a phase vocoder cut
  at onsets; a clip keeps the result in `Clip::audio`), `eq` (the EQ
  device's biquads), `device` (a channel's chain: EQ, Compressor,
  Utility, each with an id, power and a sidechain input), `analysis`
  (peak, LUFS, onsets, centroid: what an agent "hears"), `player`
  (the audio callback minus the device, plus the EQ analyser's tap and
  compressor gain reduction), `peaks`. Every track is a mixer channel
  (`lane: false` is a mixer-only bus or return): clips and incoming sends
  → chain → volume, pan → sends (`Track::sends`, to channels or `MASTER`,
  id 0, which has a chain too). The renderer runs channels in a
  topological order; sends and sidechains must stay a DAG
  (`Project::would_loop`).
- `crates/dawg-cli`: `dawg-cli` for scripts (info, analyze, render a
  waveform PNG, trim/gain/normalize as dry runs until `--yes` or `--out`,
  export) and `dawg-cli mcp`, the MCP server (`mcp.rs`, JSON-RPC on stdio):
  open/import/apply commands as one "AI: ..." undo step, analyze,
  render_image, export, save, get_selection. `pipe.rs`: when a dawg window
  is open, `dawg-cli mcp` runs each tool there instead (a per-user local
  pipe named after the app id, `src-tauri/src/agent.rs`), so edits land
  live and the UI shows them (AI chip, `AI` history badge). `tools.rs` is
  shared by both sides, including takes (`begin_take`/`end_take`: applies
  fold into one "AI: ..." step via `Session::merge_last`). Backups go to
  the app's own backups folder. The installer ships `dawg-cli.exe` next to
  `dawg.exe`: `beforeBundleCommand` builds it and `windows/hooks.nsh`
  installs it.
- `src-tauri`: the Tauri app crate (`dawg`). `commands.rs` (IPC; the
  open sessions as tabs, one in front: edits, playback and agent calls go to
  the front tab, and opening a file gets a tab of its own unless the front
  one is a blank project), `autosave.rs` (one snapshot per unsaved tab;
  what a crash leaves is set aside as `recovered-*` and reopens as tabs),
  `audio.rs` (cpal output; a Browser preview swaps a one-file project into
  the player and the session's comes back on the next Play), `browser.rs`
  (folder listings, search, preview decode), `recent.rs` (recent projects), `settings.rs` (UI settings file), plugins,
  installer config (`windows/hooks.nsh`: "Edit in dawg" and the `.dawg`
  file association).
- `integrations/unity`: Unity package (git URL install) that opens audio clips in dawg on
  double-click.
- `src`: React + TypeScript UI (Vite). Plain CSS: design tokens (colours,
  type scale, radii, gaps, shadows) in `src/tokens.css`, never literals in
  `src/styles.css` or components; canvas code reads them with `token()` /
  `alpha()` from `src/ui/tokens.ts`, and colours that are data (the clip
  palette, label colours) live in `src/ui/palette.ts`. Zustand stores in
  `src/stores`. App-wide UI settings (the
  panel layout, Browser folders and pins, units, snap, loop, envelope edit,
  History and export choices) go through `lib/settings.ts`, saved to `settings.json` in the app's
  data folder (`src-tauri/src/settings.rs`), not localStorage; per-project
  state belongs in the project file. The window-state plugin keeps the
  window's size and position. How each file was last shown (zoom, scroll,
  track heights, playhead, range) is `lib/view-memory.ts`, saved per file
  path to `views.json` beside the settings; session tabs keep one `SavedView`
  per tab.
  Panels: the Browser, Timeline, Mixer and Chain dock and float (`lib/layout.ts` is
  the pure dock tree and presets, `stores/layout-store.ts` saves it as
  `layout`, `lib/dock.ts` holds the panel hosts, actions and header drag,
  `components/Dock.tsx` renders it). Each panel renders once, through a
  portal, into a host element that moves between slots, so docking never
  remounts it; give a new panel a `PanelHead` and an entry in `PANELS`.
  Design system: `src/ui` holds the shared components the screens are
  built from: `Knob` and `KnobField` (a knob with its value and name),
  `Volume` (the one volume control, knob, dB and meter, for the master,
  every track and the mixer's strips), `LevelMeter` and `meter-law.ts`
  (every meter's scale, colours and canvas drawing), `Menu`/`PopMenu`/
  `MenuItem`/`MenuLabel`/`MenuSep`/`MenuNote`, `useDismiss` (outside click
  and Escape), `Dialog`, `Button`/`ToolButton`/`CloseButton`/`PowerButton`
  and `Icon` (named icons). Their CSS is `src/ui/ui.css`. Build new UI from
  these and add a variant here rather than restyling one on a screen; a
  new shared component goes in `src/ui`, `ui.css` and the gallery
  (`npm run dev`, then `/gallery.html`; dev only, not shipped). The rules
  are in `design/design-system.md` in the project files.
  Mixer and chain: `components/ChainPanel.tsx` (the selected channel's
  device cards; bodies in `Devices.tsx`), `components/MixerPanel.tsx`
  (strips, route row, cables, meters drawn on one canvas),
  `RouteMenus.tsx` (sends, sidechain, add device), `lib/mixer.ts` (channel
  numbers, loop checks as the engine's), `lib/chain-edit.ts` (edits as
  drafts while dragging). The mixer is one fixed design (narrow strips,
  compact volume, cables always shown): don't add layout options. Knob
  colours mean a concern: `--k-vol` level, `--k-pan` stereo, `--k-time`
  time and shape. No AI-specific UI in either panel.
  Tabs: `components/Tabs.tsx` is the row in the title bar; the session
  store keeps the front tab's `session` and, per tab in the back, what it
  was left showing (view, playhead, selection, EQ), and the waveform cache
  is keyed by tab, since source ids repeat between sessions. A tab can be
  renamed (double-click): a label in the store only, which "Save as" and
  Export start from; the file keeps its name.
  Waveforms: `lib/wave-tiles.ts` draws clip waveforms from power-of-two
  peak levels rendered once into cached tiles fixed in time, drawn by
  workers (`lib/wave-worker.ts`, shared drawing in `lib/wave-draw.ts`); a zoom only
  scales and cross-fades two levels' tiles, so draw nothing per pixel per
  frame there, and don't resize a canvas on every frame (it reallocates).
  Browser library: labels and favourites are a layer over the folders,
  never written into them. `lib/labels.ts` has the built-in labels (Type,
  Shape, Character, Status: each a stable id, name, group, palette colour
  and icon) and the `#label ★` search syntax; `stores/library-store.ts` keeps
  custom labels and each file's labels and star, saved to `library.json`
  beside the settings. Track categories should read Type labels from there.
  The Browser UI for them is `components/BrowserLabels.tsx`.
  Tooltips: put `data-tip` on an element, not `title`; `components/Tooltip.tsx`
  is the one styled tooltip (a stray `title` is converted on hover). `data-hint`
  is the status bar's longer hint.
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
- **No clicks from live changes**: a new project snapshot never steps the
  sound. `Renderer` ramps volume, pan, mute/solo, clip gain and master over
  `RAMP_SECONDS`, crossfades a changed EQ over `EQ_FADE_SECONDS`, fades devices in and out
  as they're added, removed or bypassed, ramps sends and compressor
  settings, and
  crossfades a track whose clips sound different (moved, trimmed,
  stretched, faded, enveloped, added, deleted, or the track added or
  deleted) from the old clips to the new over `EDIT_FADE_SECONDS`, before
  its EQ; edits arriving mid-crossfade queue up, newest wins. Track mix
  state follows the track id, so deleting or moving a track doesn't reset
  the others. A jump fades out and in (`SEEK_FADE_SECONDS`). A new live
  value goes through the same ramps, and values holding still must render
  exactly as before.
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
