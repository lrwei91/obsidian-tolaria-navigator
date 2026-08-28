export interface VirtualRange {
	start: number;
	end: number;
}

export function getVirtualRange(
	itemCount: number,
	rowHeight: number,
	scrollTop: number,
	viewportHeight: number,
	overscan: number
): VirtualRange {
	const safeHeight = Math.max(1, rowHeight);
	const start = Math.max(0, Math.floor(scrollTop / safeHeight) - overscan);
	const visibleCount = Math.ceil(Math.max(0, viewportHeight) / safeHeight);
	return {
		start,
		end: Math.min(itemCount, start + visibleCount + overscan * 2),
	};
}

export function applyTemplate(
	source: string,
	title: string,
	date: string
): string {
	return source.replaceAll("{{title}}", title).replaceAll("{{date}}", date);
}
