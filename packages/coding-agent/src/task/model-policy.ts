import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { isRecord, prompt, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import {
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelOverride,
} from "../config/model-resolver";
import modelRoleDescription from "../prompts/agents/model-role.md" with { type: "text" };
import modelApprovalTemplate from "../prompts/tools/task-model-approval.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { getBundledAgent } from "./agents";
import type { AgentDefinition } from "./types";

const MODEL_ROLES = ["smol", "default", "slow"] as const;
export type DelegationRole = (typeof MODEL_ROLES)[number];
type UpgradeDecision = "allowed" | "denied" | "ask";
const UPGRADE_ENTRY_TYPE = "task_model_upgrade";

function isDelegationRole(role: string | undefined): role is DelegationRole {
	return role === "smol" || role === "default" || role === "slow";
}

function configuredDelegationRole(session: ToolSession, role: string | undefined): DelegationRole | undefined {
	const visited = new Set<string>();
	while (role && !visited.has(role)) {
		if (isDelegationRole(role)) return role;
		visited.add(role);
		role = resolveExplicitModelRole(session.settings.getModelRole(role), session.settings);
	}
	return undefined;
}

function resolveModel(session: ToolSession, patterns: string[]): Model | undefined {
	return session.modelRegistry
		? resolveModelOverride(patterns, session.modelRegistry, session.settings).model
		: undefined;
}

function roleMatches(session: ToolSession, role: DelegationRole, patterns: string[], model?: Model): boolean {
	const rolePatterns = resolveConfiguredModelPatterns(`@${role}`, session.settings);
	return model
		? modelsAreEqual(model, resolveModel(session, rolePatterns))
		: patterns.some(pattern => rolePatterns.includes(pattern));
}

/** The active model's configured tier, using recorded role identity to disambiguate shared models. */
function currentDelegationRole(session: ToolSession): DelegationRole | undefined {
	const inherited = session.getDelegationRole?.();
	if (inherited) return inherited;
	const active = session.getActiveModelString?.();
	const patterns = active ? [active] : [];
	const model = session.getActiveModel?.() ?? resolveModel(session, patterns);
	const branch = session.sessionManager?.getBranch() ?? [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		const role =
			entry.type === "session_init"
				? (entry.delegationRole ?? entry.modelRole)
				: entry.type === "model_change"
					? entry.role
					: undefined;
		const tier = configuredDelegationRole(session, role);
		if (tier && roleMatches(session, tier, patterns, model)) return tier;
	}
	return (["default", "slow", "smol"] as const).find(role => roleMatches(session, role, patterns, model));
}

/** Only named roles and inherited assignments carry a delegation tier. */
export function selectedDelegationRole(
	session: ToolSession,
	role: string | undefined,
	inheritsSessionModel = false,
): DelegationRole | undefined {
	if (inheritsSessionModel) return currentDelegationRole(session);
	return configuredDelegationRole(session, role);
}

export function delegationAgents(session: ToolSession): AgentDefinition[] {
	const current = currentDelegationRole(session);
	const roles =
		current === "smol"
			? ["default", "slow"]
			: current === "default"
				? ["slow"]
				: current === "slow"
					? ["default"]
					: [];
	const task = getBundledAgent("task");
	if (!task) throw new Error("Bundled task agent is unavailable");
	return roles.map(role => ({
		...task,
		name: role,
		description: prompt.render(modelRoleDescription, { role }),
		model: [`@${role}`],
		filePath: undefined,
	}));
}

function upgradeDecision(session: ToolSession): UpgradeDecision {
	const sessionId = session.sessionManager?.getSessionId?.();
	if (!sessionId) return "ask";
	const entries = session.sessionManager?.getEntries() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== UPGRADE_ENTRY_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.sessionId !== sessionId) continue;
		if (entry.data.decision === "allowed" || entry.data.decision === "denied") return entry.data.decision;
	}
	return "ask";
}

/** Provider-facing facts; the journal remains the authority for approval. */
export interface DelegationContext {
	role: DelegationRole | undefined;
	subagent: boolean;
	approval: UpgradeDecision;
}

