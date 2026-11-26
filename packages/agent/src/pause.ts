/**
 * Process-global pause gate for agent loops.
 *
 * Every agent in a process — main session, in-process subagents, advisor —
 * funnels through the model-call boundary. An in-flight response and every
 * tool call committed by it settle before the loop parks. The same gate tracks
 * model-boundary waiters and host participants so an exit can wait for a
 * continuable transcript, not just a pause request.
 *
 * A run's own `AbortSignal` still unwinds a parked loop immediately: the park
 * releases on abort (without releasing the gate), so cancelling one run never
 * requires resuming the whole process.
 *
 * Hosts drive the singleton {@link agentPauseGate} (e.g. the TUI `/pause`
 * command); library code only ever reads it.
 */

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

export interface AgentPauseParticipant {
	setReady(ready: boolean): void;
	dispose(): void;
}

/** End a parked loop without committing an aborted assistant turn. */
export const PAUSE_SHUTDOWN_ABORT_REASON = Symbol.for("pi-agent-core.pause-shutdown");

/** Freeze switch shared by every agent loop in the process. See module docs. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();
	#waiterListeners = new Set<() => void>();
	#activeLoops = new Set<symbol>();
	#modelWaiters = new Set<symbol>();
	#participants = new Set<{ ready: boolean }>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	get activeLoopCount(): number {
		return this.#activeLoops.size;
	}

	get modelWaiterCount(): number {
		return this.#modelWaiters.size;
	}

	/** All local loops and worker barriers are at their safe point. */
	get ready(): boolean {
		return (
			this.paused &&
			this.#modelWaiters.size === this.#activeLoops.size &&
			[...this.#participants].every(participant => participant.ready)
		);
	}

	registerParticipant(): AgentPauseParticipant {
		const participant = { ready: false };
		this.#participants.add(participant);
		this.#notifyWaiters();
		return {
			setReady: ready => {
				if (!this.#participants.has(participant) || participant.ready === ready) return;
				participant.ready = ready;
				this.#notifyWaiters();
			},
			dispose: () => {
				if (this.#participants.delete(participant)) this.#notifyWaiters();
			},
		};
	}

	registerLoop(): symbol {
		const id = Symbol("agent-loop");
		this.#activeLoops.add(id);
		this.#notifyWaiters();
		return id;
	}

	unregisterLoop(id: symbol): void {
		const hadActive = this.#activeLoops.delete(id);
		const hadWaiter = this.#modelWaiters.delete(id);
		if (hadActive || hadWaiter) this.#notifyWaiters();
	}

	/** Engage the gate. Returns false (and does nothing) when already paused. */
	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		this.#notifyWaiters();
		return true;
	}

	/**
	 * Release the gate, waking every parked loop. Returns the pause duration in
	 * ms, or undefined when the gate was not engaged.
	 */
	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		this.#notifyWaiters();
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Observe changes to the pause barrier, including worker acknowledgement. */
	onWaitersChange(listener: () => void): () => void {
		this.#waiterListeners.add(listener);
		return () => this.#waiterListeners.delete(listener);
	}

	/**
	 * Park until the gate is released. Resolves immediately when not paused.
	 * An abort on `signal` releases only this wait — the gate stays engaged —
	 * so a cancelled run unwinds while the rest of the process stays frozen.
	 */
	async waitUntilResumed(signal?: AbortSignal, loopId?: symbol): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) return;
			const gate = this.#gate.promise;
			if (loopId !== undefined && this.#activeLoops.has(loopId)) {
				this.#modelWaiters.add(loopId);
				this.#notifyWaiters();
			}
			try {
				if (!signal || signal.aborted) {
					if (!signal) await gate;
					continue;
				}
				const abort = Promise.withResolvers<void>();
				const onAbort = () => abort.resolve();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([gate, abort.promise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} finally {
				if (loopId !== undefined && this.#modelWaiters.delete(loopId)) this.#notifyWaiters();
			}
		}
	}

	#notify(paused: boolean): void {
		for (const listener of this.#listeners) {
			try {
				listener(paused);
			} catch {
				// Host UI listeners must never break the gate.
			}
		}
	}

	#notifyWaiters(): void {
		for (const listener of this.#waiterListeners) {
			try {
				listener();
			} catch {
				// A host observer cannot break the gate.
			}
		}
	}
}

/** The process-wide gate polled by the agent loop. */
export const agentPauseGate = new AgentPauseGate();
