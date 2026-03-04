/**
 * Haptic feedback utilities for touch interactions.
 *
 * Uses the Vibration API (navigator.vibrate) which is supported on
 * Android Chrome and some other mobile browsers. iOS Safari does not
 * support it, but the calls are safe no-ops.
 *
 * Intensity patterns:
 *   light  – subtle tap for navigation, toggles, selections
 *   medium – button presses, confirmations
 *   heavy  – destructive actions, important state changes
 *   error  – double-buzz for errors / denied actions
 */

const SUPPORTS_VIBRATION = typeof navigator !== 'undefined' && 'vibrate' in navigator;

/** Light tap — navigation, tab switch, toggle, selection */
export function hapticLight(): void {
	if (SUPPORTS_VIBRATION) navigator.vibrate(10);
}

/** Medium tap — button press, confirm, send */
export function hapticMedium(): void {
	if (SUPPORTS_VIBRATION) navigator.vibrate(30);
}

/** Heavy tap — destructive action, stop, abort */
export function hapticHeavy(): void {
	if (SUPPORTS_VIBRATION) navigator.vibrate(50);
}

/** Error / denied — double-buzz pattern */
export function hapticError(): void {
	if (SUPPORTS_VIBRATION) navigator.vibrate([30, 50, 30]);
}

/** Success — short double-tap */
export function hapticSuccess(): void {
	if (SUPPORTS_VIBRATION) navigator.vibrate([15, 40, 15]);
}
