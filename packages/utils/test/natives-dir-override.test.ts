import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getNativesDir,
	getWorktreeDir,
	getWorktreesDir,
	setWorktreesDir,
} from "@oh-my-pi/pi-utils/dirs";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_NATIVES_DIR",
	"OMP_WORKTREE_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

describe("managed directory overrides", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-utils-natives-dir-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setWorktreesDir(undefined);
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("overrides the cached XDG/profile path without relocating agent state", async () => {
		const cache = path.join(tempRoot, "cache");
		const data = path.join(tempRoot, "data");
		const shared = path.join(tempRoot, "shared");
		await fs.mkdir(path.join(cache, "omp", "profiles", "isolated"), { recursive: true });
		await fs.mkdir(path.join(data, "omp", "profiles", "isolated"), { recursive: true });
		process.env.XDG_CACHE_HOME = cache;
		process.env.XDG_DATA_HOME = data;
		process.env.PI_CONFIG_DIR = ".alternate";
		process.env.OMP_PROFILE = "isolated";
		__resetDirsFromEnvForTests();
		const defaultNatives = path.join(
			xdgPlatform ? path.join(cache, "omp") : path.join(home, ".alternate"),
			"profiles",
			"isolated",
			"natives",
		);
		const agent = getAgentDir();
		expect(getNativesDir()).toBe(defaultNatives);

		process.env.PI_NATIVES_DIR = " " + shared + " ";
		expect(getNativesDir()).toBe(shared);
		expect(getAgentDir()).toBe(agent);

		delete process.env.PI_NATIVES_DIR;
		expect(getNativesDir()).toBe(defaultNatives);
	});

	it("expands home-relative overrides instead of treating tilde as a cwd-relative path", () => {
		process.env.PI_NATIVES_DIR = "~";
		expect(getNativesDir()).toBe(home);
		process.env.PI_NATIVES_DIR = " ~/unused/../shared ";
		expect(getNativesDir()).toBe(path.join(home, "shared"));
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/natives"],
	])("keeps the existing cache root when the override is %s", (_label, override) => {
		process.env.PI_NATIVES_DIR = override;
		expect(getNativesDir()).toBe(path.join(home, ".omp", "natives"));
	});

	it("resolves worktree settings against each operation cwd without rebinding on lookup", () => {
		const first = path.join(tempRoot, "first");
		const second = path.join(tempRoot, "second");
		setWorktreesDir(" .worktrees ");
		expect(getWorktreeDir(first, "one")).toBe(path.join(first, ".worktrees", "one"));
		expect(getWorktreeDir(second, "two")).toBe(path.join(second, ".worktrees", "two"));
		expect(getWorktreesDir(first)).toBe(path.join(first, ".worktrees"));
	});

	it("keeps environment-over-setting priority for relative, home-relative and absolute worktree paths", () => {
		const cwd = path.join(tempRoot, "project");
		setWorktreesDir(".worktrees");
		process.env.OMP_WORKTREE_DIR = " ../shared ";
		expect(getWorktreesDir(cwd)).toBe(path.join(tempRoot, "shared"));
		process.env.OMP_WORKTREE_DIR = "~/trees";
		expect(getWorktreesDir(cwd)).toBe(path.join(home, "trees"));
		process.env.OMP_WORKTREE_DIR = path.join(tempRoot, "absolute");
		expect(getWorktreesDir(cwd)).toBe(path.join(tempRoot, "absolute"));
		process.env.OMP_WORKTREE_DIR = " \t ";
		expect(getWorktreesDir(cwd)).toBe(path.join(cwd, ".worktrees"));
		setWorktreesDir("~/configured");
		expect(getWorktreesDir(cwd)).toBe(path.join(home, "configured"));
		setWorktreesDir(undefined);
		expect(getWorktreesDir(cwd)).toBe(path.join(home, ".omp", "wt"));
	});
});
