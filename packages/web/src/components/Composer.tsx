import { Activity, Archive, ArrowLeft, ArrowUp, Check, ChevronDown, Command, CornerDownRight, FileClock, Gauge, Paperclip, RotateCcw, Settings2, Square, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AttachmentInfo, UsageSnapshot } from "../types.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";

interface ComposerProps {
	readonly disabled?: boolean;
	readonly busy: boolean;
	readonly attachments: readonly AttachmentInfo[];
	readonly imageInputSupported: boolean;
	readonly onAddFiles: (files: FileList) => Promise<void>;
	readonly onRemoveAttachment: (id: string) => void;
	readonly onSend: (text: string) => Promise<void>;
	readonly onSteer: (text: string) => Promise<void>;
	readonly onCancel: () => Promise<void>;
	readonly onCompact: () => Promise<void>;
	readonly onRetry: () => Promise<void>;
	readonly onNewSession: () => void;
	readonly onOpenSettings: () => void;
	readonly onSetRuntime: (providerId: string, modelId: string) => Promise<void>;
	readonly onSetPermissionMode: (mode: "ask" | "allow" | "deny") => Promise<void>;
	readonly onSetThinkingLevel: (level: "low" | "medium" | "high" | "max") => Promise<void>;
	readonly hero?: boolean;
	readonly modelLabel?: string;
	readonly activeRuntime: { readonly providerId: string; readonly modelId: string };
	readonly permissionMode: "ask" | "allow" | "deny";
	readonly thinkingLevel?: string;
	readonly reasoningEfforts: readonly ("low" | "medium" | "high" | "max")[];
	readonly retryable?: boolean;
	readonly runtimeOptions: readonly {
		readonly providerId: string;
		readonly providerName: string;
		readonly modelId: string;
		readonly label: string;
	}[];
	readonly usage?: UsageSnapshot;
}

