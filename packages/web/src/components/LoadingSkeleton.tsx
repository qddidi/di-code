export function LoadingSkeleton(): React.JSX.Element {
	return (
		<section className="conversation-skeleton" aria-busy="true" aria-label="Loading conversation">
			<div className="skeleton-line skeleton-line-short" />
			<div className="skeleton-line skeleton-line-medium" />
			<div className="skeleton-block" />
			<div className="skeleton-line skeleton-line-long" />
		</section>
	);
}
