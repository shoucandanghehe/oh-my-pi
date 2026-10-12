//! Cross-platform fallback isolation: git worktree, or plain recursive copy.
//!
//! When `lower` is a git working tree, [`start`](IsolationBackend::start)
//! materializes `merged` via `git worktree add --detach <merged> HEAD`.
//! Stop tears it down with `git worktree remove --force`. This lets git
//! itself manage refs/index/HEAD inside `merged`, keeping
//! [`diff`](IsolationBackend::diff) on the `git diff` path.
//!
//! Otherwise we do a vanilla recursive copy, preserving file modes and
//! mtimes so the default mtime-skipping diff path stays fast. There is no
//! file-system magic; the caller pays full filesystem-copy cost up front
//! and an `rm -rf` on teardown.

use std::{
	ffi::OsStr,
	fmt,
	fs::FileType,
	io::{self, Write as _},
	path::Path,
	process::{Child, ChildStdin, Command, Output, Stdio},
	sync::{
		Arc, Mutex, PoisonError,
		mpsc::{self, Receiver},
	},
	thread,
	time::{Duration, Instant},
};

use async_trait::async_trait;

use crate::{
	BackendKind, IsoError, IsoResult, IsolationBackend, ProbeResult, command_failed,
	tree::{self, TreeCopy},
};

pub struct RcopyBackend;

#[async_trait]
impl IsolationBackend for RcopyBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Rcopy
	}

	fn probe(&self) -> ProbeResult {
		// Pure-stdlib fallback path is always available. We don't probe for
		// `git` here because the non-git branch doesn't need it; the git
		// branch will surface a clear unavailable-error if `lower` is a git
		// tree but `git` is missing from PATH.
		ProbeResult::available()
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
		let lower = tree::canonical_existing_dir(lower, "rcopy source", IsoError::other)?;
		let merged = tree::resolve_path(merged)?;
		let excluded = tree::relative_exclusions(&lower, &merged, exclude_paths)?;
		tree::prepare_destination(&merged, "rcopy", tree::remove_existing)?;
		if is_git_worktree(&lower) {
			git_worktree_add(&lower, &merged)?;
			// `worktree add --detach HEAD` lands on a clean checkout. omp
			// (and friends) expect `merged` to mirror `lower`'s **live**
			// working tree, so seed the index + working tree + untracked
			// files exactly as they exist in lower. No applyBaseline call
			// in the caller — every backend's post-`start` invariant is
			// the same.
			seed_dirty_state(&lower, &merged, &excluded)?;
			tree::remove_exclusions(&merged, &excluded)
		} else {
			let skip = excluded
				.iter()
				.map(|path| path.as_os_str())
				.collect::<Vec<_>>();
			recursive_copy(&lower, &merged, &skip)
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		// Best-effort: if we recognise this path as a registered worktree,
		// use git to remove it (so the parent repo's worktree list stays
		// consistent). Otherwise just rm -rf.
		if is_git_worktree(merged) {
			let _ = git_worktree_remove(merged);
		}
		match std::fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("unable to remove {}: {err}", merged.display()))),
		}
	}
}

fn is_git_worktree(path: &Path) -> bool {
	// A regular working tree has `.git` as a dir; a linked worktree has it
	// as a `gitdir: …` text file. Either way, presence of `.git` is the
	// signal git itself uses.
	std::fs::symlink_metadata(path.join(".git")).is_ok()
}

fn git_worktree_add(lower: &Path, merged: &Path) -> IsoResult<()> {
	let args = [
		OsStr::new("worktree"),
		OsStr::new("add"),
		OsStr::new("--detach"),
		merged.as_os_str(),
		OsStr::new("HEAD"),
	];
	checked("git worktree add", run_git(lower, &args, None)?).map(drop)
}

fn git_worktree_remove(merged: &Path) -> IsoResult<()> {
	let args =
		[OsStr::new("worktree"), OsStr::new("remove"), OsStr::new("--force"), merged.as_os_str()];
	checked("git worktree remove", run_git(merged, &args, None)?).map(drop)
}