const permissionModes = [
	{ id: "ask", label: "Ask before tools" },
	{ id: "allow", label: "Allow tools" },
	{ id: "deny", label: "Deny tools" },
] as const;
export function Composer({ disabled = false, busy, attachments, imageInputSupported, onAddFiles, onRemoveAttachment, onSend, onSteer, onCancel, onCompact, onRetry, onNewSession, onOpenSettings, onSetRuntime, onSetPermissionMode, onSetThinkingLevel, hero = false, modelLabel = "Model", activeRuntime, permissionMode, thinkingLevel, reasoningEfforts, retryable = false, runtimeOptions, usage }: ComposerProps): React.JSX.Element {
	const [text, setText] = useState("");
	const [composing, setComposing] = useState(false);
	const [menu, setMenu] = useState<"commands" | "runtime" | "models" | "reasoning" | "access" | "context">();
	const input = useRef<HTMLInputElement>(null);
	const composer = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!menu) return;
		const closeOnOutsidePointer = (event: PointerEvent): void => {
			if (event.target instanceof Node && !composer.current?.contains(event.target)) setMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setMenu(undefined);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menu]);
	const submit = async (): Promise<void> => {
		const value = text.trim();
		if (!value) return;
		setText("");
		if (busy) await onSteer(value); else await onSend(value);
	};
	return <div className={`composer-wrap${hero ? " composer-hero" : ""}`}>
		<div ref={composer} className="composer" onDragOver={(event) => { if (imageInputSupported) event.preventDefault(); }} onDrop={(event) => { if (!imageInputSupported) return; event.preventDefault(); void onAddFiles(event.dataTransfer.files); }}>
			<AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
			<textarea aria-label="Message di-code" placeholder={busy ? "Steer di-code while it works" : hero ? "Describe what you want to build" : "Message di-code"} rows={1} disabled={disabled} value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => { if (imageInputSupported && event.clipboardData.files.length) void onAddFiles(event.clipboardData.files); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing) { event.preventDefault(); void submit(); } }} />
			<input className="attachment-input" ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { if (event.currentTarget.files) void onAddFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
			<div className="composer-toolbar">
				<div className="composer-menu-anchor"><button className="composer-tool" type="button" aria-label="Commands" title="Commands" aria-expanded={menu === "commands"} onClick={() => setMenu((value) => value === "commands" ? undefined : "commands")}><Command size={16} /></button>{menu === "commands" ? <div className="composer-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenu(undefined); onNewSession(); }}><FileClock size={15} />New session</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); void onCompact(); }}><Gauge size={15} />Compact context</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); onOpenSettings(); }}><Settings2 size={15} />Open settings</button></div> : null}</div>
				<button className="composer-tool" type="button" aria-label={imageInputSupported ? "Add attachment" : "Current model does not support image input"} title={imageInputSupported ? "Add attachment" : "Current model does not support image input"} onClick={() => input.current?.click()} disabled={disabled || !imageInputSupported || attachments.length >= 4}><Paperclip size={16} /></button>
				<div className="composer-menu-anchor"><button className="access-mode" type="button" aria-label={`Permission mode, current: ${permissionModes.find((option) => option.id === permissionMode)?.label}`} aria-expanded={menu === "access"} onClick={() => setMenu((value) => value === "access" ? undefined : "access")}><SlidersHorizontal size={14} />{permissionModes.find((option) => option.id === permissionMode)?.label}<ChevronDown size={13} /></button>{menu === "access" ? <div className="composer-menu" role="menu" aria-label="Permission mode">{permissionModes.map((option) => <button type="button" role="menuitemradio" aria-checked={option.id === permissionMode} key={option.id} onClick={() => { setMenu(undefined); void onSetPermissionMode(option.id); }}><span>{option.label}</span>{option.id === permissionMode ? <Check size={14} aria-label="Selected" /> : null}</button>)}</div> : null}</div>
				<span className="composer-spacer" />
				<div className="composer-menu-anchor">
					<button className="model-select" type="button" aria-label={`Select model, current ${modelLabel}`} aria-expanded={menu === "runtime" || menu === "models" || menu === "reasoning"} onClick={() => setMenu((value) => value === "runtime" || value === "models" || value === "reasoning" ? undefined : "runtime")}><span>{modelLabel}</span><ChevronDown size={13} /></button>
					{menu === "runtime" ? <div className="composer-menu composer-menu-right" role="menu" aria-label="Model and reasoning"><button type="button" role="menuitem" onClick={() => setMenu("models")}><span className="menu-item-copy"><small>Model</small>{modelLabel}</span><ChevronDown size={14} /></button>{reasoningEfforts.length ? <button type="button" role="menuitem" onClick={() => setMenu("reasoning")}><span className="menu-item-copy"><small>Reasoning</small>{thinkingLevel ?? "default"}</span><ChevronDown size={14} /></button> : null}</div> : null}
					{menu === "models" ? <div className="composer-menu composer-menu-right composer-model-menu" role="menu" aria-label="Models"><button type="button" className="menu-back" role="menuitem" onClick={() => setMenu("runtime")}><ArrowLeft size={14} />Model and reasoning</button>{Array.from(new Map(runtimeOptions.map((option) => [option.providerId, option.providerName])).entries()).map(([providerId, providerName]) => <div className="model-group" key={providerId}><p>{providerName}</p>{runtimeOptions.filter((option) => option.providerId === providerId).map((option) => { const selected = option.providerId === activeRuntime.providerId && option.modelId === activeRuntime.modelId; return <button type="button" role="menuitemradio" aria-checked={selected} key={`${option.providerId}/${option.modelId}`} onClick={() => { setMenu(undefined); void onSetRuntime(option.providerId, option.modelId); }}><span>{option.label}</span>{selected ? <Check size={14} aria-label="Selected" /> : null}</button>; })}</div>)}</div> : null}
					{menu === "reasoning" ? <div className="composer-menu composer-menu-right" role="menu" aria-label="Reasoning level"><button type="button" className="menu-back" role="menuitem" onClick={() => setMenu("runtime")}><ArrowLeft size={14} />Model and reasoning</button>{reasoningEfforts.map((level) => <button type="button" role="menuitemradio" aria-checked={thinkingLevel === level} key={level} onClick={() => { setMenu(undefined); void onSetThinkingLevel(level); }}><span>{level[0].toUpperCase() + level.slice(1)}</span>{thinkingLevel === level ? <Check size={14} aria-label="Selected" /> : null}</button>)}</div> : null}
				</div>
				<div className="composer-menu-anchor"><button className="context-meter" type="button" aria-label="Context usage" aria-expanded={menu === "context"} onClick={() => setMenu((value) => value === "context" ? undefined : "context")}>{usage?.contextWindow && usage.estimatedContextTokens ? `${Math.min(100, Math.round(usage.estimatedContextTokens / usage.contextWindow * 100))}%` : "0%"}</button>{menu === "context" ? <div className="composer-menu composer-menu-right context-menu" role="status"><strong>Context usage</strong><span>{usage?.estimatedContextTokens ?? 0} estimated tokens</span><span>{usage?.contextWindow ?? 0} token window</span><span>{usage?.cacheReadTokens ?? 0} cache tokens</span></div> : null}</div>
				{busy ? <button className="send-button cancel-button" type="button" aria-label="Stop generating" title="Stop generating" onClick={() => void onCancel()}><Square size={14} /></button> : <button className="send-button" type="button" aria-label="Send message" title="Send message" disabled={disabled || !text.trim()} onClick={() => void submit()}>{busy ? <CornerDownRight size={18} /> : <ArrowUp size={18} />}</button>}
			</div>
			{!hero ? <div className="composer-session-meta" aria-live="polite"><span><Activity size={13} />{usage?.requestCount ?? 0} requests</span><span>Context {usage?.estimatedContextTokens?.toLocaleString() ?? 0}/{usage?.contextWindow?.toLocaleString() ?? 0}</span><span className="composer-spacer" />{!busy ? <button type="button" onClick={() => void onCompact()}><Archive size={13} />Compact context</button> : null}{retryable ? <button type="button" onClick={() => void onRetry()}><RotateCcw size={13} />Retry</button> : null}</div> : null}
		</div>
		{!hero ? <p className="composer-note">Session messages and accepted attachments are retained in the local session history.</p> : null}
	</div>;
}
