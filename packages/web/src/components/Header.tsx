interface HeaderProps {
	readonly connected: boolean;
	readonly error: boolean;
}

export function Header({ connected, error }: HeaderProps): React.JSX.Element {
	const status = connected ? "Connected" : error ? "Unavailable" : "Connecting";
	const statusClass = connected ? "status ready" : error ? "status error" : "status";
	return (
		<header>
			<div className="brand">di-code</div>
			<span className={statusClass}>{status}</span>
		</header>
	);
}
