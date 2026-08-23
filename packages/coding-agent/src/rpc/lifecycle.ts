/**
 * Disposes the composition after RPC stdout has flushed. Both owners are always released so a
 * failure in one Fiber cannot retain process, stream, or session resources from the other.
 */
export async function disposeRpcComposition(
	disposeLoader: () => void | Promise<void>,
	disposeContext: () => void | Promise<void>,
): Promise<void> {
	const failures: Error[] = [];
	try {
		await disposeLoader();
	} catch (cause) {
		failures.push(cause instanceof Error ? cause : new Error(String(cause)));
	}
	try {
		await disposeContext();
	} catch (cause) {
		failures.push(cause instanceof Error ? cause : new Error(String(cause)));
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "RPC composition disposal failed");
}
