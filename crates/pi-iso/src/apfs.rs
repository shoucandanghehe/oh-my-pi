//! macOS APFS clonefile-based isolation.
//!
//! `clonefile(2)` recursively reflinks an entire directory tree in a single
//! syscall. Both paths share the same on-disk blocks until either side is
//! modified; the kernel handles per-block copy-on-write. The destination is
//! a fully independent directory tree from the caller's perspective — there
//! is no mount to undo, so [`stop`](IsolationBackend::stop) is a recursive
//! remove.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "macos"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct ApfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&ApfsBackend
}

#[async_trait]
impl IsolationBackend for ApfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Apfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "macos")]
		{
			ProbeResult::available()
		}
		#[cfg(not(target_os = "macos"))]
		{
			ProbeResult::unavailable("APFS clonefile isolation is only available on macOS")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		self.start_excluding(lower, merged, &[])
	}

	fn start_excluding(
		&self,
		lower: &Path,
		merged: &Path,
		exclude_paths: &[std::path::PathBuf],
	) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			let excluded = crate::tree::relative_exclusions(lower, merged, exclude_paths)?;
			if excluded.is_empty() {
				imp::start(lower, merged)
			} else {
				let skip = excluded
					.iter()
					.map(|path| path.as_os_str())
					.collect::<Vec<_>>();
				imp::clone_tree(lower, merged, &skip)
			}
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged, exclude_paths);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{
		fs::{self, FileTimes, FileType},
		path::Path,
	};

	use crate::{
		IsoError, IsoResult,
		cow::{self, CLONE_NOFOLLOW},
		tree::{self, TreeCopy},
	};

	/// Classifies a failed `clonefile` of `src` to `dst`.
	fn clone_error(src: &Path, dst: &Path, err: &std::io::Error) -> IsoError {
		if cow::is_unsupported(err) {
			return IsoError::unavailable(format!(
				"APFS clonefile unsupported on this volume ({err}); {} -> {}",
				src.display(),
				dst.display()
			));
		}
		IsoError::other(format!("clonefile {} -> {}: {err}", src.display(), dst.display()))
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		tree::relative_exclusions(&lower, merged, &[])?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		// `clonefile` refuses to overwrite. Drop any stale tree first.
		if merged.exists() {
			fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!("unable to clear {} before clone: {err}", merged.display()))
			})?;
		}

		// A directory source clones the whole tree in one call.
		cow::clonefile(&lower, merged, 0).map_err(|err| clone_error(&lower, merged, &err))
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		tree::relative_exclusions(&lower, merged, &[])?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		if merged.exists() {
			if fs::read_dir(merged)
				.map_err(|err| IsoError::other(format!("read_dir {}: {err}", merged.display())))?
				.next()
				.is_some()
			{
				return Err(IsoError::other(format!(
					"clone destination {} is not empty",
					merged.display()
				)));
			}
		} else {
			fs::create_dir(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
		}

		let result = (|| {
			tree::copy_dir_contents(&lower, merged, skip, &Apfs)?;
			Apfs.finish_dir(&lower, merged)?;
			Ok(())
		})();
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	struct Apfs;

	impl TreeCopy for Apfs {
		fn symlink(&self, src: &Path, dst: &Path, _file_type: FileType) -> IsoResult<()> {
			cow::clonefile(src, dst, CLONE_NOFOLLOW).map_err(|err| clone_error(src, dst, &err))
		}

		fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			// Sockets, fifos, and devices are process-owned ephemera.
			if file_type.is_file() {
				cow::clonefile(src, dst, CLONE_NOFOLLOW).map_err(|err| clone_error(src, dst, &err))?;
			}
			Ok(())
		}

		fn directory(&self, src: &Path, dst: &Path) -> IsoResult<bool> {
			cow::clonefile(src, dst, CLONE_NOFOLLOW).map_err(|err| clone_error(src, dst, &err))?;
			Ok(true)
		}

		fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
			let meta = fs::metadata(src)
				.map_err(|err| IsoError::other(format!("metadata {}: {err}", src.display())))?;
			fs::set_permissions(dst, meta.permissions())
				.map_err(|err| IsoError::other(format!("permissions {}: {err}", dst.display())))?;
			if let Ok(modified) = meta.modified() {
				let _ = fs::File::open(dst)
					.and_then(|dir| dir.set_times(FileTimes::new().set_modified(modified)));
			}
			Ok(())
		}
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		match fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!(
				"unable to remove cloned tree {}: {err}",
				merged.display()
			))),
		}
	}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
	use std::{
		ffi::OsStr,
		fs,
		os::unix::{ffi::OsStrExt, fs::symlink},
	};

	use super::*;

	#[test]
	fn clone_tree_skips_top_level_entry_and_preserves_symlink() {
		let nonce = format!(
			"pi-iso-clone-tree-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		);
		let root = std::env::temp_dir().join(nonce);
		let lower = root.join("lower");
		let merged = root.join("merged");
		fs::create_dir_all(lower.join("nested")).unwrap();
		fs::create_dir_all(lower.join(".git")).unwrap();
		fs::write(lower.join("file"), "file").unwrap();
		fs::write(lower.join("nested/child"), "child").unwrap();
		fs::write(lower.join(".git/config"), "skip").unwrap();
		symlink("file", lower.join("link")).unwrap();
		// Special files at the checkout root (debug sockets, fifos) are
		// rejected by `clonefile` with EINVAL and must be skipped, not fatal.
		let fifo = std::ffi::CString::new(lower.join("debug.fifo").as_os_str().as_bytes()).unwrap();
		// SAFETY: `fifo` is a valid NUL-terminated path that outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

		let result = backend().clone_tree(&lower, &merged, &[OsStr::new(".git")]);
		if matches!(result, Err(crate::IsoError::Unavailable(_))) {
			let _ = fs::remove_dir_all(root);
			return;
		}
		result.unwrap();
		assert!(!merged.join(".git").exists());
		assert!(fs::symlink_metadata(merged.join("debug.fifo")).is_err());
		assert_eq!(fs::read_to_string(merged.join("file")).unwrap(), "file");
		assert_eq!(fs::read_to_string(merged.join("nested/child")).unwrap(), "child");
		assert_eq!(fs::read_link(merged.join("link")).unwrap(), std::path::Path::new("file"));
		assert!(
			fs::symlink_metadata(merged.join("link"))
				.unwrap()
				.file_type()
				.is_symlink()
		);
		fs::remove_dir_all(root).unwrap();
	}
}
