import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { cfgHindsightScoping } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { BankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import {
	type HindsightApi,
	HindsightApi as HindsightApiCtor,
	type MentalModelSummary,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import {
	diffMentalModelContent,
	ensureMentalModels,
	loadMentalModelsBlock,
	MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT,
	renderMentalModelsBlock,
	resolveSeedsForScope,
} from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";

afterEach(() => {
	vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* resolveSeedsForScope                                                        */
/* -------------------------------------------------------------------------- */

// These tests defend the foot-gun called out in the docs: a seed tagged with
// something we never write at retain time refreshes empty (Hindsight all_strict
// matching). Tag derivation MUST stay disciplined per scoping mode.

describe("resolveSeedsForScope", () => {
	it("global scoping emits only seeds whose scopes include 'global', and never project-tagged ones", () => {
		const scope: BankScope = { bankId: "omp" };
		const seeds = resolveSeedsForScope(scope, "global");
		expect(seeds.length).toBeGreaterThan(0);
		// project-conventions is per-project only — must not appear.
		expect(seeds.some(s => s.id === "project-conventions")).toBe(false);
		// user-preferences applies to every scope.
		const userPrefs = seeds.find(s => s.id === "user-preferences");
		expect(userPrefs).toBeDefined();
		// In global mode there is no project axis, so untagged seeds carry no tags.
		expect(userPrefs?.tags).toEqual([]);
	});

	it("per-project-tagged scoping bakes the scope's retainTags into projectTagged seeds and leaves untagged seeds bare", () => {
		const scope: BankScope = {
			bankId: "omp",
			retainTags: ["project:omp"],
			recallTags: ["project:omp"],
			recallTagsMatch: "any",
		};
		const seeds = resolveSeedsForScope(scope, "per-project-tagged");
		const projectConv = seeds.find(s => s.id === "project-conventions-omp");
		const userPrefs = seeds.find(s => s.id === "user-preferences");
		expect(projectConv?.legacyIds).toEqual(["project-conventions"]);
		expect(projectConv?.tags).toEqual(["project:omp"]);
		// user-preferences is intentionally untagged so the refresh reads the
		// whole bank, not just the project subset.
		expect(userPrefs?.tags).toEqual([]);
	});

	it("per-project scoping yields project-conventions but the scope carries no tags so the seed is untagged", () => {
		const scope: BankScope = { bankId: "omp-myproj" };
		const seeds = resolveSeedsForScope(scope, "per-project");
		const projectConv = seeds.find(s => s.id === "project-conventions");
		expect(projectConv).toBeDefined();
		// per-project mode isolates via bank id, not tags. retainTags is undefined,
		// so projectTagged seeds resolve to no tags. This is correct: the bank is
		// already a per-project silo.
		expect(projectConv?.tags).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* ensureMentalModels — idempotent seeding                                     */
/* -------------------------------------------------------------------------- */

interface FakeApiCalls {
	created: Array<{ id: string | undefined; name: string; sourceQuery: string; tags?: string[] }>;
}

function makeFakeApi(existing: MentalModelSummary[]): { api: HindsightApi; calls: FakeApiCalls } {
	const calls: FakeApiCalls = { created: [] };
	const api = {
		listMentalModels: async () => ({ items: existing }),
		createMentalModel: async (
			_bankId: string,
			name: string,
			sourceQuery: string,
			options: { id?: string; tags?: string[] },
		) => {
			calls.created.push({ id: options.id, name, sourceQuery, tags: options.tags });
			return { operation_id: `op-${calls.created.length}` };
		},
	} as unknown as HindsightApi;
	return { api, calls };
}

describe("ensureMentalModels", () => {
	it("creates only the seeds that are missing on the bank", async () => {
		const { api, calls } = makeFakeApi([{ id: "user-preferences", bank_id: "omp", name: "User Preferences" }]);
		await ensureMentalModels(
			api,
			"omp",
			[
				{ id: "user-preferences", name: "User Preferences", sourceQuery: "q1", tags: [] },
				{ id: "project-conventions", name: "Project Conventions", sourceQuery: "q2", tags: ["project:omp"] },
			],
			false,
		);
		expect(calls.created).toHaveLength(1);
		expect(calls.created[0].id).toBe("project-conventions");
		expect(calls.created[0].tags).toEqual(["project:omp"]);
	});

	it("matches legacy bare project seeds only when their tags match the active project", async () => {
		const legacyProjectA: MentalModelSummary = {
			id: "project-conventions",
			bank_id: "omp",
			name: "Project Conventions",
			tags: ["project:a"],
		};

		const matching = makeFakeApi([legacyProjectA]);
		await ensureMentalModels(
			matching.api,
			"omp",
			[
				{
					id: "project-conventions-a",
					name: "Project Conventions",
					sourceQuery: "q",
					tags: ["project:a"],
					legacyIds: ["project-conventions"],
				},
			],
			false,
		);
		expect(matching.calls.created).toHaveLength(0);

		const differentProject = makeFakeApi([legacyProjectA]);
		await ensureMentalModels(
			differentProject.api,
			"omp",
			[
				{
					id: "project-conventions-b",
					name: "Project Conventions",
					sourceQuery: "q",
					tags: ["project:b"],
					legacyIds: ["project-conventions"],
				},
			],
			false,
		);
		expect(differentProject.calls.created).toHaveLength(1);
		expect(differentProject.calls.created[0].id).toBe("project-conventions-b");
	});

	it("does not modify existing models even if their fields drift from the seed list", async () => {
		// Defends create-only behavior: an operator-edited curated model with the
		// same id MUST NOT be silently overwritten on next boot.
		const { api, calls } = makeFakeApi([
			{
				id: "user-preferences",
				bank_id: "omp",
				name: "Old Name",
				source_query: "old query",
				tags: ["legacy"],
			},
		]);
		await ensureMentalModels(
			api,
			"omp",
			[{ id: "user-preferences", name: "User Preferences", sourceQuery: "new query", tags: [] }],
			false,
		);
		expect(calls.created).toHaveLength(0);
	});

	it("treats a list failure as a no-op (best-effort, never throws)", async () => {
		const calls: FakeApiCalls = { created: [] };
		const api = {
			listMentalModels: async () => {
				throw new Error("network down");
			},
			createMentalModel: async () => {
				calls.created.push({ id: "should-not-create", name: "", sourceQuery: "" });
				return { operation_id: "x" };
			},
		} as unknown as HindsightApi;

		await expect(
			ensureMentalModels(api, "omp", [{ id: "x", name: "X", sourceQuery: "q", tags: [] }], false),
		).resolves.toBeUndefined();
		expect(calls.created).toHaveLength(0);
	});
});

type SeedCreateRequest = Pick<MentalModelSummary, "id" | "name" | "source_query" | "tags" | "max_tokens" | "trigger">;

describe("mental-model generation budget", () => {
	it.each(["automatic bootstrap", "manual seed command"] as const)(
		"%s applies the generation budget only to missing models",
		async route => {
			vi.spyOn(cfgHindsightScoping, "get").mockReturnValue("per-project-tagged");
			const models = new Map<string, MentalModelSummary>();
			const created: SeedCreateRequest[] = [];
			const mutations: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (request.method !== "GET") mutations.push(`${request.method} ${url.pathname}`);
					if (url.pathname === "/v1/default/banks/seed-test/mental-models") {
						if (request.method === "GET") return Response.json({ items: [...models.values()] });
						if (request.method === "POST") {
							const body = (await request.json()) as SeedCreateRequest;
							created.push(body);
							models.set(body.id, { ...body, bank_id: "seed-test" });
							return Response.json({ operation_id: `created-${body.id}` });
						}
					}
					return new Response("Unexpected request", { status: 400 });
				},
			});
			const client = new HindsightApiCtor({ baseUrl: `http://127.0.0.1:${server.port}` });

			async function seed(project: string, maxTokens?: number): Promise<void> {
				const settings = Settings.isolated({
					"memory.backend": "hindsight",
					"hindsight.mentalModelsEnabled": true,
					"hindsight.mentalModelAutoSeed": true,
					...(maxTokens === undefined ? {} : { "hindsight.mentalModelMaxTokens": maxTokens }),
				});
				const scope: BankScope = { bankId: "seed-test", retainTags: [`project:${project}`] };
				const published = Promise.withResolvers<void>();
				const state = new HindsightSessionState({
					sessionId: `seed-${project}`,
					client,
					...scope,
					config: loadHindsightConfig(settings),
					session: { refreshBaseSystemPrompt: async () => published.resolve() } as unknown as AgentSession,
					banksSet: new Set(["seed-test"]),
				});
				try {
					if (route === "automatic bootstrap") {
						await state.runMentalModelLoad(scope);
						await published.promise;
					} else {
						const errors: string[] = [];
						const controller = new CommandController({
							settings,
							session: { getHindsightSessionState: () => state },
							showStatus: () => {},
							showWarning: (message: string) => errors.push(message),
							showError: (message: string) => errors.push(message),
						} as unknown as InteractiveModeContext);
						await controller.handleMemoryCommand("/memory mm seed");
						expect(errors).toEqual([]);
					}
				} finally {
					state.dispose();
				}
			}

			try {
				await seed("first");
				expect(Object.fromEntries(created.map(model => [model.id, model.max_tokens]))).toEqual({
					"user-preferences": 4096,
					"project-conventions-first": 4096,
					"project-decisions-first": 4096,
				});

				const curated = models.get("user-preferences")!;
				curated.max_tokens = 600;
				curated.source_query = "Operator-curated query";
				const existing = structuredClone([...models.values()]);
				await seed("first", 6144);
				expect(created).toHaveLength(3);
				expect([...models.values()]).toEqual(existing);

				await seed("second", 6144);
				expect(Object.fromEntries(created.slice(3).map(model => [model.id, model.max_tokens]))).toEqual({
					"project-conventions-second": 6144,
					"project-decisions-second": 6144,
				});
				expect(models.get("user-preferences")).toEqual(curated);
				expect(mutations).toEqual(
					Array.from({ length: 5 }, () => "POST /v1/default/banks/seed-test/mental-models"),
				);
			} finally {
				server.stop(true);
			}
		},
	);
});

/* -------------------------------------------------------------------------- */
/* renderMentalModelsBlock — render budget enforcement                         */
/* -------------------------------------------------------------------------- */

describe("renderMentalModelsBlock", () => {
	it("wraps content in <mental_models> under per-model headings", () => {
		const block = renderMentalModelsBlock(
			[{ id: "u", bank_id: "b", name: "User Preferences", content: "prefers tabs" }],
			MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT,
		);
		expect(block.startsWith("<mental_models>\n")).toBe(true);
		expect(block.endsWith("\n</mental_models>")).toBe(true);
		expect(block).toContain("# User Preferences");
		expect(block).toContain("prefers tabs");
	});

	it("respects the global budget and signals truncation when the content overflows", () => {
		const huge = "x".repeat(50_000);
		const block = renderMentalModelsBlock(
			[{ id: "u", bank_id: "b", name: "User Preferences", content: huge }],
			2_000,
		);
		// The hard contract: rendered length never exceeds the budget by more
		// than a single trailing wrapper line. Asserting `<= budget` directly is
		// the only meaningful guarantee.
		expect(block.length).toBeLessThanOrEqual(2_000);
		expect(block).toContain("[mental-model snapshot truncated at render budget]");
		// The wrapper must remain intact even after truncation so downstream
		// stripMemoryTags can still find the closing tag.
		expect(block.endsWith("\n</mental_models>")).toBe(true);
	});

	it("drops trailing models when the cumulative budget is exhausted", () => {
		const filler = "y".repeat(1_500);
		const block = renderMentalModelsBlock(
			[
				{ id: "a", bank_id: "b", name: "Alpha", content: filler },
				{ id: "z", bank_id: "b", name: "Zeta", content: filler },
			],
			2_400,
		);
		expect(block.length).toBeLessThanOrEqual(2_400);
		expect(block).toContain("# Alpha");
		// Either Zeta's heading is fully absent, or it appears truncated. Both
		// outcomes are acceptable; the contract is "do not blow the budget".
		expect(block).toContain("[mental-model snapshot truncated at render budget]");
	});

	it("returns an empty string for an empty model list (callers gate on this)", () => {
		expect(renderMentalModelsBlock([], 16_000)).toBe("");
	});

	it("returns an empty string when the budget is below the wrapper minimum (caller skips injection)", () => {
		// Budgets too small to fit the wrapper plus minimal content must not
		// produce a half-formed block — the caller treats `""` as "skip
		// injection" and falls through to recall-only context.
		const block = renderMentalModelsBlock([{ id: "u", bank_id: "b", name: "User Preferences", content: "fact" }], 60);
		expect(block).toBe("");
	});
});

describe("loadMentalModelsBlock", () => {
	it("returns undefined when every model has empty content (background reflect not yet completed)", async () => {
		vi.spyOn(HindsightApiCtor.prototype, "listMentalModels").mockResolvedValue({
			items: [
				{ id: "a", bank_id: "b", name: "Alpha", content: "" },
				{ id: "z", bank_id: "b", name: "Zeta", content: "   " },
			],
		});
		const api = new HindsightApiCtor({ baseUrl: "http://localhost:8888" });
		const block = await loadMentalModelsBlock(api, "b");
		expect(block).toBeUndefined();
	});

	it("filters project-tagged models to the active project while keeping untagged models", async () => {
		vi.spyOn(HindsightApiCtor.prototype, "listMentalModels").mockResolvedValue({
			items: [
				{ id: "u", bank_id: "b", name: "User Preferences", content: "global preference" },
				{ id: "a", bank_id: "b", name: "Project A", tags: ["project:a"], content: "a convention" },
				{ id: "b", bank_id: "b", name: "Project B", tags: ["project:b"], content: "b convention" },
			],
		});
		const api = new HindsightApiCtor({ baseUrl: "http://localhost:8888" });
		const block = await loadMentalModelsBlock(api, "b", MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT, ["project:b"]);
		expect(block).toContain("global preference");
		expect(block).toContain("b convention");
		expect(block).not.toContain("a convention");
	});

	it("returns undefined on list failure rather than throwing (best-effort surface)", async () => {
		vi.spyOn(HindsightApiCtor.prototype, "listMentalModels").mockRejectedValue(new Error("boom"));
		const api = new HindsightApiCtor({ baseUrl: "http://localhost:8888" });
		const block = await loadMentalModelsBlock(api, "b");
		expect(block).toBeUndefined();
	});
});

/* -------------------------------------------------------------------------- */
/* diffMentalModelContent                                                      */
/* -------------------------------------------------------------------------- */

describe("diffMentalModelContent", () => {
	it("marks added, removed, and unchanged lines with +/-/' '", () => {
		const out = diffMentalModelContent("alpha\nbeta\ngamma", "alpha\nzeta\ngamma");
		expect(out).toContain("  alpha");
		expect(out).toContain("- beta");
		expect(out).toContain("+ zeta");
		expect(out).toContain("  gamma");
	});

	it("treats a null previous as a pure-addition diff", () => {
		const out = diffMentalModelContent(null, "fresh\ncontent");
		expect(out.split("\n")).toEqual(["+ fresh", "+ content"]);
	});

	it("caps long diffs and emits an elision marker so the TUI stays readable", () => {
		const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
		const out = diffMentalModelContent(null, big, 50);
		const lines = out.split("\n");
		expect(lines.length).toBe(51); // 50 diff lines + 1 elision marker
		expect(lines[lines.length - 1]).toMatch(/\[…\d+ln elided…\]$/);
	});

	it("caps LCS input lines so a huge curated model cannot hang the diff", () => {
		// Defends against O(n*m) blowup in `longestCommonSubsequence` when an
		// operator-curated mental model grows to 10k+ lines: the diff must
		// remain interactive.
		const huge = Array.from({ length: 5_000 }, (_, i) => `line${i}`).join("\n");
		const start = Date.now();
		const out = diffMentalModelContent(null, huge, 5_000);
		const elapsedMs = Date.now() - start;
		// Soft latency assertion: 5_000 lines diffed against [] is trivial,
		// but the cap must hold — without it, a 5_000 vs 5_000 LCS would
		// allocate 25M cells. We drive the contract with the marker check.
		expect(out).toContain("input capped at 1000 lines per side before diff");
		// Sanity: cap kicks in well below 1s on any sane CI box.
		expect(elapsedMs).toBeLessThan(2_000);
	});
});