export function delegationContext(session: ToolSession): DelegationContext {
	const role = currentDelegationRole(session);
	return {
		role,
		subagent: (session.taskDepth ?? 0) > 0,
		approval: role === "slow" ? "allowed" : upgradeDecision(session),
	};
}

interface AgentDelegation {
	agent: string;
	assignment: string;
}

interface PendingUpgrade {
	sessionId: string;
	controller: AbortController;
	promise: Promise<void>;
	waiters: number;
}

const pendingUpgrades = new WeakMap<ToolSession, PendingUpgrade>();

async function approveUpgrade(
	session: ToolSession,
	delegation: AgentDelegation,
	current: DelegationRole,
	target: DelegationRole,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const manager = session.sessionManager;
	const sessionId = manager?.getSessionId?.();
	if (!manager?.appendEntriesAtomically || !sessionId)
		throw new Error("Higher-tier delegation requires an owning atomic session journal.");
	const appendEntries = manager.appendEntriesAtomically.bind(manager);
	let pending = pendingUpgrades.get(session);
	if (pending?.sessionId !== sessionId) pending = undefined;
	if (!pending) {
		const controller = new AbortController();
		const removeDispose = session.registerDisposeCallback?.(() => controller.abort());
		const removeChange = session.registerSessionChangeCallback?.(() => controller.abort());
		const promise = (async () => {
			const context = session.getToolContext?.();
			const ui = context?.ui;
			if (!(session.canPromptUser ?? session.hasUI) || !ui) {
				throw new Error("Higher-tier delegation needs user approval; no interactive approval UI is available.");
			}
			const answer = await untilAborted(controller.signal, () =>
				ui.select(
					prompt.render(modelApprovalTemplate, {
						current,
						target,
						assignment: replaceTabs(sanitizeText(delegation.assignment)),
					}),
					["Approve", "Deny"],
					{ signal: controller.signal },
				),
			);
			controller.signal.throwIfAborted();
			if (answer !== "Approve" && answer !== "Deny") {
				throw new Error("Agent delegation approval was dismissed; no session decision was recorded.");
			}
			await appendEntries(() => {
				controller.signal.throwIfAborted();
				if (manager.getSessionId?.() !== sessionId) {
					throw new Error("Session changed while awaiting agent delegation approval.");
				}
				manager.appendCustomEntry(UPGRADE_ENTRY_TYPE, {
					sessionId,
					decision: answer === "Approve" ? "allowed" : "denied",
				});
			});
		})();
		pending = { sessionId, controller, promise, waiters: 0 };
		pendingUpgrades.set(session, pending);
		const release = () => {
			if (pendingUpgrades.get(session)?.promise === promise) pendingUpgrades.delete(session);
			removeDispose?.();
			removeChange?.();
		};
		void promise.then(release, release);
	}
	pending.waiters++;
	try {
		await untilAborted(signal, pending.promise);
		signal?.throwIfAborted();
	} finally {
		pending.waiters--;
		if (pending.waiters === 0) pending.controller.abort();
	}
}

/** Authorize default/slow identities, independently of their model configuration or routing. */
export async function authorizeAgentDelegation(
	session: ToolSession,
	delegation: AgentDelegation,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const current = currentDelegationRole(session);
	const target = delegation.agent === "default" || delegation.agent === "slow" ? delegation.agent : undefined;
	if (!current || !target || MODEL_ROLES.indexOf(target) <= MODEL_ROLES.indexOf(current)) return;
	if ((session.taskDepth ?? 0) > 0) {
		throw new Error(
			`Subagents cannot invoke higher-tier agent "${target}" from ${current}. Report the blocker and evidence to Main instead.`,
		);
	}
	if (
		pendingUpgrades.get(session)?.sessionId === session.sessionManager?.getSessionId?.() ||
		upgradeDecision(session) === "ask"
	) {
		await approveUpgrade(session, delegation, current, target, signal);
	}
	if (upgradeDecision(session) !== "allowed") {
		throw new Error(
			"Higher-tier delegation was denied for this main session. Continue within the current tier or report the blocker; do not request approval again.",
		);
	}
}
