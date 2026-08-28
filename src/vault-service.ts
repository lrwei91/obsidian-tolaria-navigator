import { App, TFile, TFolder, getAllTags } from "obsidian";
import {
	isArchivedCache,
	isOrganizedCache,
	normalizeTag,
	parseFrontmatterDate,
	SortDirection,
	SortOption,
} from "./types";
import { pathIsWithin } from "./path-utils";

const dateFmt = new Intl.DateTimeFormat("zh-CN", {
	year: "numeric",
	month: "long",
	day: "numeric",
});

export class VaultService {
	private excerptCache = new Map<
		string,
		{ mtime: number; value: Promise<string> }
	>();

	constructor(private app: App) {}

	allNotes(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	/** 收件箱：未归档且未被整理（organized: true）的笔记，与 Tolaria isInboxEntry 一致 */
	inboxNotes(inboxPath = "inbox"): TFile[] {
		return this.allNotes().filter((f) => {
			const cache = this.app.metadataCache.getFileCache(f);
			return (
				pathIsWithin(f.path, inboxPath) &&
				!isArchivedCache(cache) &&
				!isOrganizedCache(cache)
			);
		});
	}

	/** 全部笔记：未归档的所有笔记，与 Tolaria filter 'all' 一致 */
	activeNotes(): TFile[] {
		return this.allNotes().filter(
			(f) => !isArchivedCache(this.app.metadataCache.getFileCache(f))
		);
	}

	archivedNotes(): TFile[] {
		return this.allNotes().filter((f) =>
			isArchivedCache(this.app.metadataCache.getFileCache(f))
		);
	}

	favoriteNotes(paths: string[]): TFile[] {
		return paths
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile);
	}

	notesInFolder(folderPath: string): TFile[] {
		return this.activeNotes().filter((f) => pathIsWithin(f.path, folderPath));
	}

	notesWithTag(tag: string): TFile[] {
		const wanted = normalizeTag(tag);
		return this.activeNotes().filter((f) => {
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache) return false;
			const tags = getAllTags(cache) ?? [];
			return tags.some((t) => {
				const n = normalizeTag(t);
				return n === wanted || n.startsWith(wanted + "/");
			});
		});
	}

	allTagsSorted(): { tag: string; count: number }[] {
		const counts = new Map<string, number>();
		for (const f of this.activeNotes()) {
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache) continue;
			const tags = getAllTags(cache) ?? [];
			const seen = new Set<string>();
			for (const t of tags) {
				const n = normalizeTag(t);
				if (!n || seen.has(n)) continue;
				seen.add(n);
				counts.set(n, (counts.get(n) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.map(([tag, count]) => ({ tag, count }))
			.filter(({ tag }) => {
			if (/^\d/.test(tag) && !/[a-zA-Z]/.test(tag)) return false;
			return true;
		})
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	}

	rootFolder(): TFolder {
		return this.app.vault.getRoot();
	}

	noteTitle(file: TFile): string {
		const cache = this.app.metadataCache.getFileCache(file);
		const t = cache?.frontmatter?.["title"];
		if (typeof t === "string" && t.trim()) return t.trim();
		const h1 = cache?.headings?.find((h) => h.level === 1);
		if (h1?.heading?.trim()) return h1.heading.trim();
		return file.basename;
	}

	noteCreatedTimestamp(file: TFile): number {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return (
			parseFrontmatterDate(frontmatter?.["created"]) ??
			parseFrontmatterDate(frontmatter?.["date"]) ??
			file.stat.ctime
		);
	}

	noteStatus(file: TFile): string {
		const status = this.app.metadataCache.getFileCache(file)?.frontmatter?.[
			"status"
		];
		return typeof status === "string" ? status.trim() : "";
	}

	sortNotes(
		files: TFile[],
		option: SortOption,
		direction: SortDirection
	): TFile[] {
		const flip = direction === "asc" ? 1 : -1;
		return files.slice().sort((a, b) => {
			let r = 0;
			if (option === "modified") {
				r = a.stat.mtime - b.stat.mtime;
			} else if (option === "created") {
				r = this.noteCreatedTimestamp(a) - this.noteCreatedTimestamp(b);
			} else if (option === "title") {
				r = this.noteTitle(a).localeCompare(this.noteTitle(b), "zh-CN");
			} else {
				const sa = String(
					this.app.metadataCache.getFileCache(a)?.frontmatter?.["status"] ?? ""
				);
				const sb = String(
					this.app.metadataCache.getFileCache(b)?.frontmatter?.["status"] ?? ""
				);
				r = sa.localeCompare(sb, "zh-CN");
			}
			if (r !== 0) return r * flip;
			return b.stat.mtime - a.stat.mtime;
		});
	}

	async excerpt(file: TFile): Promise<string> {
		const cached = this.excerptCache.get(file.path);
		if (cached?.mtime === file.stat.mtime) return cached.value;
		const value = this.readExcerpt(file).catch(() => "");
		this.excerptCache.set(file.path, { mtime: file.stat.mtime, value });
		return value;
	}

	invalidateExcerpt(path: string): void {
		this.excerptCache.delete(path);
	}

	private async readExcerpt(file: TFile): Promise<string> {
		const cache = this.app.metadataCache.getFileCache(file);
		const raw = await this.app.vault.cachedRead(file);
		let lines = raw.split("\n");
		if (cache?.frontmatterPosition) {
			lines = lines.slice(cache.frontmatterPosition.end.line + 1);
		}
		const out: string[] = [];
		let length = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t) continue;
			if (/^#{1,6}\s/.test(t)) continue;
			if (/^(-{3,}|`{3,})/.test(t)) continue;
			if (/^!\[\[/i.test(t)) continue;
			if (/^<!--/.test(t)) continue;
			if (/^>/.test(t)) continue;
			const text = stripInline(t);
			if (!text) continue;
			out.push(text);
			length += text.length;
			if (length > 220) break;
		}
		return out.join(" ").replace(/\s+/g, " ").slice(0, 180).trim();
	}

	formatDate(ts: number): string {
		return dateFmt.format(new Date(ts));
	}
}

function stripInline(line: string): string {
	return line
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, (_m, p1: string) =>
			p1.includes("/") ? p1.split("/").pop() ?? p1 : p1
		)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`]/g, "")
		.trim();
}
