# Third-party code

dawg is MIT licensed. Two audio codecs it links have their own licenses:

- **LAME 3.100** (MP3 encoder), LGPL 2.0 or later, built from source by the
  `mp3lame-sys` crate (LGPL-3.0) and linked statically into dawg.exe. LGPL
  lets you swap in your own LAME: the full source of dawg is in this
  repository, so change or replace `mp3lame-sys`/LAME and rebuild with
  `npm run tauri build`. LAME's source: <https://lame.sourceforge.io/>.
- **Symphonia** (MP3 decoder), MPL-2.0, used unmodified from crates.io:
  <https://github.com/pdeljanov/Symphonia>.

MP3 patents have expired worldwide, so no patent license is needed.
