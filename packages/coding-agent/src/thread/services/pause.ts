import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerThreadLink } from "../protocol";
import type { ThreadService, WorkerPeer } from "../services";
import { localAgentSessions } from "../session-directory";

interface PauseGlobals {
	paused: boolean;
	epoch: number;
}

interface MainPauseState {
	globals(): PauseGlobals;
	booted(): void;
	exited(): void;
}

const mainStates = new WeakMap<WorkerPeer, MainPauseState>();
const workerStates = new WeakMap<WorkerThreadLink, (paused: boolean, epoch: number) => void>();

/** Bridge process pause readiness, not a session turn's resume operation. */
export const pauseThreadService: ThreadService = {
	name: "pause",
	installMain(peer) {
		const participant = agentPauseGate.registerParticipant();
		let epoch = 0;
		let booted = false;
		let ready = false;
		let release = agentPauseGate.paused ? peer.retain?.() : undefined;
		peer.link.onNotify("pauseState", (reportedEpoch, reportedReady) => {
			if (reportedEpoch !== epoch) return;
			ready = reportedReady;
			participant.setReady(booted && ready);
		});
		const stop = agentPauseGate.onChange(paused => {
			const requestedEpoch = ++epoch;
			ready = false;
			participant.setReady(false);
			if (paused) release ??= peer.retain?.();
			else {
				release?.();
				release = undefined;
			}
			void peer.link.call("setPaused", paused, requestedEpoch).catch(error => {
				if (requestedEpoch === epoch) {
					ready = false;
					participant.setReady(false);
				}
				logger.error("Subagent pause synchronization failed", { threadId: peer.threadId, error });
			});
		});
		mainStates.set(peer, {
			globals: () => ({ paused: agentPauseGate.paused, epoch }),
			booted: () => {
				booted = true;
				participant.setReady(ready);
			},
			exited: () => {
				stop();
				release?.();
				participant.setReady(false);
				if (!agentPauseGate.paused) participant.dispose();
				else {
					// A lost peer is not an acknowledgement for this pause epoch.
					const stopAfterResume = agentPauseGate.onChange(paused => {
						if (paused) return;
						stopAfterResume();
						participant.dispose();
					});
				}
			},
		});
	},
	globals: peer => mainStates.get(peer)?.globals(),
	onWorkerReady: peer => mainStates.get(peer)?.booted(),
	onWorkerExit(peer) {
		mainStates.get(peer)?.exited();
		mainStates.delete(peer);
	},
	installWorker(link) {
		let epoch = -1;
		const publish = () => {
			if (epoch >= 0) link.notify("pauseState", epoch, agentPauseGate.ready);
		};
		const apply = (paused: boolean, requestedEpoch: number) => {
			if (requestedEpoch < epoch) return;
			epoch = requestedEpoch;
			if (paused === agentPauseGate.paused) publish();
			else if (paused) agentPauseGate.pause();
			else agentPauseGate.resume();
		};
		workerStates.set(link, apply);
		agentPauseGate.onWaitersChange(publish);
		link.handle("setPaused", apply);
		link.handle("preparePausedExit", async () => {
			if (!agentPauseGate.ready) throw new Error("Worker has not reached the model-boundary pause barrier");
			const sessions = localAgentSessions().filter(session => session.getAgentId() !== undefined);
			const prepared = await Promise.all(
				sessions.map(async session => ({ session, ...(await session.preparePausedExit()) })),
			);
			if (!agentPauseGate.ready) throw new Error("Worker left the pause barrier during exit preparation");
			const ids: string[] = [];
			for (const { session, active, pendingPrompt } of prepared) {
				const id = session.getAgentId();
				if (!id || !active) continue;
				ids.push(id);
				if (pendingPrompt) session.recordAgentsPaused([id], pendingPrompt);
			}
			return ids;
		});
		link.handle("disposePausedExit", async () => {
			if (!agentPauseGate.ready) throw new Error("Worker has not reached the model-boundary pause barrier");
			const sessions = localAgentSessions();
			for (const session of sessions) session.abortForPausedExit();
			await Promise.all(sessions.map(session => session.dispose({ pausedExit: true })));
		});
	},
	boot(globals, link) {
		const state = globals as PauseGlobals | undefined;
		if (!state) throw new Error("Missing worker pause state");
		workerStates.get(link)?.(state.paused, state.epoch);
	},
};
