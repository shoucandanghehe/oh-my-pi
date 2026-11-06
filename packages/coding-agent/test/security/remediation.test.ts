import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import {
	assertSecurityRemediationBaselineClean,
	prepareSecurityRemediationWorkspace,
	type SecurityRemediationContext,
	type SecurityRemediationWorkspace,
} from "../../src/security";
import type { IsolationHandle, WorktreeBaseline } from "../../src/task/worktree";

function cleanBaseline(): WorktreeBaseline {
	return {
		root: {
			repoRoot: "/repo",
			headCommit: "a".repeat(40),
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
}

function context(baseline = cleanBaseline()): SecurityRemediationContext {
	return { repoRoot: "/repo", baseline };
}

function handle(): IsolationHandle {
	return {
		mergedDir: "/state/worktrees/security/m",
		backend: IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	};
}

describe("security remediation workspace", () => {
	test("refuses dirty source trees before creating isolation", async () => {
		const baseline = cleanBaseline();
		baseline.root.unstaged = "diff --git a/src/app.ts b/src/app.ts";
		let isolationCalls = 0;
		await expect(
			prepareSecurityRemediationWorkspace(
				{ cwd: "/repo", findingIds: ["secf_fixture"] },
				{
					prepareContext: async () => context(baseline),
					createIsolation: async () => {
						isolationCalls++;
						return handle();
					},
				},
			),
		).rejects.toThrow("refuses a dirty working tree");
		expect(isolationCalls).toBe(0);
	});

	test("creates one isolated workspace and cleans it idempotently", async () => {
		const created: Array<{ root: string; id: string; cwd: string; preferred: IsoBackendKind | undefined }> = [];
		let cleanupCalls = 0;
		const workspace = await prepareSecurityRemediationWorkspace(
			{ cwd: "/repo/src", findingIds: [" secf_a ", "secf_a", "secf_b"], isolationId: "security-fixture" },
			{
				prepareContext: async () => context(),
				createIsolation: async (root, id, preferred, cwd) => {
					created.push({ root, id, cwd, preferred });
					return handle();
				},
				cleanupIsolation: async () => {
					cleanupCalls++;
				},
			},
		);
		expect(created).toEqual([{ root: "/repo", id: "security-fixture", cwd: "/repo/src", preferred: undefined }]);
		expect(workspace.findingIds).toEqual(["secf_a", "secf_b"]);
		expect(workspace.worktreePath).toBe("/state/worktrees/security/m");
		await workspace.cleanup();
		await workspace.cleanup();
		expect(cleanupCalls).toBe(1);
	});

	test("uses a subfolder's configured storage without treating existing worktrees as user changes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remediation-cwd-"));
		const repo = path.join(root, "repo");
		const cwd = path.join(repo, "pkg");
		const savedEnv = process.env.OMP_WORKTREE_DIR;
		let workspace: SecurityRemediationWorkspace | undefined;
		try {
			delete process.env.OMP_WORKTREE_DIR;
			setWorktreesDir(".worktrees");
			await Bun.write(path.join(cwd, "file.txt"), "tracked\n");
			await $`git init -q && git config commit.gpgsign false && git add pkg/file.txt && git -c user.name=Test -c user.email=test@example.com commit -qm init`
				.cwd(repo)
				.quiet();
			const previous = path.join(cwd, ".worktrees", "previous", "keep.txt");
			await Bun.write(previous, "existing workspace\n");
			workspace = await prepareSecurityRemediationWorkspace({
				cwd,
				findingIds: ["secf_fixture"],
				isolationId: "security-cwd",
				preferredBackend: IsoBackendKind.Rcopy,
			});
			expect(path.dirname(path.dirname(workspace.worktreePath))).toBe(path.join(cwd, ".worktrees"));
			expect(await Bun.file(path.join(workspace.worktreePath, "pkg", "file.txt")).text()).toBe("tracked\n");
			expect(await Bun.file(previous).text()).toBe("existing workspace\n");
		} finally {
			await workspace?.cleanup();
			setWorktreesDir(undefined);
			if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
			else process.env.OMP_WORKTREE_DIR = savedEnv;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("reports each dirty baseline class", () => {
		const baseline = cleanBaseline();
		baseline.root.staged = "staged";
		baseline.root.untracked = ["scratch.txt"];
		baseline.nested.push({
			relativePath: "vendor/nested",
			baseline: { ...cleanBaseline().root, repoRoot: "/repo/vendor/nested", unstaged: "nested" },
		});
		expect(() => assertSecurityRemediationBaselineClean(baseline)).toThrow(
			"staged changes, untracked files, dirty nested repository vendor/nested",
		);
	});
});
