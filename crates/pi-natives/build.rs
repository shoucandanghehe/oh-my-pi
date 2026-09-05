use std::{
	env,
	ffi::OsString,
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use syntect::parsing::{SyntaxDefinition, SyntaxSet};

fn main() {
	napi_build::setup();
	build_oauth_callback_helper();
	generate_syntax_set();
	generate_minimizer_builtin_filters();
	if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		build_applefm_bridge();
	}
}

/// Builds and links the Apple Foundation Models bridge through
/// `src/applefm/build-bridge.sh` (shared with Bazel): `bridge.swift` when a
/// Swift 6.4+ / macOS 27 SDK toolchain exists and the target is Apple silicon,
/// otherwise `stub.c`.
///
/// Cargo reruns this only when the sources, the toolchain selection inputs, or
/// the selected compiler/SDK change; Swift module caches persist across builds
/// (see the script).
fn build_applefm_bridge() {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"));
	let sources = manifest_dir.join("src/applefm");
	let script = sources.join("build-bridge.sh");
	for file in ["build-bridge.sh", "bridge.swift", "stub.c"] {
		println!("cargo:rerun-if-changed={}", sources.join(file).display());
	}
	for variable in ["OMP_APPLEFM_SWIFTC", "OMP_APPLEFM_MODULE_CACHE", "SDKROOT", "DEVELOPER_DIR"] {
		println!("cargo:rerun-if-env-changed={variable}");
	}
	// SDK installs and upgrades change which toolchain is detected. Watch files,
	// not directories: cargo scans directories recursively.
	let selected_sdk = Command::new("/usr/bin/xcrun")
		.args(["--sdk", "macosx", "--show-sdk-path"])
		.output()
		.ok()
		.and_then(|output| String::from_utf8(output.stdout).ok())
		.map(|path| PathBuf::from(path.trim()));
	for sdk in
		[Some(PathBuf::from("/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk")), selected_sdk]
			.into_iter()
			.flatten()
	{
		let settings = sdk.join("SDKSettings.plist");
		if settings.exists() {
			println!("cargo:rerun-if-changed={}", settings.display());
		}
	}

	let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
		Ok("aarch64") => "arm64",
		_ => "x86_64",
	};
	let toolchain = if architecture == "arm64" {
		detect_swift_toolchain(&script)
	} else {
		None
	};
	let library = out_dir.join("libomp_applefm.a");
	let mut command = Command::new("/bin/sh");
	command
		.arg(&script)
		.arg("build")
		.arg(&library)
		.arg(architecture);
	if let Some((swiftc, sdk)) = &toolchain {
		println!("cargo:rerun-if-changed={}", swiftc.display());
		println!("cargo:rerun-if-changed={}", sdk.join("SDKSettings.plist").display());
		command.arg(swiftc).arg(sdk);
	} else if architecture == "arm64" {
		println!(
			"cargo:warning=no Swift 6.4+ toolchain with the macOS 27 SDK; Apple Foundation Models \
			 support is stubbed out"
		);
	}
	let result = command.output().unwrap_or_else(|error| {
		panic!("failed to run Apple Foundation Models bridge build: {error}")
	});
	assert!(
		result.status.success(),
		"Apple Foundation Models bridge build failed ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);

	println!("cargo:rustc-link-search=native={}", out_dir.display());
	println!("cargo:rustc-link-lib=static=omp_applefm");
	if let Some((swiftc, sdk)) = &toolchain {
		for argument in applefm_link_args(swiftc, sdk) {
			println!("cargo:rustc-link-arg={argument}");
		}
	}
}

/// Returns `(swiftc, sdk)` for the first toolchain `build-bridge.sh detect`
/// accepts.
fn detect_swift_toolchain(script: &Path) -> Option<(PathBuf, PathBuf)> {
	let output = Command::new("/bin/sh")
		.arg(script)
		.arg("detect")
		.output()
		.ok()?;
	let line = String::from_utf8(output.stdout).ok()?;
	let mut fields = line.trim_end().split('\t');
	let swiftc = PathBuf::from(fields.next().filter(|field| !field.is_empty())?);
	let sdk = PathBuf::from(fields.next()?);
	Some((swiftc, sdk))
}

