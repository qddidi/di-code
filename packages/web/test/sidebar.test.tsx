import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../src/components/Sidebar.tsx";
import { I18nProvider } from "../src/i18n.tsx";

describe("Sidebar workspace navigation", () => {
	it("groups sessions below each workspace", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Sidebar
					collapsed={false}
					workspaces={[{ id: "ai", name: "AI" }, { id: "test", name: "test" }]}
					sessionsByWorkspace={{ ai: [{ id: "one", label: "你好" }], test: [{ id: "two", label: "Build check" }] }}
					activeWorkspaceId="ai"
					activeSessionId="one"
					runningSessionIds={new Set(["two"])}
					onSelectWorkspace={() => undefined}
					onAddWorkspace={async () => ({ id: "added", name: "added" })}
					onToggle={() => undefined}
					onNewSession={() => undefined}
					onOpenSession={() => undefined}
					onSettings={() => undefined}
					onRenameSession={async () => undefined}
					onDeleteSession={async () => undefined}
					onBranchSession={async () => undefined}
					onInspectSession={async () => undefined}
				/>
			</I18nProvider>,
		);
		expect(html).toContain('role="tree"');
		expect(html).toContain('>AI</span>');
		expect(html).toContain('>test</span>');
		expect(html).toContain(">你好</span>");
		expect(html).toContain(">Build check</span>");
		expect(html).toContain('aria-label="Add workspace"');
		expect(html).not.toContain('placeholder="Search sessions" value=""');
	});

	it("marks the selected and running sessions and uses the pencil action", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Sidebar
					collapsed={false}
					workspaces={[{ id: "ai", name: "AI" }]}
					sessionsByWorkspace={{ ai: [{ id: "selected", label: "Selected" }, { id: "running", label: "Running" }] }}
					activeWorkspaceId="ai"
					activeSessionId="selected"
					runningSessionIds={new Set(["running"])}
					onSelectWorkspace={() => undefined}
					onAddWorkspace={async () => ({ id: "added", name: "added" })}
					onToggle={() => undefined}
					onNewSession={() => undefined}
					onOpenSession={() => undefined}
					onSettings={() => undefined}
					onRenameSession={async () => undefined}
					onDeleteSession={async () => undefined}
					onBranchSession={async () => undefined}
					onInspectSession={async () => undefined}
				/>
			</I18nProvider>,
		);
		expect(html).toContain('class="session-item is-active"');
		expect(html).toContain('aria-current="page"');
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain('lucide-message-square');
		expect(html).toContain('lucide-loader-circle');
		expect(html).toContain('lucide-loader-circle spin');
		expect(html).toContain('lucide-pencil');
	});
});
