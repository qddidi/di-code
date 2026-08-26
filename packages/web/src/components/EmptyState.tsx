import { Code2, Folder, Sparkles } from "lucide-react";

export function EmptyState(): React.JSX.Element {
	return <section className="empty-state" aria-labelledby="empty-title">
		<div className="empty-brand"><Sparkles size={22} /><span>探索未至之境</span><small>预览版</small></div>
		<h1 id="empty-title">What are we building today?</h1>
		<p>Ask di-code to explore your workspace, write code, or solve a problem.</p>
		<div className="hero-picker-row" aria-label="Current workspace and mode"><span className="hero-picker"><Folder size={15} />Workspace</span><span className="hero-picker"><Code2 size={15} />Standard session</span></div>
	</section>;
}
