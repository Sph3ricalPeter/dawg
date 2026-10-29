//! Writing over files people care about.
//!
//! [`replace`] never leaves a half-written file or a missing one:
//!
//! 1. Write a temp file in the same folder and flush it to disk.
//! 2. Read it back and compare it with what we meant to write.
//! 3. Copy the original into dawg's backup folder (`Restore last replace`).
//! 4. Swap with `ReplaceFileW` on Windows, which keeps the original's
//!    creation time, permissions and streams; `rename` elsewhere.
//! 5. Read the result back once more.
//!
//! A file another program holds open fails with [`SaveError::InUse`] and the
//! original is left as it was.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Size and modification time, to notice a file changing under us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub(crate) len: u64,
    pub(crate) modified: Option<SystemTime>,
}

impl FileStamp {
    pub fn of(path: &Path) -> io::Result<FileStamp> {
        let m = fs::metadata(path)?;
        Ok(FileStamp {
            len: m.len(),
            modified: m.modified().ok(),
        })
    }
}

#[derive(Debug)]
pub enum SaveError {
    /// Another program has the file open.
    InUse,
    /// The file changed on disk since it was opened.
    ChangedOnDisk,
    /// What reached the disk is not what was written.
    VerifyFailed,
    Io(io::Error),
}

impl SaveError {
    /// Short machine-readable kind for the UI and agents.
    pub fn kind(&self) -> &'static str {
        match self {
            SaveError::InUse => "in_use",
            SaveError::ChangedOnDisk => "changed_on_disk",
            SaveError::VerifyFailed => "verify_failed",
            SaveError::Io(_) => "io",
        }
    }
}

impl fmt::Display for SaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SaveError::InUse => write!(
                f,
                "the file is open in another program; close it there and try again, or save as a new file"
            ),
            SaveError::ChangedOnDisk => write!(
                f,
                "the file changed on disk since dawg opened it; save as a new file instead"
            ),
            SaveError::VerifyFailed => {
                write!(f, "the written file didn't read back correctly; nothing was replaced")
            }
            SaveError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SaveError {}

impl From<io::Error> for SaveError {
    fn from(e: io::Error) -> Self {
        if is_sharing_violation(&e) {
            SaveError::InUse
        } else {
            SaveError::Io(e)
        }
    }
}

#[cfg(windows)]
fn is_sharing_violation(e: &io::Error) -> bool {
    // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_USER_MAPPED_FILE
    matches!(e.raw_os_error(), Some(32 | 33 | 1224))
}

#[cfg(not(windows))]
fn is_sharing_violation(_: &io::Error) -> bool {
    false
}

/// What [`replace`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub original: PathBuf,
    /// The copy of the previous contents.
    pub backup: PathBuf,
}

/// How long backups are kept.
pub const BACKUP_DAYS: u64 = 14;
const LAST_REPLACE: &str = "last-replace.json";

static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn sibling(path: &Path, tag: &str) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.dawg-{tag}-{}-{n}", std::process::id()))
}