/// Replicate `lower`'s live working tree on top of a freshly-checked-out
/// worktree at `merged`. Three passes mirror what `git status` would
/// report at `lower`:
///
///  1. **Staged** — `git diff --binary --cached` from lower, applied to both
///     the index and the working tree of `merged`.
///  2. **Unstaged** — `git diff --binary` from lower, applied to the working
///     tree only.
///  3. **Untracked** — every path listed by `git ls-files --others
///     --exclude-standard -z` from lower, recursively copied into the same
///     relative location under `merged`.
///
/// Result: `git status` inside `merged` reports the same dirty set as
/// `lower` at the moment `start()` was called, so the rest of the PAL
/// contract ("merged mirrors lower's live working tree") holds for
/// rcopy on git inputs too.
fn seed_dirty_state(lower: &Path, merged: &Path, excluded: &[std::path::PathBuf]) -> IsoResult<()> {
	let staged = Arc::new(git_capture_excluding(
		lower,
		&["diff", "--binary", "--no-color", "--cached"],
		excluded,
	)?);
	if !staged.is_empty() {
		git_apply(merged, &staged, &["--cached"])?;
		git_apply(merged, &staged, &[])?;
	}

	let unstaged =
		Arc::new(git_capture_excluding(lower, &["diff", "--binary", "--no-color"], excluded)?);
	if !unstaged.is_empty() {
		git_apply(merged, &unstaged, &[])?;
	}

	let untracked = git_capture_excluding(
		lower,
		&["ls-files", "--others", "--exclude-standard", "-z"],
		excluded,
	)?;
	for path_bytes in untracked.split(|b| *b == 0) {
		if path_bytes.is_empty() {
			continue;
		}
		let rel = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let relative = Path::new(rel);
		if excluded.iter().any(|path| relative.starts_with(path)) {
			continue;
		}
		let skip = excluded
			.iter()
			.filter_map(|path| path.strip_prefix(relative).ok())
			.map(Path::as_os_str)
			.collect::<Vec<_>>();
		let src = lower.join(rel);
		let dst = merged.join(rel);
		if let Some(parent) = dst.parent() {
			std::fs::create_dir_all(parent)
				.map_err(|err| IsoError::other(format!("create {}: {err}", parent.display())))?;
		}
		copy_path(&src, &dst, &skip)?;
	}

	Ok(())
}

fn git_capture_excluding(
	cwd: &Path,
	args: &[&str],
	excluded: &[std::path::PathBuf],
) -> IsoResult<Vec<u8>> {
	let pathspecs = excluded
		.iter()
		.map(|path| format!(":(top,exclude,literal){}", path.to_string_lossy().replace('\\', "/")))
		.collect::<Vec<_>>();
	let mut args = args.to_vec();
	args.extend(["--", "."]);
	args.extend(pathspecs.iter().map(String::as_str));
	git_capture(cwd, &args)
}

fn git_capture(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	checked(format_args!("git {}", args.join(" ")), run_git(cwd, args, None)?)
}

fn git_apply(cwd: &Path, patch: &Arc<Vec<u8>>, extra: &[&str]) -> IsoResult<()> {
	let mut args = vec!["apply", "--binary", "--whitespace=nowarn"];
	args.extend_from_slice(extra);
	checked("git apply", run_git(cwd, &args, Some(Arc::clone(patch)))?).map(drop)
}

/// Stdout of a successful `output`; [`command_failed`] labelled `what`
/// otherwise.
fn checked(what: impl fmt::Display, output: Output) -> IsoResult<Vec<u8>> {
	if output.status.success() {
		return Ok(output.stdout);
	}
	Err(command_failed(what, output.status.code().unwrap_or(-1), &output.stderr))
}

/// Deadlines for one `git` invocation, see [`GIT_LIMITS`].
#[derive(Clone, Copy)]
struct Limits {
	/// How long the child may run before it is killed.
	exit:  Duration,
	/// How long stdout/stderr may stay open once the child has exited.
	drain: Duration,
}

