import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const resolvedPath = resolve(filePath);
	const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await operation();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
