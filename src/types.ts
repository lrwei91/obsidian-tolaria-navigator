import type { CachedMetadata } from "obsidian";

export type FilterKind =
	| "all"
	| "inbox"
	| "archive"
	| "favorite"
	| "folder"
	| "tag";

export interface NoteFilter {
	kind: FilterKind;
	value?: string;
	label: string;
}

export type SortOption = "modified" | "created" | "title" | "status";
export type SortDirection = "asc" | "desc";

export const SORT_OPTIONS: SortOption[] = [
	"modified",
	"created",
	"title",
	"status",
];

export const SORT_LABELS: Record<SortOption, string> = {
	modified: "已修改",
	created: "创建时间",
	title: "标题",
	status: "状态",
};

export function getDefaultDirection(option: SortOption): SortDirection {
	return option === "modified" || option === "created" ? "desc" : "asc";
}

export function filtersEqual(a: NoteFilter | null, b: NoteFilter): boolean {
	if (!a) return false;
	return a.kind === b.kind && a.value === b.value;
}

export function isArchivedFrontmatter(
	fm: Record<string, unknown> | undefined
): boolean {
	if (!fm) return false;
	if (fm["archived"] === true) return true;
	const status = String(fm["status"] ?? "").trim().toLowerCase();
	return status === "archived";
}

export function isArchivedCache(cache: CachedMetadata | null): boolean {
	return isArchivedFrontmatter(cache?.frontmatter);
}

/** 与 Tolaria 一致：organized: true 表示已被整理出收件箱 */
export function isOrganizedCache(cache: CachedMetadata | null): boolean {
	return cache?.frontmatter?.["organized"] === true;
}

export function normalizeTag(tag: string): string {
	return tag.replace(/^#/, "").trim();
}

/** 解析 Obsidian frontmatter 日期；纯日期按本地时区处理，避免 UTC 偏移。 */
export function parseFrontmatterDate(value: unknown): number | null {
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? timestamp : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
	}
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	const dateOnly = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		const date = new Date(Number(year), Number(month) - 1, Number(day));
		if (
			Number.isNaN(date.getTime()) ||
			date.getFullYear() !== Number(year) ||
			date.getMonth() !== Number(month) - 1 ||
			date.getDate() !== Number(day)
		) {
			return null;
		}
		return date.getTime();
	}
	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : timestamp;
}