/// Limits for every rcopy `git` call.
///
/// `exit` is generous because a Windows checkout of a very large repository
/// legitimately takes minutes; it exists so a `git` that never exits fails the
/// isolation instead of parking a blocking thread, and the task that awaits
/// it, forever (#17901). `drain` covers pipes that outlive the child: every
/// process holding an inherited write end keeps them open, whether a lingering
/// git grandchild or, on Windows, where handle inheritance is process-wide, an
/// unrelated child the host spawned while the pipes were inheritable. The
/// child's output is complete once it exits, so EOF is not awaited past
/// `drain`.
const GIT_LIMITS: Limits = Limits { exit: Duration::from_mins(10), drain: Duration::from_secs(5) };

/// Exit-status poll interval while waiting under [`Limits::exit`].
const EXIT_POLL: Duration = Duration::from_millis(10);

/// Run `git -C <cwd> <args>` under [`GIT_LIMITS`], feeding `stdin` when
/// given. A non-zero exit is returned, not raised; see [`run_program`] for
/// the errors.
fn run_git(
	cwd: &Path,
	args: &[impl AsRef<OsStr>],
	stdin: Option<Arc<Vec<u8>>>,
) -> IsoResult<Output> {
	run_program(Path::new("git"), cwd, args, stdin, GIT_LIMITS)
}

/// [`run_git`] with an explicit program and limits.
///
/// # Errors
/// - [`IsoError::Unavailable`] when `program` is not on `PATH`.
/// - [`IsoError::Other`] when the child cannot be spawned or waited on, its
///   pipe threads cannot start, it is still running after `limits.exit` (it is
///   killed; on Windows its descendants may survive), or it exits 0 without
///   consuming all of `stdin`.
fn run_program(
	program: &Path,
	cwd: &Path,
	args: &[impl AsRef<OsStr>],
	stdin: Option<Arc<Vec<u8>>>,
	limits: Limits,
) -> IsoResult<Output> {
	let label = || {
		let mut label = String::from("git");
		for arg in args {
			label.push(' ');
			label.push_str(&arg.as_ref().to_string_lossy());
		}
		label
	};
	let mut child = Command::new(program)
		.arg("-C")
		.arg(cwd)
		.args(args)
		.stdin(if stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|err| {
			if err.kind() == io::ErrorKind::NotFound {
				IsoError::unavailable(
					"`git` not on PATH; rcopy cannot materialise a worktree from a git source",
				)
			} else {
				IsoError::other(format!("spawn {}: {err}", label()))
			}
		})?;
	let pipes = Pipes::attach(&mut child, stdin).map_err(|err| {
		reap(&mut child);
		IsoError::other(format!("{}: start pipe threads: {err}", label()))
	})?;
	let started = Instant::now();
	let status = loop {
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) if started.elapsed() < limits.exit => thread::sleep(EXIT_POLL),
			Ok(None) => {
				reap(&mut child);
				return Err(IsoError::other(format!(
					"{} did not exit within {:?}; killed it",
					label(),
					limits.exit
				)));
			},
			Err(err) => {
				reap(&mut child);
				return Err(IsoError::other(format!("wait {}: {err}", label())));
			},
		}
	};
	let deadline = Instant::now() + limits.drain;
	let stdout = pipes.stdout.collect(deadline);
	let stderr = pipes.stderr.collect(deadline);
	if status.success()
		&& let Some(written) = pipes.stdin
	{
		match written.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
			Ok(Ok(())) => {},
			Ok(Err(err)) => return Err(IsoError::other(format!("write stdin to {}: {err}", label()))),
			Err(_) => {
				return Err(IsoError::other(format!("{} exited before reading all of stdin", label())));
			},
		}
	}
	Ok(Output { status, stdout, stderr })
}

/// Kill `child` and reap it. Only the direct child: on Windows a killed `git`
/// launcher leaves its descendants running.
fn reap(child: &mut Child) {
	let _ = child.kill();
	let _ = child.wait();
}

/// Helper threads that own a child's pipes, so a pipe that never closes parks
/// only its thread, never the caller.
struct Pipes {
	stdout: Drain,
	stderr: Drain,
	/// Result of writing stdin, when the child was given any.
	stdin:  Option<Receiver<io::Result<()>>>,
}