/// Writes `bytes` to a new temp file next to `path`, flushed and read back.
fn write_verified_temp(path: &Path, bytes: &[u8]) -> Result<PathBuf, SaveError> {
    let tmp = sibling(path, "tmp");
    let result = (|| {
        let mut f = File::create_new(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if fs::read(&tmp)? != bytes {
            return Err(SaveError::VerifyFailed);
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Saves `bytes` as a new file at `path`. Fails if something is already
/// there; use [`replace`] for that.
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    if path.exists() {
        return Err(SaveError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        )));
    }
    let tmp = write_verified_temp(path, bytes)?;
    // Not `rename`: it would overwrite a file created in the meantime.
    let r = fs::hard_link(&tmp, path).or_else(|_| fs::copy(&tmp, path).map(|_| ()));
    let _ = fs::remove_file(&tmp);
    r?;
    if fs::read(path)? != bytes {
        return Err(SaveError::VerifyFailed);
    }
    Ok(())
}

/// Replaces the file at `path` with `bytes`, keeping a backup of the old
/// contents in `backup_dir`. With `expect`, refuses if the file is no longer
/// the one that was opened.
pub fn replace(
    path: &Path,
    bytes: &[u8],
    backup_dir: &Path,
    expect: Option<FileStamp>,
) -> Result<Replaced, SaveError> {
    if let Some(stamp) = expect {
        if FileStamp::of(path)? != stamp {
            return Err(SaveError::ChangedOnDisk);
        }
    }
    let tmp = write_verified_temp(path, bytes)?;
    let result = (|| {
        let backup = backup(path, backup_dir)?;
        swap(path, &tmp)?;
        if fs::read(path)? != bytes {
            return Err(SaveError::VerifyFailed);
        }
        let replaced = Replaced {
            original: path.to_path_buf(),
            backup,
        };
        // Best effort: losing the note only loses the menu shortcut, the
        // backup itself is already on disk.
        if let Ok(json) = serde_json::to_vec_pretty(&replaced) {
            let _ = fs::write(backup_dir.join(LAST_REPLACE), json);
        }
        Ok(replaced)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Writes dawg's own file (a project) at `path`, new or over the last
/// version, through the same verified temp file and swap as [`replace`] but
/// with no backup: the previous version is ours, and keeping it would make
/// it the target of `Restore last replace`.
pub fn overwrite(path: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    if !path.exists() {
        return write_new(path, bytes);
    }
    let tmp = write_verified_temp(path, bytes)?;
    let result = swap(path, &tmp).and_then(|()| {
        if fs::read(path)? != bytes {
            return Err(SaveError::VerifyFailed);
        }
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The most recent [`replace`] whose backup still exists.
pub fn last_replace(backup_dir: &Path) -> Option<Replaced> {
    let json = fs::read(backup_dir.join(LAST_REPLACE)).ok()?;
    let r: Replaced = serde_json::from_slice(&json).ok()?;
    r.backup.is_file().then_some(r)
}

/// Puts the last replaced file back as it was. The version being undone is
/// itself backed up first, so restoring twice swaps back.
pub fn restore_last(backup_dir: &Path) -> Result<Replaced, SaveError> {
    let last = last_replace(backup_dir).ok_or_else(|| {
        SaveError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            "there is no replaced file to restore",
        ))
    })?;
    let bytes = fs::read(&last.backup)?;
    replace(&last.original, &bytes, backup_dir, None)
}

/// Deletes backups older than [`BACKUP_DAYS`]. Returns how many went.
pub fn prune_backups(backup_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(backup_dir) else {
        return 0;
    };
    let cutoff = SystemTime::now() - Duration::from_secs(BACKUP_DAYS * 24 * 3600);
    let mut n = 0;
    for e in entries.flatten() {
        if e.file_name() == LAST_REPLACE {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t < cutoff);
        if old && fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

fn backup(path: &Path, backup_dir: &Path) -> Result<PathBuf, SaveError> {
    fs::create_dir_all(backup_dir)?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut dest = backup_dir.join(format!("{ms}-{name}"));
    let mut k = 1;
    while dest.exists() {
        dest = backup_dir.join(format!("{ms}-{k}-{name}"));
        k += 1;
    }
    fs::copy(path, &dest)?;
    // A backup that isn't really there is worse than none.
    if fs::metadata(&dest)?.len() != fs::metadata(path)?.len() {
        let _ = fs::remove_file(&dest);
        return Err(SaveError::VerifyFailed);
    }
    // Copies keep the original's mtime on some platforms; pruning goes by
    // when the backup was made.
    let _ = File::options()
        .write(true)
        .open(&dest)
        .and_then(|f| f.set_modified(SystemTime::now()));
    Ok(dest)
}

#[cfg(windows)]
fn swap(path: &Path, tmp: &Path) -> Result<(), SaveError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, REPLACEFILE_IGNORE_MERGE_ERRORS,
    };

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    // ReplaceFileW can leave the original under the backup name when the
    // final move fails, so give it one we can move back from.
    let old = sibling(path, "old");
    let (p, t, o) = (wide(path), wide(tmp), wide(&old));
    // SAFETY: all three are NUL-terminated UTF-16 paths that outlive the call.
    let ok = unsafe {
        ReplaceFileW(
            p.as_ptr(),
            t.as_ptr(),
            o.as_ptr(),
            REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok != 0 {
        let _ = fs::remove_file(&old);
        return Ok(());
    }
    let err = io::Error::last_os_error();
    // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the original now sits at `old`.
    if err.raw_os_error() == Some(1177) && !path.exists() {
        // SAFETY: as above.
        unsafe { MoveFileExW(o.as_ptr(), p.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    }
    match err.raw_os_error() {
        // ERROR_ACCESS_DENIED / ERROR_UNABLE_TO_REMOVE_REPLACED: usually
        // another program holding the file.
        Some(5 | 1175) => Err(SaveError::InUse),
        _ => Err(err.into()),
    }
}

#[cfg(not(windows))]
fn swap(path: &Path, tmp: &Path) -> Result<(), SaveError> {
    // Keep the original's permissions, like ReplaceFileW does.
    if let Ok(m) = fs::metadata(path) {
        let _ = fs::set_permissions(tmp, m.permissions());
    }
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Dir {
            let d = std::env::temp_dir().join(format!(
                "dawg-save-{name}-{}-{}",
                std::process::id(),
                TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Dir(d)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".dawg-"))
            .collect()
    }

    #[test]
    fn replace_keeps_a_backup_and_restores_it() {
        let d = Dir::new("replace");
        let file = d.0.join("kick.wav");
        let backups = d.0.join("backups");
        fs::write(&file, b"old contents").unwrap();
        let stamp = FileStamp::of(&file).unwrap();

        let r = replace(&file, b"new", &backups, Some(stamp)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        assert_eq!(fs::read(&r.backup).unwrap(), b"old contents");
        assert_eq!(last_replace(&backups), Some(r));
        assert!(leftovers(&d.0).is_empty());

        restore_last(&backups).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"old contents");
        // Restoring again swaps back.
        restore_last(&backups).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
    }

    #[test]
    fn replace_refuses_a_file_that_changed() {
        let d = Dir::new("changed");
        let file = d.0.join("a.wav");
        fs::write(&file, b"one").unwrap();
        let stamp = FileStamp::of(&file).unwrap();
        fs::write(&file, b"three").unwrap();
        let e = replace(&file, b"x", &d.0.join("b"), Some(stamp)).unwrap_err();
        assert_eq!(e.kind(), "changed_on_disk");
        assert_eq!(fs::read(&file).unwrap(), b"three");
        assert!(leftovers(&d.0).is_empty());
    }

    #[test]
    fn write_new_never_overwrites() {
        let d = Dir::new("new");
        let file = d.0.join("out.wav");
        write_new(&file, b"abc").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"abc");
        assert!(write_new(&file, b"zzz").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"abc");
        assert!(leftovers(&d.0).is_empty());
    }

    #[test]
    fn prune_keeps_recent_backups() {
        let d = Dir::new("prune");
        fs::write(d.0.join("1-a.wav"), b"x").unwrap();
        let old = d.0.join("2-b.wav");
        fs::write(&old, b"x").unwrap();
        File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs((BACKUP_DAYS + 1) * 86_400))
            .unwrap();
        assert_eq!(prune_backups(&d.0), 1);
        assert!(d.0.join("1-a.wav").exists());
        assert!(!old.exists());
    }
}
