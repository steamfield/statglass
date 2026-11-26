/**
 * Brings the row a Settings link names (`?focus=<row id>`) into view once it
 * renders, highlights it briefly, and calls `onDone` so the route can drop the
 * param. Lane a implements it (plans/settings-tabs.md).
 */
export function useFocusRow(_focus: string | null, _onDone: () => void): void {}
