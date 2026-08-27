import { Activity, Archive, ArrowLeft, ArrowUp, Check, ChevronDown, Command, CornerDownRight, FileClock, Gauge, Paperclip, RotateCcw, Settings2, Square, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AttachmentInfo, CommandAction, CommandSummary, UsageSnapshot } from "../types.ts";
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
	readonly onRunCommand: (name: string, args: string) => Promise<CommandAction | undefined>;
	readonly onRetry: () => Promise<void>;
	readonly onClear: () => void;
	readonly onOpenSessions: () => void;
	readonly onOpenTree: () => void;
	readonly onOpenUsage: () => void;
	readonly onOpenSettings: () => void;
	readonly onLogout: () => Promise<void>;
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
	readonly commands: readonly CommandSummary[];
	readonly restoredDraft?: { readonly id: string; readonly text: string };
}

const permissionModes = [
	{ id: "ask", label: "Ask before tools" },
	{ id: "allow", label: "Allow tools" },
	{ id: "deny", label: "Deny tools" },
] as const;
function commandIcon(name: string): typeof Command {
	if (name === "new" || name === "session") return FileClock;
	if (name === "compact") return Gauge;
	if (name === "settings" || name === "theme" || name === "login" || name === "logout") return Settings2;
	if (name === "retry") return RotateCcw;
	return Command;
}
const hiddenCommands = new Set(["help", "clear", "logout"]);

function commandRequiresInput(command: CommandSummary): boolean {
	return command.kind === "skill" || command.name === "steer";
}

export function Composer({ disabled = false, busy, attachments, imageInputSupported, onAddFiles, onRemoveAttachment, onSend, onSteer, onCancel, onCompact, onRunCommand, onRetry, onClear, onOpenSessions, onOpenTree, onOpenUsage, onOpenSettings, onLogout, onSetRuntime, onSetPermissionMode, onSetThinkingLevel, hero = false, modelLabel = "Model", activeRuntime, permissionMode, thinkingLevel, reasoningEfforts, retryable = false, runtimeOptions, usage, commands, restoredDraft }: ComposerProps): React.JSX.Element {
	const [text, setText] = useState("");
	const [composing, setComposing] = useState(false);
	const [menu, setMenu] = useState<"commands" | "runtime" | "models" | "reasoning" | "access" | "context">();
	const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const composer = useRef<HTMLDivElement>(null);
	const commandMenuId = useId();
	const commandQuery = text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
	const matchingCommands = useMemo(
		() => commands.filter((command) => !hiddenCommands.has(command.name) && command.name.includes(commandQuery)),
		[commands, commandQuery],
	);
	const executeCommand = async (command: CommandSummary, args: string): Promise<void> => {
		const action = await onRunCommand(command.name, args);
		if (!action) return;
		setMenu(undefined);
		switch (action.command) {
			case "help":
				setMenu("commands");
				break;
			case "clear":
				onClear();
				break;
			case "model":
				setMenu("models");
				break;
			case "session":
				onOpenSessions();
				break;
			case "tree":
				onOpenTree();
				break;
			case "theme":
			case "settings":
			case "login":
				onOpenSettings();
				break;
			case "logout":
				await onLogout();
				break;
			case "compact":
				await onCompact();
				break;
			case "usage":
				onOpenUsage();
				break;
			case "retry":
				await onRetry();
				break;
			case "steer":
				if (action.args.trim()) await onSteer(action.args);
				break;
		}
	};
	const selectCommand = (command: CommandSummary): void => {
		if (!commandRequiresInput(command)) {
			setText("");
			void executeCommand(command, "");
			return;
		}
		setMenu(undefined);
		setText(`/${command.name} `);
		requestAnimationFrame(() => textarea.current?.focus());
	};
	useEffect(() => {
		setSelectedCommandIndex(0);
	}, [commandQuery, menu]);
	useEffect(() => {
		if (!restoredDraft) return;
		setText(restoredDraft.text);
		setMenu(undefined);
		requestAnimationFrame(() => textarea.current?.focus());
	}, [restoredDraft]);
	useEffect(() => {
		if (menu !== "commands" || matchingCommands.length === 0) return;
		document.getElementById(`${commandMenuId}-${selectedCommandIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [commandMenuId, matchingCommands.length, menu, selectedCommandIndex]);
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
		if (value.startsWith("/")) {
			const [name, ...argParts] = value.slice(1).split(/\s+/);
			const command = commands.find((candidate) => candidate.name === name);
			if (command?.kind === "command") {
				setText("");
				await executeCommand(command, argParts.join(" "));
				return;
			}
		}
		setText("");
		if (busy) await onSteer(value); else await onSend(value);
	};
	return <div className={`composer-wrap${hero ? " composer-hero" : ""}`}>
		<div ref={composer} className="composer" onDragOver={(event) => { if (imageInputSupported) event.preventDefault(); }} onDrop={(event) => { if (!imageInputSupported) return; event.preventDefault(); void onAddFiles(event.dataTransfer.files); }}>
			<AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
			<textarea ref={textarea} aria-label="Message di-code" aria-controls={menu === "commands" ? commandMenuId : undefined} aria-activedescendant={menu === "commands" && matchingCommands.length ? `${commandMenuId}-${selectedCommandIndex}` : undefined} placeholder={busy ? "Steer di-code while it works" : hero ? "Describe what you want to build" : "Message di-code"} rows={1} disabled={disabled} value={text} onChange={(event) => { const next = event.target.value; setText(next); setSelectedCommandIndex(0); setMenu((current) => next.startsWith("/") ? "commands" : current === "commands" ? undefined : current); }} onPaste={(event) => { if (imageInputSupported && event.clipboardData.files.length) void onAddFiles(event.clipboardData.files); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => {
				if (menu === "commands" && matchingCommands.length && !composing) {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setSelectedCommandIndex((current) => (current + 1) % matchingCommands.length);
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setSelectedCommandIndex((current) => (current - 1 + matchingCommands.length) % matchingCommands.length);
						return;
					}
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						const command = matchingCommands[selectedCommandIndex];
						if (command) selectCommand(command);
						return;
					}
				}
				if (event.key === "Enter" && !event.shiftKey && !composing) { event.preventDefault(); void submit(); }
			}} />
			<input className="attachment-input" ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { if (event.currentTarget.files) void onAddFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
			<div className="composer-toolbar">
				<div className="composer-menu-anchor"><button className="composer-tool" type="button" aria-label="Commands" title="Commands" aria-expanded={menu === "commands"} aria-controls={menu === "commands" ? commandMenuId : undefined} onClick={() => { const opening = menu !== "commands"; setSelectedCommandIndex(0); setMenu(opening ? "commands" : undefined); if (opening) requestAnimationFrame(() => textarea.current?.focus()); }}><Command size={16} /></button>{menu === "commands" ? <div id={commandMenuId} className="composer-menu composer-command-menu" role="listbox" aria-label="Commands">{matchingCommands.length ? matchingCommands.map((command, index) => { const Icon = commandIcon(command.name); return <button id={`${commandMenuId}-${index}`} type="button" role="option" aria-selected={index === selectedCommandIndex} className={index === selectedCommandIndex ? "is-selected" : undefined} key={command.name} onMouseEnter={() => setSelectedCommandIndex(index)} onClick={() => selectCommand(command)}><Icon size={15} /><span className={`menu-item-copy${command.kind === "skill" ? " menu-item-skill" : ""}`}><strong>/{command.name}</strong><small>{command.description}</small></span></button>; }) : <p>No matching commands</p>}</div> : null}</div>
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
