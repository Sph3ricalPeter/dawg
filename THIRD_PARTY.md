# Third-party code

dawg is MIT licensed. Two audio codecs it links have their own licenses:

- **LAME 3.100** (MP3 encoder), LGPL 2.0 or later, built from source by the
  `mp3lame-sys` crate (LGPL-3.0) and linked statically into dawg.exe.
  LAME's source: <https://lame.sourceforge.io/>. The repository is private
  and builds are for personal use. Before giving a build to anyone else,
  either ship LAME as a separate DLL or provide what the LGPL needs to relink
  dawg against another LAME.
- **Symphonia** (MP3 decoder), MPL-2.0, used unmodified from crates.io:
  <https://github.com/pdeljanov/Symphonia>.

MP3 patents have expired worldwide, so no patent license is needed.