impl Pipes {
	fn attach(child: &mut Child, stdin: Option<Arc<Vec<u8>>>) -> io::Result<Self> {
		let stdout = Drain::spawn("pi-iso-git-stdout", child.stdout.take())?;
		let stderr = Drain::spawn("pi-iso-git-stderr", child.stderr.take())?;
		let stdin = match (stdin, child.stdin.take()) {
			(Some(bytes), Some(pipe)) => Some(feed(pipe, bytes)?),
			_ => None,
		};
		Ok(Self { stdout, stderr, stdin })
	}
}

/// Write `bytes` to `pipe` on a helper thread, then close it.
fn feed(mut pipe: ChildStdin, bytes: Arc<Vec<u8>>) -> io::Result<Receiver<io::Result<()>>> {
	let (tx, rx) = mpsc::channel();
	thread::Builder::new()
		.name("pi-iso-git-stdin".into())
		.spawn(move || {
			// A child that exits early closes the pipe; its exit status is the
			// answer, so the receiver may already be gone.
			let _ = tx.send(pipe.write_all(&bytes));
		})?;
	Ok(rx)
}

/// One child output stream, accumulated on a helper thread.
struct Drain {
	bytes: Arc<Mutex<Vec<u8>>>,
	/// Disconnects when the thread reaches EOF.
	eof:   Receiver<()>,
}

impl Drain {
	fn spawn(name: &str, stream: Option<impl io::Read + Send + 'static>) -> io::Result<Self> {
		let bytes = Arc::new(Mutex::new(Vec::new()));
		let (done, eof) = mpsc::channel();
		if let Some(mut stream) = stream {
			let sink = Arc::clone(&bytes);
			thread::Builder::new().name(name.into()).spawn(move || {
				let _done = done;
				let mut buf = [0u8; 8 * 1024];
				loop {
					match stream.read(&mut buf) {
						Ok(0) => break,
						Ok(n) => sink
							.lock()
							.unwrap_or_else(PoisonError::into_inner)
							.extend_from_slice(&buf[..n]),
						Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
						Err(_) => break,
					}
				}
			})?;
		}
		Ok(Self { bytes, eof })
	}

	/// Everything read by EOF or `deadline`, whichever comes first.
	fn collect(self, deadline: Instant) -> Vec<u8> {
		let _ = self
			.eof
			.recv_timeout(deadline.saturating_duration_since(Instant::now()));
		std::mem::take(&mut *self.bytes.lock().unwrap_or_else(PoisonError::into_inner))
	}
}

/// Copy a single path (regular file, symlink, or directory) from `src`
/// to `dst`, preserving mtime. Used by the untracked-files pass;
/// directories are recursed via [`tree::copy_dir_contents`].
fn copy_path(src: &Path, dst: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
	let meta = std::fs::symlink_metadata(src)
		.map_err(|err| IsoError::other(format!("stat {}: {err}", src.display())))?;
	if meta.file_type().is_symlink() {
		tree::copy_symlink(src, dst, meta.file_type())
	} else if meta.file_type().is_dir() {
		std::fs::create_dir_all(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;
		tree::copy_dir_contents(src, dst, skip, &Rcopy)?;
		Rcopy.finish_dir(src, dst)
	} else {
		Rcopy.file(src, dst, meta.file_type())
	}
}

/// Recursive copy preserving file modes (via `std::fs::copy`) and mtimes.
/// `copy` already preserves mtime on the macOS/Linux platforms we care
/// about, but we still set it explicitly to keep behaviour consistent
/// across hosts where the stdlib promise is weaker.
fn recursive_copy(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
	std::fs::create_dir_all(merged)
		.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
	tree::copy_dir_contents(lower, merged, skip, &Rcopy)
}

struct Rcopy;

impl TreeCopy for Rcopy {
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
		tree::copy_symlink(src, dst, file_type)
	}

	fn file(&self, src: &Path, dst: &Path, _file_type: FileType) -> IsoResult<()> {
		std::fs::copy(src, dst).map_err(|err| {
			IsoError::other(format!("copy {} -> {}: {err}", src.display(), dst.display()))
		})?;
		copy_mtime(src, dst);
		Ok(())
	}

	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
		copy_mtime(src, dst);
		Ok(())
	}
}

