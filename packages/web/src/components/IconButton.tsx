import type { LucideIcon } from "lucide-react";

interface IconButtonProps {
	readonly label: string;
	readonly icon: LucideIcon;
	readonly onClick?: () => void;
	readonly active?: boolean;
}

export function IconButton({ label, icon: Icon, onClick, active = false }: IconButtonProps): React.JSX.Element {
	return (
		<button aria-label={label} className={`icon-button${active ? " is-active" : ""}`} onClick={onClick} type="button" title={label}>
			<Icon size={18} strokeWidth={1.8} />
		</button>
	);
}
