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

/** Bridge the existing model-boundary gate, never a session turn's `resume` operation. */
export const pauseThreadService: ThreadService = {
	name: "pause",
	installMain(peer) {
		const participant = agentPauseGate.registerParticipant();
		let epoch = 0;
		let booted = false;
		let acknowledged = false;
		let ready = false;
		let release: (() => void) | undefined;
		const refresh = () => participant.setReady(booted && acknowledged && ready);
		peer.link.onNotify("pauseState", (reportedEpoch, reportedReady) => {
			if (reportedEpoch !== epoch) return;
			acknowledged = true;
			ready = reportedReady;
			refresh();
		});
		const stop = agentPauseGate.onChange(paused => {
			epoch++;
			acknowledged = false;
			refresh();
			if (paused) release ??= peer.retain?.();
			else {
				release?.();
				release = undefined;
			}
			const requestedEpoch = epoch;
			void peer.link.call("setPaused", paused, epoch).catch(error => {
				if (requestedEpoch === epoch) {
					acknowledged = false;
					refresh();
				}
				logger.error("Subagent pause synchronization failed", { threadId: peer.threadId, error });
			});
		});
		if (agentPauseGate.paused) release = peer.retain?.();
		mainStates.set(peer, {
			globals: () => ({ paused: agentPauseGate.paused, epoch }),
			booted: () => {
				booted = true;
				refresh();
			},
			exited: () => {
				stop();
				release?.();
				participant.setReady(false);
				if (!agentPauseGate.paused) participant.dispose();
				else {
					// A dead/failed peer is not a successful barrier acknowledgement.
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
			if (paused) agentPauseGate.pause();
			else agentPauseGate.resume();
			publish();
		};
		workerStates.set(link, apply);
		agentPauseGate.onWaitersChange(publish);
		link.handle("setPaused", apply);
		link.handle("preparePausedExit", async () => {
			if (!agentPauseGate.ready) throw new Error("Worker has not reached the model-boundary pause barrier");
			const sessions = localAgentSessions();
			const ids: string[] = [];
			await Promise.all(
				sessions.map(async session => {
					await session.sessionManager.ensureOnDisk();
					const id = session.getAgentId();
					if (id && session.isStreaming) ids.push(id);
				}),
			);
			if (!agentPauseGate.ready) throw new Error("Worker left the model-boundary pause barrier during preparation");
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
