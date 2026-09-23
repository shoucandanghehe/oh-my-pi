import type { Component } from "./tui";

let animationOnlyTargets: ReadonlySet<Component> | undefined;

/**
 * Carry paint-only invalidations through synchronous composition without changing
 * every viewport adapter's target-routing interface. Nested paints restore their
 * caller's context; nothing remains classified after the frame returns.
 */
export function withAnimationOnlyRenderTargets<T>(targets: ReadonlySet<Component> | undefined, render: () => T): T {
	const previous = animationOnlyTargets;
	animationOnlyTargets = targets;
	try {
		return render();
	} finally {
		animationOnlyTargets = previous;
	}
}

/** Content/geometry invalidations are the default, including unscoped paints. */
export function isAnimationOnlyRenderTarget(component: Component): boolean {
	return animationOnlyTargets?.has(component) === true;
}
