import { BrainCircuit, FileCode2, Wrench } from "lucide-react";
import type { ContextFile, ToolTrace } from "../types.ts";
import { ToolCard } from "./ToolCard.tsx";

export function Trajectory({ tools, contextFiles, compaction }: { readonly tools: readonly ToolTrace[]; readonly contextFiles: readonly ContextFile[]; readonly compaction?: { readonly state: string; readonly reason: string; readonly error?: string } }): React.JSX.Element {
	return <section className="trajectory" aria-label="Trajectory">
		{compaction ? <div className={`trajectory-row compaction-${compaction.state}`}><BrainCircuit size={15} /><span>Context {compaction.state === "running" ? "compacting" : compaction.state}</span></div> : null}
		{contextFiles.length ? <details className="trajectory-context"><summary><FileCode2 size={15} />Context files ({contextFiles.length})</summary><ul>{contextFiles.map((file) => <li key={file.path}><code>{file.path}</code><span>{file.scope}</span></li>)}</ul></details> : null}
		{tools.length ? tools.map((tool) => <div className="trajectory-row" key={tool.id}><Wrench size={15} /><ToolCard tool={tool} /></div>) : <p className="trajectory-empty">Tool activity will appear here.</p>}
	</section>;
}
