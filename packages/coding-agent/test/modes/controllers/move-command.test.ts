import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { Container } from "@oh-my-pi/pi-tui";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined };
	const present = vi.fn();
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
		return true;
	});
	const moveSession = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
		state.movedTo = cwd;
	});
	const sessionDir = `${sourceDir}/.sessions`;
	const captureState = vi.fn(() => ({ cwd: state.cwd, sessionDir, movedTo: state.movedTo }));
	const restoreState = vi.fn((snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
	});
	const rollbackMove = vi.fn(async (snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
		state.movedTo = snapshot.cwd;
		restoreState(snapshot);
	});
	const shutdown = vi.fn(async () => {});
	const ctx = {
		session: { isStreaming: false, moveSession },
		sessionManager: {
			getCwd: () => state.cwd,
			captureState,
			restoreState,
			rollbackMove,
			dropSession: vi.fn(async () => {}),
		},
		settings: {
			flush: vi.fn(settingsFlush ?? (async () => {})),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusContainer: new Container(),
		present,
		shutdown,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, captureState, restoreState, rollbackMove, shutdown, sessionDir };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => vi.restoreAllMocks());

	it("does not create a worktree while the main turn is streaming", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-streaming-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const target = path.join(sourceDir, "checkout");
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
				await fs.mkdir(target);
				return { path: target, branch: "feature" };
			});
			Object.defineProperty(ctx.session, "isStreaming", { value: true });
			await new CommandController(ctx).handleWorktreeCommand("feature");

			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(state.cwd).toBe(sourceDir);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("finishes worktree creation and relocation before cleaning the source checkout", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-lifecycle-"));
		const creating = Promise.withResolvers<void>();
		const created = Promise.withResolvers<void>();
		const relocating = Promise.withResolvers<void>();
		const relocated = Promise.withResolvers<void>();
		let command: Promise<void> | undefined;
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const target = path.join(sourceDir, "checkout");
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
				creating.resolve();
				await created.promise;
				await fs.mkdir(target);
				return { path: target, branch: "feature" };
			});
			ctx.session.moveSession = async cwd => {
				relocating.resolve();
				await relocated.promise;
				state.cwd = cwd;
			};
			const cleanup = vi.spyOn(sessionWorktree, "cleanSourceCheckoutIfConfigured").mockImplementation(async () => {
				expect(state.cwd).toBe(target);
				return { cleaned: false };
			});
			command = new CommandController(ctx).handleWorktreeCommand("feature");
			await creating.promise;
			created.resolve();
			await relocating.promise;
			expect(state.cwd).toBe(sourceDir);
			expect(cleanup).not.toHaveBeenCalled();
			relocated.resolve();
			await command;
			expect(state.cwd).toBe(target);
			expect(ctx.present).toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
		} finally {
			created.resolve();
			relocated.resolve();
			await command;
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("keeps the session in place when worktree creation fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-failure-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockRejectedValue(new Error("Branch already exists"));
			await new CommandController(ctx).handleWorktreeCommand("feature");

			expect(state.cwd).toBe(sourceDir);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Branch already exists"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("restores captured manager state when cwd application fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, captureState, restoreState, rollbackMove, shutdown } = createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				return applyCount > 1;
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.session.moveSession).toHaveBeenCalledTimes(1);
			expect(rollbackMove).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(state.cwd).toBe(sourceDir);
			expect(restoreState).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(shutdown).not.toHaveBeenCalled();
			expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();
			expect(ctx.reloadTodos).not.toHaveBeenCalled();
			expect(ctx.ui.requestRender).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("shuts down when rollback and workspace realignment both fail", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				if (applyCount === 1) throw new Error("target setup failed");
				return false;
			});
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("stops recovery after aligning with the moved session", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			ctx.applyCwdChange = vi
				.fn()
				.mockRejectedValueOnce(new Error("target setup failed"))
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true);
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.applyCwdChange).toHaveBeenCalledTimes(2);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(1, targetDir);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(2, targetDir);
			expect(shutdown).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("does not prompt or create a move target when pending settings flush fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = path.join(sourceDir, "destination");
		try {
			const { ctx, state } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			ctx.showHookConfirm = vi.fn(async () => true);
			const mkdir = vi.spyOn(fs, "mkdir");
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(state.movedTo).toBeUndefined();
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each(["cancelled picker", "empty path", "missing parent", "declined creation", "streaming"] as const)(
		"preserves the session when /move is cancelled or rejected on %s",
		async rejection => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
			try {
				const { ctx, state } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				let targetPath: string | undefined = targetDir;
				switch (rejection) {
					case "cancelled picker":
						targetPath = undefined;
						break;
					case "empty path":
						targetPath = '""';
						break;
					case "missing parent":
						targetPath = path.join(targetDir, "nested");
						break;
					case "declined creation":
						ctx.showHookConfirm = vi.fn(async () => false);
						break;
					case "streaming":
						Object.defineProperty(ctx.session, "isStreaming", { value: true });
						break;
				}
				const controller = new CommandController(ctx);

				await controller.handleMoveCommand(targetPath);

				expect(ctx.session.moveSession).not.toHaveBeenCalled();
				expect(ctx.applyCwdChange).not.toHaveBeenCalled();
				expect(state.cwd).toBe(sourceDir);
				expect(state.movedTo).toBeUndefined();
				expect(ctx.present).not.toHaveBeenCalled();
				await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it.each([true, false])(
		"waits for creation confirmation before changing session files or cwd (confirmed=%s)",
		async confirmed => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-lifecycle-"));
			const confirming = Promise.withResolvers<void>();
			const confirmation = Promise.withResolvers<boolean>();
			const creating = Promise.withResolvers<void>();
			const created = Promise.withResolvers<void>();
			const relocating = Promise.withResolvers<void>();
			const relocated = Promise.withResolvers<void>();
			let command: Promise<void> | undefined;
			try {
				const { ctx, state } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				const sourceFile = path.join(sourceDir, "session.jsonl");
				const targetFile = path.join(targetDir, "session.jsonl");
				await Bun.write(sourceFile, "session data\n");
				ctx.showHookConfirm = vi.fn(async () => {
					confirming.resolve();
					return confirmation.promise;
				});
				const originalMkdir = fs.mkdir;
				const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options): Promise<undefined> => {
					creating.resolve();
					await created.promise;
					await originalMkdir(directory, options);
					return undefined;
				});
				ctx.session.moveSession = vi.fn(async cwd => {
					relocating.resolve();
					await relocated.promise;
					await fs.rename(sourceFile, targetFile);
					state.cwd = cwd;
					state.movedTo = cwd;
				});
				command = new CommandController(ctx).handleMoveCommand(targetDir);
				await confirming.promise;
				expect(mkdir).not.toHaveBeenCalled();
				expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
				confirmation.resolve(confirmed);
				if (confirmed) {
					await creating.promise;
					expect(ctx.session.moveSession).not.toHaveBeenCalled();
					created.resolve();
					await relocating.promise;
					expect((await fs.stat(targetDir)).isDirectory()).toBe(true);
					expect(state.cwd).toBe(sourceDir);
					relocated.resolve();
				}
				await command;

				expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
				expect(mkdir).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(ctx.session.moveSession).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(state.cwd).toBe(confirmed ? targetDir : sourceDir);
				if (confirmed) {
					expect(await Bun.file(targetFile).text()).toBe("session data\n");
					expect(await Bun.file(sourceFile).exists()).toBe(false);
					expect(ctx.present).toHaveBeenCalledTimes(1);
				} else {
					expect(await Bun.file(sourceFile).text()).toBe("session data\n");
					expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
					expect(ctx.applyCwdChange).not.toHaveBeenCalled();
					expect(ctx.present).not.toHaveBeenCalled();
				}
			} finally {
				confirmation.resolve(false);
				created.resolve();
				relocated.resolve();
				await command;
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("preserves the source session and cwd when moving the session fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			ctx.session.moveSession = vi.fn(async () => {
				throw new Error("session move denied");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("session move denied"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