/// Linker arguments for the Swift bridge: the Swift runtime and overlays from
/// the SDK it was compiled against, the toolchain's back-compat archives, an
/// rpath for `libswift_Concurrency` (linked as `@rpath/…` because the addon's
/// minimum macOS predates its OS copy), and a weak `FoundationModels` link so
/// the addon loads on macOS without it. Mirrored by
/// `bazel/toolchains/swift/applefm.bzl`.
fn applefm_link_args(swiftc: &Path, sdk: &Path) -> Vec<String> {
	let toolchain_lib = swiftc
		.parent()
		.and_then(Path::parent)
		.expect("swiftc lives in <toolchain>/usr/bin")
		.join("lib/swift/macosx");
	vec![
		format!("-L{}", sdk.join("usr/lib/swift").display()),
		format!("-L{}", toolchain_lib.display()),
		"-Wl,-rpath,/usr/lib/swift".to_owned(),
		format!(
			"-Wl,-weak_library,{}",
			sdk.join("System/Library/Frameworks/FoundationModels.framework/FoundationModels.tbd")
				.display()
		),
	]
}

fn build_oauth_callback_helper() {
	let target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS should be set");
	if target_os == "macos" {
		build_darwin_oauth_callback_helper();
	} else {
		build_oauth_callback_relay(&target_os);
	}
}

fn build_oauth_callback_relay(target_os: &str) {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let relay_source = manifest_dir.join("src/oauth_callback/relay.rs");
	let publication_source = manifest_dir.join("src/oauth_callback/publication.rs");
	let target = env::var("TARGET").expect("TARGET should be set");
	let rustc = env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
	let mut output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"))
		.join("omp-oauth-callback-relay");
	if target_os == "windows" {
		output.set_extension("exe");
	}

	println!("cargo:rerun-if-changed={}", relay_source.display());
	println!("cargo:rerun-if-changed={}", publication_source.display());
	println!("cargo:rerun-if-env-changed=RUSTC_LINKER");
	let target_linker_variable =
		format!("CARGO_TARGET_{}_LINKER", target.replace(['-', '.'], "_").to_ascii_uppercase());
	println!("cargo:rerun-if-env-changed={target_linker_variable}");

	let mut command = Command::new(rustc);
	command
		.current_dir(&manifest_dir)
		.arg("--crate-name")
		.arg("omp_oauth_callback_relay")
		.arg("--crate-type=bin")
		.arg("--edition=2024")
		.arg("--target")
		.arg(&target)
		.arg("-Copt-level=z")
		.arg("-Ccodegen-units=1")
		.arg("-Cpanic=abort")
		.arg("-Cstrip=symbols")
		.arg(&relay_source)
		.arg("-o")
		.arg(&output);

	if let Some(encoded_flags) = env::var_os("CARGO_ENCODED_RUSTFLAGS") {
		for flag in encoded_flags
			.to_string_lossy()
			.split('\u{1f}')
			.filter(|flag| !flag.is_empty())
		{
			command.arg(flag);
		}
	}
	if let Some(linker) = target_linker(&target) {
		let mut linker_argument = OsString::from("linker=");
		linker_argument.push(linker);
		command.arg("-C").arg(linker_argument);
	}
	if target_os == "windows" {
		command.arg("-Ctarget-feature=+crt-static");
	}

	let result = command
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke rustc for OAuth callback relay: {error}"));
	assert!(
		result.status.success(),
		"failed to build OAuth callback relay for {target} ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env=OMP_OAUTH_RELAY_BINARY={}", output.display());
}

#[path = "src/oauth_callback/darwin_compiler.rs"]
mod darwin_compiler;

fn build_darwin_oauth_callback_helper() {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let source = manifest_dir.join("src/oauth_callback/darwin-helper.m");
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"))
		.join("omp-oauth-callback-darwin-helper");
	let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
		Ok("aarch64") => "arm64",
		Ok("x86_64") => "x86_64",
		Ok(architecture) => panic!("unsupported macOS OAuth helper architecture: {architecture}"),
		Err(error) => panic!("CARGO_CFG_TARGET_ARCH should be set: {error}"),
	};
	println!("cargo:rerun-if-changed={}", source.display());
	println!("cargo:rerun-if-env-changed=CC");
	println!("cargo:rerun-if-env-changed=SDKROOT");

	let mut command = darwin_compiler::darwin_compiler_command(env::var_os("CC").as_deref());
	command.current_dir(&manifest_dir);
	if let Some(sdk_root) = darwin_compiler::darwin_sdk_root(env::var_os("SDKROOT").as_deref()) {
		command.arg("-isysroot").arg(sdk_root);
	}
	let result = command
		.args([
			"-x",
			"objective-c",
			"-fobjc-arc",
			"-fblocks",
			"-fno-ident",
			"-Os",
			"-mmacosx-version-min=12.0",
			"-arch",
			architecture,
			"-framework",
			"AppKit",
			"-Wl,-dead_strip",
			"-Wl,-adhoc_codesign",
		])
		.arg(&source)
		.arg("-o")
		.arg(&output)
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke clang for OAuth callback helper: {error}"));
	assert!(
		result.status.success(),
		"failed to build macOS OAuth callback helper ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env=OMP_OAUTH_DARWIN_HELPER={}", output.display());
}