/// Mirror `src`'s mtime onto the file or directory `dst`. Failures are
/// silently ignored — the mtime hint is an optimisation for [`crate::diff`],
/// not a correctness requirement.
fn copy_mtime(src: &Path, dst: &Path) {
	let Ok(mtime) = std::fs::metadata(src).and_then(|meta| meta.modified()) else {
		return;
	};
	let _ = set_mtime(dst, mtime);
}

/// One path-based time update: rcopy holds no handle to `dst`
/// (`std::fs::copy` closes it), so opening one for `futimens` would add an
/// open and a close per copied entry. `dst` is never a symlink here, but not
/// following keeps a swapped-in link from redirecting the write. Pre-epoch
/// times are not mirrored.
#[cfg(unix)]
fn set_mtime(path: &Path, mtime: std::time::SystemTime) -> std::io::Result<()> {
	mtime
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(std::io::Error::other)?;
	std::fs::set_times_nofollow(path, std::fs::FileTimes::new().set_modified(mtime))
}

/// `fs::set_times` opens `path` with just write-attributes access and backup
/// semantics, so it works on readonly files and directories.
#[cfg(windows)]
fn set_mtime(path: &Path, mtime: std::time::SystemTime) -> std::io::Result<()> {
	std::fs::set_times(path, std::fs::FileTimes::new().set_modified(mtime))
}

