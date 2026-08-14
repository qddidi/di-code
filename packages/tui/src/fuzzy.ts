export interface FuzzyMatch {
	readonly matches: boolean;
	readonly score: number;
}

function scoreToken(query: string, text: string): FuzzyMatch {
	const normalizedQuery = query.toLocaleLowerCase();
	const normalizedText = text.toLocaleLowerCase();
	if (normalizedQuery.length === 0) return { matches: true, score: 0 };

	let queryIndex = 0;
	let score = 0;
	let previousMatch = -1;
	let consecutive = 0;
	for (let index = 0; index < normalizedText.length && queryIndex < normalizedQuery.length; index += 1) {
		if (normalizedText[index] !== normalizedQuery[queryIndex]) continue;
		const boundary = index === 0 || /[\s\-_./:]/.test(normalizedText[index - 1] ?? "");
		if (previousMatch === index - 1) {
			consecutive += 1;
			score -= consecutive * 5;
		} else if (previousMatch >= 0) {
			consecutive = 0;
			score += (index - previousMatch - 1) * 2;
		}
		if (boundary) score -= 10;
		score += index * 0.1;
		previousMatch = index;
		queryIndex += 1;
	}
	if (queryIndex !== normalizedQuery.length) return { matches: false, score: 0 };
	if (normalizedQuery === normalizedText) score -= 100;
	return { matches: true, score };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const direct = scoreToken(query, text);
	if (direct.matches) return direct;
	const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/i.exec(query);
	const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/i.exec(query);
	const swapped = alphaNumeric
		? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
		: numericAlpha
			? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
			: "";
	if (!swapped) return direct;
	const swappedMatch = scoreToken(swapped, text);
	return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : direct;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter(Boolean);
	if (tokens.length === 0) return [...items];
	return items
		.map((item, index) => {
			const scores = tokens.map((token) => fuzzyMatch(token, getText(item)));
			return {
				item,
				index,
				score: scores.reduce((total, match) => total + match.score, 0),
				matches: scores.every((match) => match.matches),
			};
		})
		.filter((result) => result.matches)
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.map((result) => result.item);
}
