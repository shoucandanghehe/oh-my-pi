/**
 * Process-wide flag: a Tern Surface Protocol backend is rendering.
 *
 * Components that animate by re-rendering on a timer (spinners, shimmer,
 * thinking frames, countdowns) check it and skip scheduling, because the
 * terminal clocks motion from the described nodes. Each backend owns its
 * registration, so closing one surface cannot disable another live backend.
 */
const owners = new Set<object>();
const defaultOwner = {};
const listeners = new Set<(on: boolean) => void>();

/** Whether a TSP surface is live in this process. */
export function isNativeRendering(): boolean {
	return owners.size > 0;
}

/** Called by the native backend on surface open and close. */
export function setNativeRendering(on: boolean, owner: object = defaultOwner): void {
	const wasActive = isNativeRendering();
	if (on) owners.add(owner);
	else owners.delete(owner);
	const active = isNativeRendering();
	if (active === wasActive) return;
	for (const listener of listeners) listener(active);
}

/** Call `listener` whenever native rendering starts or stops; returns the unsubscribe. */
export function onNativeRenderingChange(listener: (on: boolean) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
