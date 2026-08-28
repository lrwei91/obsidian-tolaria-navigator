import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import type { DashboardTask } from "./settings";
import { dateKey, todayKey } from "./list-utils";

export const VIEW_TYPE_TOLARIA_HOME = "tolaria-home-dashboard-view";

const DAY_MS = 86_400_000;
const COLORS = ["#a8a4e6", "#69c7a8", "#e0b341", "#6aa5e0"];
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function parseDate(key: string): Date {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year, month - 1, day);
}

function addDays(date: Date, amount: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function relativeTime(timestamp: number): string {
	const delta = Date.now() - timestamp;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	const date = new Date(timestamp);
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (timestamp >= start) {
		return `今天 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}
	if (timestamp >= start - DAY_MS) return "昨天";
	const days = Math.floor((start - timestamp) / DAY_MS) + 1;
	return days < 7 ? `${days} 天前` : `${date.getMonth() + 1}月${date.getDate()}日`;
}

function colorFor(value: string): string {
	let hash = 0;
	for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return COLORS[hash % COLORS.length];
}

function wordCount(source: string): number {
	let body = source;
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end >= 0) body = body.slice(end + 4);
	}
	const cjk = body.match(/[㐀-鿿぀-ヿ가-힯]/g)?.length ?? 0;
	const latin = body.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g)?.length ?? 0;
	return cjk + latin;
}

function uniqueId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class DashboardData {
	files: TFile[] = [];
	totalNotes = 0;
	totalFolders = 0;
	activeDays = 0;
	currentStreak = 0;
	longestStreak = 0;
	productiveHour = "—";
	newThisMonth = 0;
	totalWords = 0;
	totalWordsReady = false;
	countByDay = new Map<string, number>();
	createdByDay = new Map<string, TFile[]>();

	constructor(private view: HomeDashboardView) {}

	computeQuick(): void {
		const files = this.view.app.vault.getMarkdownFiles();
		this.files = files.slice().sort((a, b) => b.stat.mtime - a.stat.mtime);
		this.totalNotes = files.length;
		const folders = new Set<string>();
		const modified = new Map<string, number>();
		const created = new Map<string, TFile[]>();
		const hours = new Array<number>(24).fill(0);
		const now = new Date();
		const currentMonth = now.getFullYear() * 100 + now.getMonth();
		let monthCount = 0;

		for (const file of files) {
			const folder = file.parent?.path ?? "";
			if (folder && folder !== "/") folders.add(folder);
			const modifiedDate = new Date(file.stat.mtime);
			const modifiedKey = dateKey(modifiedDate);
			modified.set(modifiedKey, (modified.get(modifiedKey) ?? 0) + 1);
			hours[modifiedDate.getHours()]++;
			const createdDate = new Date(this.view.createdTimestamp(file));
			const createdKey = dateKey(createdDate);
			const createdFiles = created.get(createdKey) ?? [];
			createdFiles.push(file);
			created.set(createdKey, createdFiles);
			if (createdDate.getFullYear() * 100 + createdDate.getMonth() === currentMonth) {
				monthCount++;
			}
		}

		this.totalFolders = folders.size;
		this.countByDay = modified;
		this.createdByDay = created;
		this.activeDays = modified.size;
		this.newThisMonth = monthCount;
		let bestCount = 0;
		let bestHour = -1;
		for (let hour = 0; hour < hours.length; hour++) {
			if (hours[hour] > bestCount) {
				bestCount = hours[hour];
				bestHour = hour;
			}
		}
		this.productiveHour = bestHour < 0 ? "—" : `${String(bestHour).padStart(2, "0")}:00`;
		this.currentStreak = this.calculateCurrentStreak(modified);
		this.longestStreak = this.calculateLongestStreak(modified);
	}

	async computeWords(shouldContinue?: () => boolean): Promise<void> {
		let total = 0;
		const CHUNK = 25;
		for (let index = 0; index < this.files.length; index += CHUNK) {
			for (const file of this.files.slice(index, index + CHUNK)) {
				total += await this.view.countWords(file);
			}
			if (shouldContinue && !shouldContinue()) return;
			if (index + CHUNK < this.files.length) {
				// 大库首次统计分块让出主线程，避免长时间阻塞 UI
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
		}
		this.totalWords = total;
		this.totalWordsReady = true;
	}

	private calculateCurrentStreak(days: Map<string, number>): number {
		const cursor = new Date();
		if (!days.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
		let count = 0;
		while (days.has(dateKey(cursor))) {
			count++;
			cursor.setDate(cursor.getDate() - 1);
		}
		return count;
	}

	private calculateLongestStreak(days: Map<string, number>): number {
		let longest = 0;
		let current = 0;
		let previous: number | null = null;
		for (const key of [...days.keys()].sort()) {
			const timestamp = parseDate(key).getTime();
			current = previous !== null && timestamp - previous === DAY_MS ? current + 1 : 1;
			longest = Math.max(longest, current);
			previous = timestamp;
		}
		return longest;
	}
}

interface DashboardPanels {
	overview?: HTMLElement;
	recent?: HTMLElement;
	nav?: HTMLElement;
	calendar?: HTMLElement;
	agenda?: HTMLElement;
	favorites?: HTMLElement;
}

interface NavGroup {
	key: string;
	title: string;
	color: string;
	items: Array<{ file: TFile; title: string; summary: string }>;
}

export class HomeDashboardView extends ItemView {
	private data = new DashboardData(this);
	private panels: DashboardPanels = {};
	private selectedDate = todayKey();
	private range: "all" | "30" | "7" = "all";
	private calendarYear = new Date().getFullYear();
	private calendarMonth = new Date().getMonth();
	private wordCache = new Map<string, { mtime: number; count: number }>();
	private toastEl: HTMLElement | null = null;
	private toastTimer = 0;
	private resizeTimer = 0;
	private renderGeneration = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: TolariaNavigatorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TOLARIA_HOME;
	}

	getDisplayText(): string {
		return "主页控制台";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.buildSkeleton();
		this.refresh(true);
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.toastTimer);
		window.clearTimeout(this.resizeTimer);
	}

	onResize(): void {
		super.onResize();
		// 热力图整块重建开销大，resize 抖动期间合并成一次
		window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => this.renderOverview(), 150);
	}

	/** 内容编辑后的轻量刷新：跳过分类导航与收藏面板，只重建受时间影响的视图。 */
	refreshChanged(_files: TFile[]): void {
		const generation = ++this.renderGeneration;
		const previousWords = this.data.totalWords;
		const previousWordsReady = this.data.totalWordsReady;
		const previousCache = new Map(this.wordCache);
		const data = new DashboardData(this);
		this.data = data;
		data.computeQuick();
		if (previousWordsReady) {
			data.totalWords = previousWords;
			data.totalWordsReady = true;
		}
		this.renderOverview();
		this.renderRecent();
		this.renderCalendar();
		void this.applyWordDeltas(data, previousCache, generation);
	}

	refresh(recomputeWords = true): void {
		const generation = ++this.renderGeneration;
		const previousWords = this.data.totalWords;
		const previousWordsReady = this.data.totalWordsReady;
		const previousCache = new Map(this.wordCache);
		const data = new DashboardData(this);
		this.data = data;
		data.computeQuick();
		const currentPaths = new Set(data.files.map((file) => file.path));
		for (const path of this.wordCache.keys()) {
			if (!currentPaths.has(path)) this.wordCache.delete(path);
		}
		if (!recomputeWords && previousWordsReady) {
			data.totalWords = previousWords;
			data.totalWordsReady = true;
		}
		this.renderAll();
		if (recomputeWords || !previousWordsReady) {
			void data
				.computeWords(
					() => generation === this.renderGeneration && this.data === data
				)
				.then(() => {
					if (generation === this.renderGeneration && this.data === data) this.renderOverview();
				});
		} else {
			// 编辑后按增量修正总字数，而不是沿用旧值
			void this.applyWordDeltas(data, previousCache, generation);
		}
	}

	private async applyWordDeltas(
		data: DashboardData,
		previousCache: Map<string, { mtime: number; count: number }>,
		generation: number
	): Promise<void> {
		const stale = data.files.filter(
			(file) => previousCache.get(file.path)?.mtime !== file.stat.mtime
		);
		for (const file of stale) {
			const previous = previousCache.get(file.path)?.count ?? 0;
			const count = await this.countWords(file);
			data.totalWords += count - previous;
		}
		if (stale.length && generation === this.renderGeneration && this.data === data) {
			this.renderOverview();
		}
	}

	async countWords(file: TFile): Promise<number> {
		const cached = this.wordCache.get(file.path);
		if (cached?.mtime === file.stat.mtime) return cached.count;
		try {
			const count = wordCount(await this.app.vault.cachedRead(file));
			this.wordCache.set(file.path, { mtime: file.stat.mtime, count });
			return count;
		} catch (error) {
			console.warn("[Tolaria] 统计字数失败", file.path, error);
			this.wordCache.set(file.path, { mtime: file.stat.mtime, count: 0 });
			return 0;
		}
	}

	createdTimestamp(file: TFile): number {
		return this.plugin.service.noteCreatedTimestamp(file);
	}

	renderFavorites(): void {
		const panel = this.panels.favorites;
		if (!panel) return;
		panel.empty();
		panel.append(this.header("star", "收藏", "Favorites"));
		const list = panel.createDiv("ohd-list");
		const favorites = this.plugin.settings.dashboard.favorites;
		if (!favorites.length) {
			list.createDiv({ cls: "ohd-empty", text: "右键任意笔记 → 添加到控制台收藏" });
			return;
		}
		for (const path of favorites) {
			const file = this.app.vault.getAbstractFileByPath(path);
			const row = list.createDiv("ohd-row");
			row.addEventListener("click", () => this.openPath(path));
			const dot = row.createSpan("ohd-dot");
			dot.style.background = colorFor(path);
			const main = row.createDiv("ohd-row-main");
			main.createSpan({ cls: "ohd-row-title", text: file instanceof TFile ? file.basename : path.replace(/\.md$/, "") });
			main.createSpan({ cls: "ohd-row-sub", text: file instanceof TFile ? this.folderLabel(file) : "（已删除）" });
			const remove = row.createEl("button", { cls: "ohd-row-del", text: "×", attr: { title: "移除收藏", "aria-label": "移除收藏" } });
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.toggleDashboardFavorite(path);
			});
		}
	}

	private buildSkeleton(): void {
		this.contentEl.empty();
		this.contentEl.addClass("ohd-host");
		const scroll = this.contentEl.createDiv("ohd-scroll");
		const root = scroll.createDiv("ohd-root");
		const top = root.createDiv("ohd-layout-row ohd-row-a");
		this.panels.overview = top.createDiv("ohd-card ohd-overview");
		this.panels.recent = top.createDiv("ohd-card ohd-recent");
		this.panels.nav = root.createDiv("ohd-card ohd-nav");
		const bottom = root.createDiv("ohd-layout-row ohd-row-c");
		this.panels.calendar = bottom.createDiv("ohd-card ohd-calendar");
		this.panels.agenda = bottom.createDiv("ohd-card ohd-agenda");
		this.panels.favorites = bottom.createDiv("ohd-card ohd-favorites");
	}

	private renderAll(): void {
		this.renderOverview();
		this.renderRecent();
		this.renderNavigation();
		this.renderCalendar();
		this.renderAgenda();
		this.renderFavorites();
	}

	private header(icon: string, title: string, subtitle: string, action?: HTMLElement): HTMLElement {
		const header = document.createElement("div");
		header.className = "ohd-head";
		const left = header.createDiv("ohd-head-left");
		const iconEl = left.createSpan("ohd-ic");
		setIcon(iconEl, icon);
		left.createSpan({ cls: "ohd-h-title", text: title });
		left.createSpan({ cls: "ohd-h-sub", text: subtitle });
		if (action) header.append(action);
		return header;
	}

	private renderOverview(): void {
		const panel = this.panels.overview;
		if (!panel) return;
		panel.empty();
		panel.append(this.header("chart-no-axes-column-increasing", "笔记概览", "Overview", this.rangeControl()));
		const stats = panel.createDiv("ohd-stats");
		for (const [label, value] of this.statsData()) {
			const stat = stats.createDiv("ohd-stat");
			stat.createSpan({ cls: "ohd-stat-label", text: label });
			stat.createSpan({ cls: "ohd-stat-value", text: value });
		}
		const availableWidth = Math.max(320, panel.clientWidth - 36);
		const fitWeeks = Math.max(14, Math.min(53, Math.floor((availableWidth + 4) / 17)));
		const configuredWeeks = this.plugin.settings.dashboard.heatmapWeeks;
		panel.append(this.heatmap(Math.min(configuredWeeks, fitWeeks)));
		const footer = panel.createDiv("ohd-ov-footer");
		footer.createSpan({ cls: "ohd-foot-text", text: this.footerLine() });
	}

	private rangeControl(): HTMLElement {
		const control = document.createElement("div");
		control.className = "ohd-seg";
		for (const [value, label] of [["all", "全部"], ["30", "30天"], ["7", "7天"]] as const) {
			const button = control.createEl("button", { cls: `ohd-seg-btn${this.range === value ? " is-active" : ""}`, text: label });
			button.addEventListener("click", () => {
				this.range = value;
				this.renderOverview();
			});
		}
		return control;
	}

	private statsData(): Array<[string, string]> {
		return [
			["笔记总数", this.data.totalNotes.toLocaleString()],
			["总字数", this.data.totalWordsReady ? this.data.totalWords.toLocaleString() : "…"],
			["文件夹", String(this.data.totalFolders)],
			["活跃天数", String(this.data.activeDays)],
			["当前连续", `${this.data.currentStreak} 天`],
			["最长连续", `${this.data.longestStreak} 天`],
			["高产时段", this.data.productiveHour],
			["本月新增", `+${this.data.newThisMonth}`],
		];
	}

	private footerLine(): string {
		if (!this.data.totalWordsReady) return "正在统计字数…";
		const { bookTitle, bookWords } = this.plugin.settings.dashboard;
		const wroteToday = (this.data.createdByDay.get(todayKey())?.length ?? 0) > 0;
		const tail = wroteToday ? "今天已经落笔，继续保持。" : "今天还没有落笔。";
		if (!bookTitle) return `已写下 ${this.data.totalWords.toLocaleString()} 字，${tail}`;
		const books = Math.max(1, Math.round(this.data.totalWords / Math.max(1, bookWords)));
		return `已写下 ${this.data.totalWords.toLocaleString()} 字 · 约等于 ${books} 本《${bookTitle}》，${tail}`;
	}

	private heatmap(weeks: number): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "ohd-heat-scroll";
		const heat = wrap.createDiv("ohd-heat");
		// 事件委托：371 个格子只挂一个监听器
		heat.addEventListener("click", (event) => {
			const cell = (event.target as HTMLElement).closest<HTMLElement>(".ohd-cell");
			const key = cell?.dataset.date;
			if (key && cell && !cell.classList.contains("is-future")) this.selectDate(key);
		});
		const monday = this.plugin.settings.dashboard.weekStartsMonday;
		const now = new Date();
		const offset = monday ? (now.getDay() + 6) % 7 : now.getDay();
		const weekEnd = addDays(now, -offset);
		const first = addDays(weekEnd, -(weeks - 1) * 7);
		const today = todayKey();
		const rangeStart = this.range === "30" ? dateKey(addDays(now, -30)) : this.range === "7" ? dateKey(addDays(now, -7)) : "";
		for (let week = 0; week < weeks; week++) {
			const column = heat.createDiv("ohd-heat-col");
			for (let day = 0; day < 7; day++) {
				const current = addDays(first, week * 7 + day);
				const key = dateKey(current);
				const future = key > today;
				const count = future || (rangeStart && key < rangeStart) ? 0 : (this.data.countByDay.get(key) ?? 0);
				const level = count <= 0 ? 0 : count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 3 : 4;
				const cell = column.createDiv(`ohd-cell ohd-l${level}${future ? " is-future" : ""}${key === this.selectedDate && !future ? " is-selected" : ""}`);
				if (!future) {
					cell.title = `${key} · ${count} 篇`;
					cell.dataset.date = key;
				}
			}
		}
		return wrap;
	}

	private renderRecent(): void {
		const panel = this.panels.recent;
		if (!panel) return;
		panel.empty();
		panel.append(this.header("clock-3", "最近编辑", "Recent"));
		const list = panel.createDiv("ohd-list");
		const files = this.data.files.slice(0, this.plugin.settings.dashboard.recentLimit);
		const missing: TFile[] = [];
		for (const file of files) {
			const cachedWords = this.wordCache.get(file.path);
			const words =
				cachedWords?.mtime === file.stat.mtime
					? cachedWords.count
					: undefined;
			if (words === undefined) missing.push(file);
			const row = list.createDiv("ohd-row");
			row.addEventListener("click", () => this.openFile(file));
			const dot = row.createSpan("ohd-dot");
			dot.style.background = colorFor(file.path);
			const main = row.createDiv("ohd-row-main");
			main.createSpan({ cls: "ohd-row-title", text: file.basename });
			main.createSpan({ cls: "ohd-row-sub", text: `${this.folderLabel(file)} · ${relativeTime(file.stat.mtime)}` });
			row.createSpan({ cls: "ohd-row-words", text: words === undefined ? "… 字" : `${words} 字` });
		}
		if (!files.length) list.createDiv({ cls: "ohd-empty", text: "还没有笔记" });
		if (missing.length) void this.fillRecentWords(missing);
	}

	private async fillRecentWords(files: TFile[]): Promise<void> {
		const generation = this.renderGeneration;
		for (const file of files) {
			await this.countWords(file);
		}
		if (generation === this.renderGeneration) this.renderRecent();
	}

	private folderLabel(file: TFile): string {
		const path = file.parent?.path;
		return path && path !== "/" ? path : "根目录";
	}

	private buildNavigation(): NavGroup[] {
		const groups = new Map<string, TFile[]>();
		const root = this.plugin.settings.dashboard.navigationRoot.replace(/\/+$/, "");
		const prefix = root ? `${root}/` : "";
		const level = prefix ? 1 : 0;
		const rootIndexFile = root ? `${root}/00-notes-index.md` : "00-notes-index.md";
		for (const file of this.data.files) {
			if (prefix && !file.path.startsWith(prefix)) continue;
			if (file.path === rootIndexFile) continue;
			const parts = file.path.split("/");
			const key = parts.length > level + 1 ? parts[level] : "_root";
			const bucket = groups.get(key);
			if (bucket) bucket.push(file);
			else groups.set(key, [file]);
		}
		const result: NavGroup[] = [];
		for (const [key, files] of groups) {
			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const number = Number.parseInt(key, 10);
			const colorIndex = key === "_root" ? 2 : Number.isNaN(number) ? 1 : Math.floor(number / 10) - 1;
			result.push({
				key,
				title: key === "_root" ? (prefix ? `${root} 根目录` : "根目录") : key,
				color: COLORS[((colorIndex % COLORS.length) + COLORS.length) % COLORS.length],
				items: files.map((file) => {
					const summary = this.app.metadataCache.getFileCache(file)?.frontmatter?.["summary"];
					return { file, title: file.basename, summary: summary ? String(summary) : (file.path.split("/")[level + 1] ?? "") };
				}),
			});
		}
		return result.sort((a, b) => a.key.localeCompare(b.key, "zh-CN", { numeric: true }));
	}

	private renderNavigation(): void {
		const panel = this.panels.nav;
		if (!panel) return;
		panel.empty();
		const groups = this.buildNavigation();
		const collapsed = this.plugin.settings.dashboard.navCollapsed;
		const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.includes(group.key));
		const control = document.createElement("div");
		control.className = "ohd-seg";
		const button = control.createEl("button", { cls: `ohd-seg-btn${allCollapsed ? " is-active" : ""}`, text: allCollapsed ? "全部展开" : "全部折叠" });
		button.addEventListener("click", () => {
			this.plugin.settings.dashboard.navCollapsed = allCollapsed ? [] : groups.map((group) => group.key);
			this.plugin.saveSettingsSoon();
			this.renderNavigation();
		});
		panel.append(this.header("compass", "分类导航", "Notes Navigator", control));
		const grid = panel.createDiv("ohd-nav-grid");
		let total = 0;
		for (const group of groups) {
			total += group.items.length;
			const isCollapsed = collapsed.includes(group.key);
			const groupEl = grid.createDiv("ohd-nav-group");
			const heading = groupEl.createDiv("ohd-nav-group-head");
			heading.addEventListener("click", () => this.toggleNavigationGroup(group.key));
			const dot = heading.createSpan("ohd-nav-dot");
			dot.style.background = group.color;
			heading.createSpan({ cls: "ohd-nav-group-title", text: group.title });
			heading.createSpan({ cls: "ohd-nav-count", text: String(group.items.length) });
			heading.createSpan({ cls: "ohd-nav-arrow", text: isCollapsed ? "▸" : "▾" });
			if (isCollapsed) continue;
			const items = groupEl.createDiv("ohd-nav-items");
			for (const item of group.items) {
				const row = items.createDiv("ohd-row");
				row.addEventListener("click", () => this.openFile(item.file));
				const itemDot = row.createSpan("ohd-dot");
				itemDot.style.background = group.color;
				const main = row.createDiv("ohd-row-main");
				main.createDiv({ cls: "ohd-row-title", text: item.title });
				main.createDiv({ cls: "ohd-row-sub", text: item.summary || "—" });
			}
		}
		const footer = panel.createDiv("ohd-ov-footer");
		const rootLabel = this.plugin.settings.dashboard.navigationRoot.replace(/\/+$/, "") || "库内";
		footer.createSpan({ cls: "ohd-foot-text", text: `共 ${total} 篇笔记 · 按 ${rootLabel} 一级目录归类` });
	}

	private toggleNavigationGroup(key: string): void {
		const collapsed = this.plugin.settings.dashboard.navCollapsed;
		this.plugin.settings.dashboard.navCollapsed = collapsed.includes(key) ? collapsed.filter((value) => value !== key) : [...collapsed, key];
		this.plugin.saveSettingsSoon();
		this.renderNavigation();
	}

	private renderCalendar(): void {
		const panel = this.panels.calendar;
		if (!panel) return;
		panel.empty();
		const controls = document.createElement("div");
		controls.className = "ohd-nav";
		for (const [label, title, direction] of [["‹", "上个月", -1], ["›", "下个月", 1]] as const) {
			const button = controls.createEl("button", { cls: "ohd-navbtn", text: label, attr: { title, "aria-label": title } });
			button.addEventListener("click", () => this.changeMonth(direction));
		}
		panel.append(this.header("calendar-days", "日历", `${this.calendarYear} 年 ${this.calendarMonth + 1} 月`, controls));
		const grid = panel.createDiv("ohd-cal-grid");
		grid.addEventListener("click", (event) => {
			const cell = (event.target as HTMLElement).closest<HTMLElement>(".ohd-day");
			const key = cell?.dataset.date;
			if (key) this.selectDate(key);
		});
		const labels = this.plugin.settings.dashboard.weekStartsMonday ? ["一", "二", "三", "四", "五", "六", "日"] : WEEKDAYS;
		for (const label of labels) grid.createDiv({ cls: "ohd-wd", text: label });
		for (const day of this.calendarDays()) {
			const classes = ["ohd-day", !day.inMonth ? "is-outside" : "", day.key === todayKey() ? "is-today" : "", day.key === this.selectedDate ? "is-selected" : ""].filter(Boolean).join(" ");
			const cell = grid.createDiv({ cls: classes, text: String(day.date.getDate()) });
			cell.dataset.date = day.key;
			if (day.inMonth && (this.data.countByDay.get(day.key) ?? 0) > 0) cell.createSpan("ohd-day-dot");
		}
		const footer = panel.createDiv("ohd-cal-foot");
		footer.createSpan("ohd-cal-foot-dot");
		footer.appendText("当天有笔记 · 点击日期查看");
	}

	private calendarDays(): Array<{ date: Date; key: string; inMonth: boolean }> {
		const first = new Date(this.calendarYear, this.calendarMonth, 1);
		const offset = this.plugin.settings.dashboard.weekStartsMonday ? (first.getDay() + 6) % 7 : first.getDay();
		const start = new Date(this.calendarYear, this.calendarMonth, 1 - offset);
		return Array.from({ length: 42 }, (_, index) => {
			const date = addDays(start, index);
			return { date, key: dateKey(date), inMonth: date.getMonth() === this.calendarMonth };
		});
	}

	private changeMonth(direction: number): void {
		const date = new Date(this.calendarYear, this.calendarMonth + direction, 1);
		this.calendarYear = date.getFullYear();
		this.calendarMonth = date.getMonth();
		this.renderCalendar();
	}

	private selectDate(key: string): void {
		const date = parseDate(key);
		this.selectedDate = key;
		this.calendarYear = date.getFullYear();
		this.calendarMonth = date.getMonth();
		this.renderOverview();
		this.renderCalendar();
		this.renderAgenda();
	}

	private renderAgenda(): void {
		const panel = this.panels.agenda;
		if (!panel) return;
		panel.empty();
		const selected = parseDate(this.selectedDate);
		const label = this.selectedDate === todayKey() ? `今天 · 周${WEEKDAYS[selected.getDay()]}` : `${selected.getMonth() + 1}月${selected.getDate()}日 · 周${WEEKDAYS[selected.getDay()]}`;
		const selectedEl = document.createElement("span");
		selectedEl.className = "ohd-sel-label";
		selectedEl.textContent = label;
		panel.append(this.header("list-checks", "日程", "Agenda", selectedEl));
		const tasks = this.plugin.settings.dashboard.tasksByDate[this.selectedDate] ?? [];
		const list = panel.createDiv("ohd-tasks");
		if (!tasks.length) list.createDiv({ cls: "ohd-empty", text: "这天还没有日程 · 在下方添加" });
		for (const task of tasks) this.renderTask(list, task);
		const input = document.createElement("input");
		input.className = "ohd-add-input";
		input.type = "text";
		input.placeholder = "添加日程…（可用 09:30 开头设时间）";
		const add = (): void => {
			if (this.addTask(input.value)) input.value = "";
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") add();
		});
		const addRow = panel.createDiv("ohd-add-row");
		addRow.append(input);
		const addButton = addRow.createEl("button", { cls: "ohd-add-btn", text: "＋", attr: { "aria-label": "添加日程" } });
		addButton.addEventListener("click", add);
		panel.createDiv({ cls: "ohd-divider", text: "当天创建 CREATED" });
		const notes = panel.createDiv("ohd-daynotes");
		const created = (this.data.createdByDay.get(this.selectedDate) ?? [])
			.slice()
			.sort(
				(a, b) => this.createdTimestamp(a) - this.createdTimestamp(b)
			);
		if (!created.length) notes.createDiv({ cls: "ohd-empty-sm", text: "这天没有创建笔记" });
		for (const file of created) {
			const row = notes.createDiv("ohd-daynote");
			row.addEventListener("click", () => this.openFile(file));
			const icon = row.createSpan("ohd-ic-doc");
			setIcon(icon, "file-text");
			row.createSpan({ cls: "ohd-daynote-title", text: file.basename });
		}
	}

	private renderTask(parent: HTMLElement, task: DashboardTask): void {
		const row = parent.createDiv("ohd-task");
		const checkbox = row.createDiv({ cls: `ohd-check${task.done ? " is-done" : ""}`, text: task.done ? "✓" : "" });
		checkbox.addEventListener("click", () => this.toggleTask(task.id));
		row.createSpan({ cls: "ohd-task-time", text: task.time || "—" });
		row.createSpan({ cls: `ohd-task-text${task.done ? " is-done" : ""}`, text: task.text });
		const remove = row.createEl("button", { cls: "ohd-task-del", text: "×", attr: { title: "删除", "aria-label": "删除日程" } });
		remove.addEventListener("click", () => this.deleteTask(task.id));
	}

	private toggleTask(id: string): void {
		const task = this.plugin.settings.dashboard.tasksByDate[this.selectedDate]?.find((item) => item.id === id);
		if (!task) return;
		task.done = !task.done;
		this.plugin.saveSettingsSoon();
		this.renderAgenda();
	}

	private deleteTask(id: string): void {
		const byDate = this.plugin.settings.dashboard.tasksByDate;
		const next = (byDate[this.selectedDate] ?? []).filter((task) => task.id !== id);
		if (next.length) byDate[this.selectedDate] = next;
		else delete byDate[this.selectedDate];
		this.plugin.saveSettingsSoon();
		this.renderAgenda();
	}

	private addTask(raw: string): boolean {
		const value = raw.trim();
		if (!value) return false;
		const match = value.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
		const tasks = [...(this.plugin.settings.dashboard.tasksByDate[this.selectedDate] ?? [])];
		tasks.push({ id: uniqueId("task"), time: match?.[1] ?? "", text: match?.[2] ?? value, done: false });
		tasks.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
		this.plugin.settings.dashboard.tasksByDate[this.selectedDate] = tasks;
		this.plugin.saveSettingsSoon();
		this.renderAgenda();
		this.showToast("已添加日程 ✦");
		this.panels.agenda?.querySelector<HTMLInputElement>(".ohd-add-input")?.focus();
		return true;
	}

	private openFile(file: TFile): void {
		void this.plugin.openNote(file);
		this.showToast(`打开：${file.basename}`);
	}

	private openPath(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) this.openFile(file);
		else new Notice(`找不到文件：${path}`);
	}

	private showToast(message: string): void {
		if (!this.toastEl) this.toastEl = this.contentEl.createDiv("ohd-toast");
		this.toastEl.setText(message);
		this.toastEl.removeClass("is-show");
		void this.toastEl.offsetWidth;
		this.toastEl.addClass("is-show");
		window.clearTimeout(this.toastTimer);
		this.toastTimer = window.setTimeout(() => this.toastEl?.removeClass("is-show"), 1800);
	}
}
