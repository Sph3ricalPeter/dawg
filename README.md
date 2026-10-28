# dawg

A simple, AI-enabled purpose-built DAW - Ableton UI with FL Studio UX and Audacity simplicity.

Windows only for now. Built with Tauri 2: a Rust audio engine (`crates/dawg-core`)
under a React UI.

## Install

Download `dawg_<version>_x64-setup.exe` from the
[latest release](https://github.com/Sph3ricalPeter/dawg/releases/latest) and run
it. The installer is unsigned, so SmartScreen warns the first time: More info,
then Run anyway. After that dawg updates itself: it checks GitHub Releases on
launch and every few hours, downloads quietly and shows "Restart to update".

## Develop

Needs Node 22, a stable Rust toolchain and, on Windows, the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2 and
the MSVC build tools).

```bash
npm install
npm run tauri dev      # app with hot reload
cargo test --workspace # unit, golden-render and allocation-guard tests
npm run build:dev      # installable "dawg dev" build, see below
```

`npm run build:dev` builds `target/release/bundle/nsis/dawg dev_<version>_x64-setup.exe`.
It installs as a separate app ("dawg dev", its own app id, its own Explorer
entry, updater off), so you can test a build without touching the released
install. CI also uploads this installer as an artifact on every push.

## Release

Work lands on `dev`; `main` only moves at release time. The user-level
`release` skill reads [`.claude/release.md`](.claude/release.md), bumps the
version, fast-forwards `main` and pushes a `vX.Y.Z` tag. The tag runs
`.github/workflows/release.yml`, which builds and signs the installer and
publishes the GitHub Release with `latest.json` for the updater.

### One-time setup

1. Generate the updater signing key (keep the private key and password safe;
   losing them means existing installs can't take updates):
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/dawg.key
   ```
2. Paste the contents of `~/.tauri/dawg.key.pub` into
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Add repo secrets `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/dawg.key`)
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Keep the repo public so the updater can download release assets.
