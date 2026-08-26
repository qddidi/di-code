import { ArrowUpRight, Code2 } from "lucide-react";

export function EmptyState(): React.JSX.Element {
	return <section className="empty-state" aria-labelledby="empty-title"><div className="empty-icon"><Code2 size={22} /></div><h1 id="empty-title">What are we building today?</h1><p>Ask di-code to explore your workspace, write code, or solve a problem.</p><button className="example-link" type="button">Explore your workspace <ArrowUpRight size={15} /></button></section>;
}
