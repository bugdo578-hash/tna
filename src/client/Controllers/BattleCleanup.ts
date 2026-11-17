/** Cleanup steps must remain independent, including when a widget was destroyed externally. */
export function battleCleanupStep(name: string, cleanup: () => void): void {
	const [ok, failure] = pcall(cleanup);
	if (!ok) warn(`[BattleTeardown] ${name}: ${tostring(failure)}`);
}