fn target_linker(target: &str) -> Option<OsString> {
	let target_key = target.replace(['-', '.'], "_").to_ascii_uppercase();
	env::var_os(format!("CARGO_TARGET_{target_key}_LINKER")).or_else(|| env::var_os("RUSTC_LINKER"))
}

fn generate_syntax_set() {
	const UPDATE_ENV: &str = "PI_NATIVES_UPDATE_SYNTAX_SET";

	let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
	let syntaxes_dir = Path::new(&manifest_dir).join("src").join("syntaxes");
	let bundled_path = syntaxes_dir.join("syntax_set.packdump");
	let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR should be set"));
	let generated_path = out_dir.join("syntax_set.packdump");

	println!("cargo:rerun-if-changed={}", syntaxes_dir.display());
	println!("cargo:rerun-if-env-changed={UPDATE_ENV}");

	let mut entries = Vec::new();
	for entry in fs::read_dir(&syntaxes_dir)
		.unwrap_or_else(|error| panic!("failed to read {}: {error}", syntaxes_dir.display()))
	{
		let path = entry
			.unwrap_or_else(|error| {
				panic!("failed to read entry in {}: {error}", syntaxes_dir.display())
			})
			.path();
		if path.extension().and_then(|extension| extension.to_str()) == Some("sublime-syntax") {
			entries.push(path);
		}
	}
	entries.sort();

	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for path in entries {
		println!("cargo:rerun-if-changed={}", path.display());
		let source = fs::read_to_string(&path)
			.unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
		let definition = SyntaxDefinition::load_from_str(&source, true, None)
			.unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
		builder.add(definition);
	}

	let syntax_set = builder.build();
	syntect::dumps::dump_to_uncompressed_file(&syntax_set, &generated_path)
		.unwrap_or_else(|error| panic!("failed to write {}: {error}", generated_path.display()));

	if matches!(env::var(UPDATE_ENV).as_deref(), Ok("1")) {
		fs::copy(&generated_path, &bundled_path)
			.unwrap_or_else(|error| panic!("failed to update {}: {error}", bundled_path.display()));
		return;
	}

	let generated = fs::read(&generated_path)
		.unwrap_or_else(|error| panic!("failed to read {}: {error}", generated_path.display()));
	let bundled = fs::read(&bundled_path)
		.unwrap_or_else(|error| panic!("failed to read {}: {error}", bundled_path.display()));
	assert!(
		generated == bundled,
		"{} is stale; regenerate it with `{UPDATE_ENV}=1 cargo check -p pi-natives`",
		bundled_path.display()
	);
}

fn generate_minimizer_builtin_filters() {
	let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
	let defs_dir = Path::new(&manifest_dir)
		.join("src")
		.join("shell")
		.join("minimizer")
		.join("defs");
	let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR should be set"));
	let output_path = out_dir.join("builtin_filters.toml");

	println!("cargo:rerun-if-changed={}", defs_dir.display());

	let mut concatenated =
		String::from("# Auto-generated by build.rs -- do not edit.\nschema_version = 1\n\n");

	let mut entries: Vec<PathBuf> = Vec::new();
	if let Ok(read_dir) = fs::read_dir(&defs_dir) {
		for entry in read_dir.flatten() {
			let path = entry.path();
			if path.extension().and_then(|e| e.to_str()) == Some("toml") {
				entries.push(path);
			}
		}
	}
	entries.sort();

	for path in entries {
		println!("cargo:rerun-if-changed={}", path.display());
		match fs::read_to_string(&path) {
			Ok(body) => {
				let filename = path
					.file_name()
					.and_then(|n| n.to_str())
					.unwrap_or("unknown");
				writeln!(concatenated, "# --- {filename} ---").expect("write to String");
				for line in body.lines() {
					let trimmed = line.trim_start();
					if trimmed.starts_with("schema_version") {
						continue;
					}
					concatenated.push_str(line);
					concatenated.push('\n');
				}
				concatenated.push('\n');
			},
			Err(e) => panic!("failed to read filter definition {}: {e}", path.display()),
		}
	}

	fs::write(&output_path, concatenated)
		.unwrap_or_else(|e| panic!("failed to write {}: {e}", output_path.display()));
}
