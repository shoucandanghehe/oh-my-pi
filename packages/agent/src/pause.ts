/**
 * Process-global pause gate for agent loops.
 *
 * Every agent in a process — main session, in-process subagents, advisor —
 * funnels through {@link ../agent-loop!agentLoop}, which polls this gate at the
 * model-call boundary (before each provider request). Engaging the gate freezes
 * all of them at the next safe point without aborting anything: in-flight
 * provider streams and already-started tool executions run to completion, then
 * every loop parks until {@link AgentPauseGate.resume}. Queued steering/follow-up
 * messages stay queued and deliver normally after resume.
 *
 * The gate also tracks active loops and model-boundary waiters so a host can
 * know when every live loop has reached the durable pause point (ready to exit
 * the process without synthesizing an aborted turn).
 *
 * A run's own `AbortSignal` still unwinds a parked loop immediately: the park
 * releases on abort (without releasing the gate), so cancelling one run never
 * requires resuming the whole process. Hosts that dispose while paused SHOULD
 * abort with {@link PAUSE_SHUTDOWN_ABORT_REASON} so parked loops end without
 * appending an aborted assistant message.
 *
 * Hosts drive the singleton {@link agentPauseGate} (e.g. the TUI `/pause`
 * command); library code only ever reads it.
 */

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

/** Listener invoked whenever active-loop or waiter membership changes. */
export type AgentPauseWaitersListener = () => void;

/**
 * Abort reason for dispose/exit while the pause gate is holding loops at the
 * model boundary. The agent loop ends cleanly without synthesizing an aborted
 * assistant turn so a later `/continue` can resume from the last durable tail.
 */
export const PAUSE_SHUTDOWN_ABORT_REASON = Symbol.for("pi-agent-core.pause-shutdown");

/** Freeze switch shared by every agent loop in the process. See module docs. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();
	#waiterListeners = new Set<AgentPauseWaitersListener>();
	/** Live agent-loop instances currently inside {@link ../agent-loop!runLoop}. */
	#activeLoops = new Set<symbol>();
	/** Active loops currently parked at the model-call boundary. */
	#modelWaiters = new Set<symbol>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	/** Number of agent loops currently running in this process. */
	get activeLoopCount(): number {
		return this.#activeLoops.size;
	}

	/** Number of loops parked at the model-call boundary. */
	get modelWaiterCount(): number {
		return this.#modelWaiters.size;
	}

	/**
	 * True when the gate is engaged and every active loop is parked at the
	 * model-call boundary (or there are no active loops). Hosts use this to
	 * decide when a process exit would leave a durable, continuable transcript.
	 */
	get ready(): boolean {
		return this.#gate !== undefined && this.#modelWaiters.size === this.#activeLoops.size;
	}

	/** Register a live agent loop. Returns an opaque id for later wait/unregister. */
	registerLoop(): symbol {
		const id = Symbol("agent-loop");
		this.#activeLoops.add(id);
		this.#notifyWaiters();
		return id;
	}

	/** Drop a previously registered loop (and any waiter it still holds). */
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
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Subscribe to active-loop / model-waiter membership changes. */
	onWaitersChange(listener: AgentPauseWaitersListener): () => void {
		this.#waiterListeners.add(listener);
		return () => this.#waiterListeners.delete(listener);
	}

	/**
	 * Park until the gate is released. Resolves immediately when not paused.
	 * An abort on `signal` releases only this wait — the gate stays engaged —
	 * so a cancelled run unwinds while the rest of the process stays frozen.
	 *
	 * `loopId` from {@link registerLoop} is required for barrier readiness
	 * accounting. Omitting it still parks the caller but does not count toward
	 * {@link ready} — only used by tests that exercise the gate without a loop.
	 */
	async waitUntilResumed(signal?: AbortSignal, loopId?: symbol): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) return;
			const gate = this.#gate.promise;
			if (loopId !== undefined && this.#activeLoops.has(loopId) && !this.#modelWaiters.has(loopId)) {
				this.#modelWaiters.add(loopId);
				this.#notifyWaiters();
			}
			try {
				if (!signal) {
					await gate;
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
				if (loopId !== undefined && this.#modelWaiters.delete(loopId)) {
					this.#notifyWaiters();
				}
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
				// Host UI listeners must never break the gate.
			}
		}
	}
}

/** The process-wide gate polled by the agent loop. */
export const agentPauseGate = new AgentPauseGate();
