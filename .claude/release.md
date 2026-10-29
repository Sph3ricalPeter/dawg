# Release config

Read by the user-level `release` skill. Overrides its generic defaults.

## Version
Lives in three files that must match:
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`: stamped on the installer and
  compared by the updater against `latest.json`. `release.yml` refuses a tag
  that doesn't match it.
- `Cargo.toml` (workspace root) → `[workspace.package] version`, inherited by
  `dawg-core` and the app crate

Bump:
```bash
npm version <x.y.z> --no-git-tag-version   # package.json + package-lock.json
# edit src-tauri/tauri.conf.json and Cargo.toml by hand
cargo check --workspace                    # rewrites the dawg entries in Cargo.lock
```
Stage all five: `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`Cargo.toml`, `Cargo.lock`.

Bump commit message: `chore: bump version to <x.y.z>` (no `release:` prefix;
release notes are built from `feat`/`fix` subjects only).

## Branch and deploy
Work is committed straight to `dev`, no pull requests. Releases ship from
`main`, fast-forward only:
```bash
git checkout main && git merge dev --ff-only   # refuses? fetch; still refuses → investigate, never force
git tag -a v<x.y.z> -m "dawg v<x.y.z>"
git push origin main dev --follow-tags
git checkout dev
```
Never push straight to `main` with new commits.

Pushing the `v*.*.*` tag runs `.github/workflows/release.yml`:
1. Checks the tag matches `tauri.conf.json`, the updater pubkey is set and the
   signing secret exists.
2. Builds Windows x64 only (NSIS `dawg_<x.y.z>_x64-setup.exe`), signed for
   the updater, and publishes a **GitHub Release** "dawg vX.Y.Z" with the
   installer, its `.sig` and `latest.json`.
3. Release body is the top 5 `feat:` then `fix:` subjects in
   `<prev tag>..<tag>`; the tag message is not the user-facing note.

Pushing `main` and `dev` also runs `ci.yml`.

## Checks
```bash
npm run typecheck && npm run lint && npm run build
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```
`cargo test` includes the golden renders and the allocation guard. A golden
mismatch is a sound change: only re-bless (`DAWG_BLESS=1 cargo test -p
dawg-core --test golden`) if the commit meant to change the sound.

Before a release, install a local test build (`npm run build:dev`, installs as
"dawg dev" next to the real app) and try what changed.

## Classifier
Conventional commits (`feat:` → minor, `fix:` → patch, `refactor:`/`docs:`/`chore:`
→ patch). Bump minor for any `feat:`, patch otherwise. Pre-1.0: no majors.

## Commit convention
`<type>: <imperative subject>`, types `feat`, `fix`, `refactor`, `perf`, `docs`,
`test`, `chore`, `ci`.

## Breaker checks
- **Installed copies auto-update** from `latest.json`, so a bad release reaches
  every install. Anything that would lose work is a blocker.
- **`.dawg` project format**: changes must be additive and bump the format
  version; older projects must still open, and the autosave/recovery path must
  read files written by the previous release.
- **Replace original**: any change near export or the safe-replace sequence
  (temp file, Recycle Bin, rename) needs the null test and a manual replace on
  a scratch WAV before shipping.
- **MCP tools** (`dawg-cli mcp`, from M6): tool names and argument shapes stay
  backward compatible; agents cache them.
- **Installer hooks** (`src-tauri/windows/hooks.nsh`): the Explorer "Edit in
  dawg" key and the `dawg-cli.exe` taskkill. A broken hook breaks every update.
- **Updater**: never restarts on its own; `install()` only runs from the
  "Restart to update" click. Changing the updater pubkey strands every
  existing install.
- **Real-time path**: no allocation, locks or blocking in `Renderer::process`
  or the audio callback (the allocation guard covers the mixer, not new code
  you add around it).
- **CSP** in `tauri.conf.json`: a new origin works in `tauri dev` but is
  blocked in the bundled app if not listed.

## Verify
```bash
gh run list --limit 3                      # Release + CI green; on failure: gh run view <id> --log-failed
gh release view v<x.y.z> --json assets --jq '.assets[].name'   # -setup.exe, -setup.exe.sig, latest.json
curl -sL https://github.com/Sph3ricalPeter/dawg/releases/latest/download/latest.json | grep '"version"'
```
The release workflow takes about 10 to 15 minutes. A failed release: fix,
delete the tag locally and on origin, re-tag.

## After release
- Running copies find the update within an hour (or right away from the
  title-bar update button or menu → Check for updates), download it quietly
  and show "Restart to update".
