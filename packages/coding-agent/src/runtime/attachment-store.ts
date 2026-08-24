import { lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImageContent } from "@di-code/ai";
import type { RpcAttachmentStore } from "../rpc/dispatcher.ts";
import { type RpcAttachmentInfo, RpcProtocolError } from "../rpc/protocol.ts";

export interface ManagedAttachmentStoreOptions {
	readonly directory: string;
	readonly ttlMs?: number;
	readonly maxCount?: number;
	readonly maxBytes?: number;
}

interface StoredAttachment {
	readonly info: RpcAttachmentInfo;
	readonly path: string;
	readonly createdAt: number;
}

/**
 * Creates an actor-owned attachment directory. Only opaque IDs cross the RPC boundary; backing paths remain local
 * and are deleted on consumption, expiration, or host disposal.
 */
export async function createManagedAttachmentStore(
	options: ManagedAttachmentStoreOptions,
): Promise<RpcAttachmentStore> {
	const directory = resolve(options.directory);
	await mkdir(directory, { recursive: true });
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink())
		throw new Error("Managed attachment storage must be a real directory.");
	const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
	const maxCount = options.maxCount ?? 32;
	const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
	const attachments = new Map<string, StoredAttachment>();
	let disposed = false;

	const ensureOpen = (): void => {
		if (disposed) throw new RpcProtocolError("DISPOSED", "Attachment storage has been disposed.");
	};
	const remove = async (id: string): Promise<void> => {
		const attachment = attachments.get(id);
		if (!attachment) return;
		attachments.delete(id);
		await unlink(attachment.path).catch((cause: unknown) => {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
			throw cause;
		});
	};
	const prune = async (): Promise<void> => {
		const cutoff = Date.now() - ttlMs;
		await Promise.all(
			[...attachments.values()].filter((item) => item.createdAt <= cutoff).map((item) => remove(item.info.id)),
		);
	};

	return {
		create: async (input) => {
			ensureOpen();
			await prune();
			const usedBytes = [...attachments.values()].reduce((total, item) => total + item.info.bytes, 0);
			if (attachments.size >= maxCount || usedBytes + input.bytes > maxBytes)
				throw new RpcProtocolError("BUSY", "Attachment storage is full; consume or retry later.");
			const info: RpcAttachmentInfo = {
				id: input.id,
				name: input.name,
				contentType: input.contentType,
				bytes: input.bytes,
			};
			const path = join(directory, `${input.id}.attachment`);
			await writeFile(path, Buffer.from(input.data, "base64"), { flag: "wx" });
			attachments.set(input.id, { info, path, createdAt: Date.now() });
			return info;
		},
		take: async (ids) => {
			ensureOpen();
			await prune();
			const selected = ids.map((id) => {
				const attachment = attachments.get(id);
				if (!attachment) throw new RpcProtocolError("NOT_FOUND", "RPC attachment was not found.");
				return attachment;
			});
			const images: ImageContent[] = [];
			for (const attachment of selected) {
				try {
					images.push({
						type: "image",
						data: (await readFile(attachment.path)).toString("base64"),
						mimeType: attachment.info.contentType,
					});
				} finally {
					await remove(attachment.info.id);
				}
			}
			return images;
		},
		discard: async (ids) => {
			for (const id of ids) await remove(id);
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			attachments.clear();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
