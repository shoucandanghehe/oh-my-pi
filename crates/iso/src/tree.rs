//! Helpers shared by the backends that materialize `merged` as a real
//! directory tree (rcopy, Linux reflink, Windows block clone) and by the
//! backends that validate a `lower` source directory.

use std::{
	ffi::OsStr,
	fs::{self, FileType},
	io,
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

/// Resolves `path` against the current directory, checks that it is a
/// directory, and canonicalizes it when possible. `what` names the source in
/// error messages; `make_err` picks the error class, since some backends
/// report a bad source as unavailable so the caller falls back.
pub fn canonical_existing_dir(
	path: &Path,
	what: &str,
	make_err: fn(String) -> IsoError,
) -> IsoResult<PathBuf> {
	let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
	let meta = fs::metadata(&resolved)
		.map_err(|err| make_err(format!("invalid {what} {}: {err}", resolved.display())))?;
	if !meta.is_dir() {
		return Err(make_err(format!("{what} {} is not a directory", resolved.display())));
	}
	Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Resolve existing ancestors too, so a destination below a symlink is compared
/// to the canonical source before anything at the destination is removed.
pub fn resolve_path(path: &Path) -> IsoResult<PathBuf> {
	let absolute = std::path::absolute(path)
		.map_err(|err| IsoError::other(format!("resolve {}: {err}", path.display())))?;
	let mut resolved = PathBuf::new();
	let mut components = absolute.components().peekable();
	while let Some(component) = components.next() {
		match component {
			std::path::Component::ParentDir => {
				resolved.pop();
			},
			std::path::Component::CurDir => {},
			component => resolved.push(component),
		}
		if components.peek().is_some()
			&& let Ok(canonical) = fs::canonicalize(&resolved)
		{
			resolved = canonical;
		}
	}
	Ok(resolved)
}

/// Convert absolute storage paths to precise source-relative exclusions.
/// The destination itself is always excluded when it is inside the source.
pub fn relative_exclusions(
	lower: &Path,
	merged: &Path,
	exclude_paths: &[PathBuf],
) -> IsoResult<Vec<PathBuf>> {
	let lower = canonical_existing_dir(lower, "isolation source", IsoError::other)?;
	let merged = resolve_path(merged)?;
	if lower.starts_with(&merged) {
		return Err(IsoError::other("isolation destination must not contain the source"));
	}
	let mut excluded = Vec::new();
	for path in exclude_paths.iter().chain(std::iter::once(&merged)) {
		if !path.is_absolute() {
			return Err(IsoError::other(format!("exclusion must be absolute: {}", path.display())));
		}
		let path = resolve_path(path)?;
		if let Ok(relative) = path.strip_prefix(&lower) {
			if relative.as_os_str().is_empty() {
				return Err(IsoError::other("cannot exclude the entire isolation source"));
			}
			if !excluded
				.iter()
				.any(|parent: &PathBuf| relative.starts_with(parent))
			{
				excluded.retain(|child: &PathBuf| !child.starts_with(relative));
				excluded.push(relative.to_path_buf());
			}
		}
	}
	Ok(excluded)
}

/// Remove exclusions only from an independent snapshot, never through a
/// symlink in that snapshot into the source or an unrelated directory.
pub fn remove_exclusions(merged: &Path, excluded: &[PathBuf]) -> IsoResult<()> {
	for relative in excluded {
		let mut parent = merged.to_path_buf();
		let mut reachable = true;
		for component in relative.parent().into_iter().flat_map(Path::components) {
			parent.push(component);
			match fs::symlink_metadata(&parent) {
				Ok(meta) if meta.is_dir() => {},
				Ok(_) => {
					reachable = false;
					break;
				},
				Err(err) if err.kind() == io::ErrorKind::NotFound => {
					reachable = false;
					break;
				},
				Err(err) => {
					return Err(IsoError::other(format!("inspect {}: {err}", parent.display())));
				},
			}
		}
		if reachable {
			let path = merged.join(relative);
			remove_existing(&path)
				.map_err(|err| IsoError::other(format!("remove excluded {}: {err}", path.display())))?;
		}
	}
	Ok(())
}

/// Creates `merged`'s parent and clears whatever is at `merged` with `remove`,
/// so the walk starts from a fresh destination. `what` names the backend in
/// the error message.
pub fn prepare_destination(
	merged: &Path,
	what: &str,
	remove: impl FnOnce(&Path) -> io::Result<()>,
) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	remove(merged).map_err(|err| {
		IsoError::other(format!("unable to clear {} before {what}: {err}", merged.display()))
	})
}

/// Removes the directory tree, file, or symlink at `path`; a missing path is
/// not an error.
pub fn remove_existing(path: &Path) -> io::Result<()> {
	let result = match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
		Ok(_) => fs::remove_file(path),
		Err(err) => Err(err),
	};
	match result {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}

/// Recreates the symlink `src` at `dst` with the same target. `file_type` is
/// `src`'s own (unfollowed) type; Windows needs it to pick a directory or
/// file link.
pub fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
	let target = fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	#[cfg(unix)]
	let res = {
		let _ = file_type;
		std::os::unix::fs::symlink(target, dst)
	};
	#[cfg(windows)]
	let res = if std::os::windows::fs::FileTypeExt::is_symlink_dir(&file_type) {
		std::os::windows::fs::symlink_dir(target, dst)
	} else {
		std::os::windows::fs::symlink_file(target, dst)
	};
	#[cfg(not(any(unix, windows)))]
	let res: io::Result<()> = {
		let _ = (target, file_type);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symlink copy unsupported on this platform"))
	};
	res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

/// Per-entry actions of [`copy_dir_contents`].
pub trait TreeCopy {
	/// Recreates the symlink `src` at `dst`.
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Copies any entry that is neither a directory nor a symlink.
	fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Clone an entire directory when it contains no exclusions. Return false
	/// to have the walker create it and visit its entries instead.
	fn directory(&self, _src: &Path, _dst: &Path) -> IsoResult<bool> {
		Ok(false)
	}
	/// Runs after the directory `dst` has been filled from `src`.
	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()>;
}

/// Copies `src` into `dst`, omitting source-relative paths in `skip` and the
/// destination itself. Symlinks are recreated, never followed.
pub fn copy_dir_contents(
	src: &Path,
	dst: &Path,
	skip: &[&OsStr],
	copy: &impl TreeCopy,
) -> IsoResult<()> {
	let exclude_paths = skip.iter().map(|path| src.join(path)).collect::<Vec<_>>();
	let excluded = relative_exclusions(src, dst, &exclude_paths)?;
	copy_dir_contents_inner(src, dst, Path::new(""), &excluded, copy)
}

fn copy_dir_contents_inner(
	src: &Path,
	dst: &Path,
	relative: &Path,
	excluded: &[PathBuf],
	copy: &impl TreeCopy,
) -> IsoResult<()> {
	let entries = fs::read_dir(src)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
		let name = entry.file_name();
		let relative_path = relative.join(&name);
		if excluded.iter().any(|path| relative_path.starts_with(path)) {
			continue;
		}
		let src_path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src_path.display())))?;
		let dst_path = dst.join(&name);
		if file_type.is_symlink() {
			copy.symlink(&src_path, &dst_path, file_type)?;
		} else if file_type.is_dir() {
			if !excluded.iter().any(|path| path.starts_with(&relative_path))
				&& copy.directory(&src_path, &dst_path)?
			{
				continue;
			}
			fs::create_dir_all(&dst_path)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
			copy_dir_contents_inner(&src_path, &dst_path, &relative_path, excluded, copy)?;
			copy.finish_dir(&src_path, &dst_path)?;
		} else {
			copy.file(&src_path, &dst_path, file_type)?;
		}
	}
	Ok(())
}