#[cfg(not(any(unix, windows)))]
fn set_mtime(path: &Path, mtime: std::time::SystemTime) -> std::io::Result<()> {
	std::fs::File::open(path)?.set_modified(mtime)
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	#[test]
	fn rcopy_inside_source_excludes_only_storage_and_keeps_nested_isolation_independent() {
		let root = TempDirGuard::new();
		let lower = root.path().join("lower");
		let storage = lower.join("sub/.worktrees");
		fs::create_dir_all(storage.join("previous")).unwrap();
		fs::write(storage.join(".omp-worktree-root"), "managed\n").unwrap();
		fs::write(storage.join("previous/keep"), "previous workspace\n").unwrap();
		fs::write(lower.join("sub/file"), "neighbor\n").unwrap();
		fs::write(lower.join("sub/.worktrees-neighbor"), "not storage\n").unwrap();
		let merged = storage.join("parent/m");

		RcopyBackend
			.start_excluding(&lower, &merged, std::slice::from_ref(&storage))
			.unwrap();
		assert_eq!(fs::read(merged.join("sub/file")).unwrap(), b"neighbor\n");
		assert_eq!(fs::read(merged.join("sub/.worktrees-neighbor")).unwrap(), b"not storage\n");
		assert!(!merged.join("sub/.worktrees").exists());

		let nested_storage = merged.join("sub/.worktrees");
		let nested = nested_storage.join("child/m");
		RcopyBackend
			.start_excluding(&merged, &nested, &[nested_storage])
			.unwrap();
		assert_eq!(fs::read(nested.join("sub/file")).unwrap(), b"neighbor\n");
		assert!(!nested.join("sub/.worktrees").exists());
		fs::write(nested.join("sub/file"), "child edit\n").unwrap();
		assert_eq!(fs::read(merged.join("sub/file")).unwrap(), b"neighbor\n");
		assert_eq!(fs::read(lower.join("sub/file")).unwrap(), b"neighbor\n");

		RcopyBackend.stop(&nested).unwrap();
		RcopyBackend.stop(&merged).unwrap();
		assert_eq!(fs::read(storage.join("previous/keep")).unwrap(), b"previous workspace\n");
		assert_eq!(fs::read(storage.join(".omp-worktree-root")).unwrap(), b"managed\n");
	}

	#[test]
	fn rcopy_git_dirty_seeding_omits_storage_and_sibling_worktrees() {
		let root = TempDirGuard::new();
		let lower = root.path().join("lower");
		fs::create_dir_all(lower.join("sub")).unwrap();
		git_capture(&lower, &["init", "-q"]).unwrap();
		fs::write(lower.join("sub/file"), "base\n").unwrap();
		git_capture(&lower, &["add", "."]).unwrap();
		git_capture(&lower, &[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"base",
		])
		.unwrap();
		let storage = lower.join("sub/.worktrees");
		fs::create_dir_all(&storage).unwrap();
		let previous = storage.join("previous");
		git_worktree_add(&lower, &previous).unwrap();
		fs::write(previous.join("keep"), "sibling workspace\n").unwrap();
		fs::write(storage.join(".omp-worktree-root"), "managed\n").unwrap();
		fs::write(lower.join("sub/file"), "dirty\n").unwrap();
		fs::write(lower.join("sub/untracked"), "untracked\n").unwrap();
		let merged = storage.join("parent/m");

		RcopyBackend
			.start_excluding(&lower, &merged, std::slice::from_ref(&storage))
			.unwrap();
		assert_eq!(fs::read(merged.join("sub/file")).unwrap(), b"dirty\n");
		assert_eq!(fs::read(merged.join("sub/untracked")).unwrap(), b"untracked\n");
		assert!(!merged.join("sub/.worktrees").exists());
		let nested_storage = merged.join("sub/.worktrees");
		let nested = nested_storage.join("child/m");
		RcopyBackend
			.start_excluding(&merged, &nested, &[nested_storage])
			.unwrap();
		assert_eq!(fs::read(nested.join("sub/file")).unwrap(), b"dirty\n");
		assert_eq!(fs::read(nested.join("sub/untracked")).unwrap(), b"untracked\n");
		assert!(!nested.join("sub/.worktrees").exists());
		RcopyBackend.stop(&nested).unwrap();
		RcopyBackend.stop(&merged).unwrap();
		assert_eq!(fs::read(previous.join("keep")).unwrap(), b"sibling workspace\n");
		assert_eq!(fs::read(lower.join("sub/file")).unwrap(), b"dirty\n");
	}

	#[cfg(unix)]
	#[test]
	fn rcopy_exclusion_symlink_does_not_copy_or_remove_its_outside_target() {
		let root = TempDirGuard::new();
		let lower = root.path().join("lower");
		let outside = root.path().join("outside");
		fs::create_dir_all(&lower).unwrap();
		fs::create_dir_all(&outside).unwrap();
		fs::write(outside.join("keep"), "outside data\n").unwrap();
		fs::write(lower.join("file"), "source\n").unwrap();
		let storage = lower.join(".worktrees");
		std::os::unix::fs::symlink(&outside, &storage).unwrap();
		let merged = root.path().join("merged");

		RcopyBackend
			.start_excluding(&lower, &merged, &[storage, outside.clone()])
			.unwrap();
		assert!(!merged.join(".worktrees").exists());
		assert_eq!(fs::read(merged.join("file")).unwrap(), b"source\n");
		assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside data\n");
		assert_eq!(fs::read(lower.join("file")).unwrap(), b"source\n");
	}

	/// The non-git `start` path mirrors file and directory mtimes, including
	/// on readonly files, so the mtime-skipping diff stays fast.
	#[cfg(unix)]
	#[test]
	fn rcopy_preserves_file_and_dir_mtimes() {
		use std::os::unix::fs::PermissionsExt as _;

		let root = TempDirGuard::new();
		let lower = root.path().join("lower");
		let sub = lower.join("sub");
		fs::create_dir_all(&sub).expect("create lower/sub");
		let file = sub.join("file.txt");
		fs::write(&file, b"hello").expect("write lower file");
		let file_mtime = UNIX_EPOCH + std::time::Duration::new(1_000_000_000, 123_456_789);
		let dir_mtime = UNIX_EPOCH + std::time::Duration::new(1_100_000_000, 0);
		fs::File::open(&file)
			.and_then(|f| f.set_modified(file_mtime))
			.expect("set file mtime");
		fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).expect("make file readonly");
		fs::File::open(&sub)
			.and_then(|d| d.set_modified(dir_mtime))
			.expect("set dir mtime");

		let merged = root.path().join("merged");
		RcopyBackend.start(&lower, &merged).expect("rcopy start");

		let mtime = |path: &Path| {
			fs::metadata(path)
				.and_then(|m| m.modified())
				.expect("mtime")
		};
		assert_eq!(mtime(&merged.join("sub/file.txt")), file_mtime);
		assert_eq!(mtime(&merged.join("sub")), dir_mtime);
	}

	/// A directory symlink must be recreated as a directory link; Windows
	/// cannot traverse a file link that points at a directory.
	#[cfg(windows)]
	#[test]
	fn rcopy_recreates_directory_symlink_as_directory_link() {
		use std::os::windows::fs::FileTypeExt as _;

		let root = TempDirGuard::new();
		let lower = root.path().join("lower");
		fs::create_dir_all(lower.join("target")).expect("create lower/target");
		fs::write(lower.join("target/inner.txt"), b"inner").expect("write inner file");
		if let Err(err) = std::os::windows::fs::symlink_dir("target", lower.join("link")) {
			// Creating symlinks needs Developer Mode or the symlink privilege.
			eprintln!("skipping: cannot create directory symlink: {err}");
			return;
		}

		let merged = root.path().join("merged");
		RcopyBackend.start(&lower, &merged).expect("rcopy start");

		let link = merged.join("link");
		let file_type = fs::symlink_metadata(&link)
			.expect("link metadata")
			.file_type();
		assert!(file_type.is_symlink_dir(), "expected a directory link, got {file_type:?}");
		assert_eq!(fs::read(link.join("inner.txt")).expect("read through link"), b"inner");
	}

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time should be after epoch")
				.as_nanos();
			let dir = std::env::temp_dir().join(format!(
				"pi-iso-rcopy-test-{}-{nanos}-{}",
				std::process::id(),
				COUNTER.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir_all(&dir).expect("create temp test directory");
			Self(dir)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// An executable stub standing in for `git`.
	#[cfg(unix)]
	fn stub(root: &TempDirGuard, script: &str) -> PathBuf {
		use std::os::unix::fs::PermissionsExt as _;

		let path = root.path().join("git");
		fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("write stub git");
		fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("make stub executable");
		path
	}

	#[cfg(unix)]
	#[test]
	fn run_program_drains_stderr_while_writing_stdin() {
		let root = TempDirGuard::new();
		let git = stub(
			&root,
			"printf 'simulated apply failure\\n' >&2\nyes x | head -c 4194304 >&2\ncat \
			 >/dev/null\nexit 42",
		);

		let patch = Arc::new(vec![b'p'; 4 * 1024 * 1024]);
		let output = run_program(&git, root.path(), &["apply"], Some(patch), GIT_LIMITS)
			.expect("stub consumes stdin and exits");
		let err = checked("git apply", output).expect_err("exit 42 is a failure");
		assert!(
			err.to_string()
				.starts_with("git apply (exit 42): simulated apply failure")
		);
	}

	/// A `git` that never exits is killed at the deadline instead of blocking
	/// isolation setup forever (#17901).
	#[cfg(unix)]
	#[test]
	fn run_program_kills_a_child_that_never_exits() {
		let root = TempDirGuard::new();
		let git = stub(&root, "exec sleep 30");
		let limits = Limits { exit: Duration::from_millis(200), drain: Duration::from_secs(5) };

		let started = Instant::now();
		let err = run_program(&git, root.path(), &["worktree", "add"], None, limits)
			.expect_err("stalled child must fail");
		assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
		assert!(err.to_string().contains("did not exit within 200ms"), "{err}");
	}

	/// Output pipes that another process still holds after `git` exits must not
	/// keep the caller waiting for EOF (#17901).
	#[cfg(unix)]
	#[test]
	fn run_program_returns_when_pipes_outlive_the_child() {
		let root = TempDirGuard::new();
		let pid_file = root.path().join("holder.pid");
		let git = stub(
			&root,
			&format!("printf out\nsleep 30 &\necho $! > '{}'\nexit 0", pid_file.display()),
		);
		let limits = Limits { exit: Duration::from_secs(10), drain: Duration::from_millis(200) };

		let started = Instant::now();
		let result = run_program(&git, root.path(), &["worktree", "add"], None, limits);
		let elapsed = started.elapsed();
		if let Ok(pid) = fs::read_to_string(&pid_file) {
			let _ = Command::new("kill").arg(pid.trim()).status();
		}
		let output = result.expect("child exited 0");
		assert!(elapsed < Duration::from_secs(10), "took {elapsed:?}");
		assert!(output.status.success());
		assert_eq!(output.stdout, b"out");
	}
}
