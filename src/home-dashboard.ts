import { ItemView, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type TolariaNavigatorPlugin from "./main";
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

function greeting(hour: number): string {
	if (hour < 5) return "夜深了";
	if (hour < 11) return "早上好";
	if (hour < 13) return "中午好";
	if (hour < 18) return "下午好";
	return "晚上好";
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
	newLastMonth = 0;
	totalWords = 0;
	totalWordsReady = false;
	// 活跃语义：按「当天有修改或新建」计，热力图/连续天数都基于这里
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
		const lastMonth = now.getMonth() === 0 ? (now.getFullYear() - 1) * 100 + 11 : now.getFullYear() * 100 + now.getMonth() - 1;
		let monthCount = 0;
		let lastMonthCount = 0;

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
			const createdMonth = createdDate.getFullYear() * 100 + createdDate.getMonth();
			if (createdMonth === currentMonth) monthCount++;
			else if (createdMonth === lastMonth) lastMonthCount++;
		}

		this.totalFolders = folders.size;
		this.countByDay = modified;
		this.createdByDay = created;
		this.activeDays = modified.size;
		this.newThisMonth = monthCount;
		this.newLastMonth = lastMonthCount;
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
	hero?: HTMLElement;
	kpiWords?: HTMLElement;
	kpiMonth?: HTMLElement;
	kpiBook?: HTMLElement;
	heat?: HTMLElement;
	recent?: HTMLElement;
	agenda?: HTMLElement;
	calendar?: HTMLElement;
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
		this.resizeTimer = window.setTimeout(() => this.renderHeatCard(), 150);
	}

	/** 内容编辑后的轻量刷新：只重建时间敏感面板，日历仅当改动落在当前显示月份时才重绘 */
	refreshChanged(files: TFile[]): void {
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
		if (previousWordsReady) {
			data.totalWords = previousWords;
			data.totalWordsReady = true;
		}
		this.renderHero();
		this.renderKpis();
		this.renderHeatCard();
		this.renderRecent();
		this.renderAgenda();
		const touchesVisibleMonth = files.some((file) => {
			const date = new Date(file.stat.mtime);
			return date.getFullYear() === this.calendarYear && date.getMonth() === this.calendarMonth;
		});
		if (touchesVisibleMonth) this.renderCalendar();
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
					if (generation === this.renderGeneration && this.data === data) this.renderKpis();
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
			this.renderKpis();
			this.renderRecent();
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

	noteTitle(file: TFile): string {
		return this.plugin.service.noteTitle(file);
	}

	private buildSkeleton(): void {
		this.contentEl.empty();
		this.contentEl.addClass("ohd-host");
		const scroll = this.contentEl.createDiv("ohd-scroll");
		const root = scroll.createDiv("ohd-root");
		this.panels.hero = root.createDiv("ohd-hero");
		const bento = root.createDiv("ohd-bento");
		this.panels.kpiWords = bento.createDiv("ohd-card ohd-kpi ohd-kpi-words");
		this.panels.kpiMonth = bento.createDiv("ohd-card ohd-kpi ohd-kpi-month");
		this.panels.kpiBook = bento.createDiv("ohd-card ohd-kpi ohd-kpi-book");
		this.panels.recent = bento.createDiv("ohd-card ohd-recent");
		const side = bento.createDiv("ohd-side");
		this.panels.agenda = side.createDiv("ohd-card ohd-agenda");
		this.panels.calendar = side.createDiv("ohd-card ohd-calendar");
		this.panels.heat = bento.createDiv("ohd-card ohd-heatcard");
	}

	private renderAll(): void {
		this.renderHero();
		this.renderKpis();
		this.renderHeatCard();
		this.renderRecent();
		this.renderAgenda();
		this.renderCalendar();
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

	private renderHero(): void {
		const panel = this.panels.hero;
		if (!panel) return;
		panel.empty();
		const now = new Date();
		const left = panel.createDiv("ohd-hero-left");
		left.createDiv({
			cls: "ohd-hero-date",
			text: `${now.getMonth() + 1}月${now.getDate()}日 周${WEEKDAYS[now.getDay()]}`,
		});
		left.createDiv({ cls: "ohd-hero-greet", text: greeting(now.getHours()) });
		const right = panel.createDiv("ohd-hero-right");
		const streak = right.createSpan({
			cls: `ohd-chip${this.data.currentStreak > 0 ? " is-accent" : ""}`,
			text: `🔥 连续 ${this.data.currentStreak} 天`,
		});
		streak.title = `最长连续 ${this.data.longestStreak} 天`;
		const createdToday = this.data.createdByDay.get(todayKey())?.length ?? 0;
		const modifiedToday = this.data.countByDay.get(todayKey()) ?? 0;
		right.createSpan({
			cls: `ohd-chip${createdToday + modifiedToday > 0 ? "" : " is-idle"}`,
			text:
				createdToday + modifiedToday > 0
					? `今天 新建 ${createdToday} · 修改 ${modifiedToday}`
					: "今天还没有动静",
		});
	}

	private renderKpis(): void {
		const { bookTitle, bookWords } = this.plugin.settings.dashboard;
		const words = this.panels.kpiWords;
		if (words) {
			words.empty();
			words.createSpan({ cls: "ohd-kpi-label", text: "总字数" });
			words.createDiv({
				cls: "ohd-kpi-num",
				text: this.data.totalWordsReady ? this.data.totalWords.toLocaleString() : "…",
			});
			const sub = words.createDiv("ohd-kpi-sub");
			if (!bookTitle) {
				sub.setText(`共 ${this.data.totalNotes} 篇笔记`);
			} else {
				const books = Math.max(1, Math.round(this.data.totalWords / Math.max(1, bookWords)));
				sub.setText(`≈ ${books} 本《${bookTitle}》`);
			}
		}

		const month = this.panels.kpiMonth;
		if (month) {
			month.empty();
			month.createSpan({ cls: "ohd-kpi-label", text: "本月新建" });
			month.createDiv({ cls: "ohd-kpi-num", text: `+${this.data.newThisMonth}` });
			const delta = this.data.newThisMonth - this.data.newLastMonth;
			month.createDiv({
				cls: "ohd-kpi-sub",
				text: `上月 +${this.data.newLastMonth} · ${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta)}`,
			});
		}

		const book = this.panels.kpiBook;
		if (book) {
			book.empty();
			if (bookTitle) {
				const target = Math.max(1, bookWords);
				const percent = Math.min(999, Math.round((this.data.totalWords / target) * 100));
				const done = percent >= 100;
				book.createSpan({ cls: "ohd-kpi-label", text: `书目进度 · 《${bookTitle}》` });
				book.createDiv({ cls: `ohd-kpi-num${done ? " is-done" : ""}`, text: `${percent}%` });
				const bar = book.createDiv("ohd-book-bar");
				const fill = bar.createDiv("ohd-book-fill");
				fill.style.width = `${Math.min(100, percent)}%`;
				if (done) fill.addClass("is-over");
				book.createDiv({
					cls: "ohd-kpi-sub",
					text: done
						? `已达标 ✦ ${this.data.totalWords.toLocaleString()} / ${target.toLocaleString()} 字`
						: `${this.data.totalWords.toLocaleString()} / ${target.toLocaleString()} 字`,
				});
			} else {
				book.createSpan({ cls: "ohd-kpi-label", text: "笔记总数" });
				book.createDiv({ cls: "ohd-kpi-num", text: this.data.totalNotes.toLocaleString() });
				book.createDiv({ cls: "ohd-kpi-sub", text: `文件夹 ${this.data.totalFolders} 个` });
			}
		}
	}

	private renderHeatCard(): void {
		const panel = this.panels.heat;
		if (!panel) return;
		panel.empty();
		panel.append(this.header("flame", "活动热力图", "Activity", this.rangeControl()));
		const availableWidth = Math.max(320, panel.clientWidth - 36);
		const fitWeeks = Math.max(14, Math.min(53, Math.floor((availableWidth + 4) / 17)));
		const configuredWeeks = this.plugin.settings.dashboard.heatmapWeeks;
		panel.append(this.heatmap(Math.min(configuredWeeks, fitWeeks)));
		const footer = panel.createDiv("ohd-heat-foot");
		const parts = [
			`活跃 ${this.data.activeDays} 天`,
			`高产时段 ${this.data.productiveHour}`,
			`连续 ${this.data.currentStreak} 天 · 最长 ${this.data.longestStreak} 天`,
		];
		footer.createSpan({ cls: "ohd-foot-text", text: parts.join(" · ") });
	}

	private rangeControl(): HTMLElement {
		const control = document.createElement("div");
		control.className = "ohd-seg";
		for (const [value, label] of [["all", "全部"], ["30", "30天"], ["7", "7天"]] as const) {
			const button = control.createEl("button", { cls: `ohd-seg-btn${this.range === value ? " is-active" : ""}`, text: label });
			button.addEventListener("click", () => {
				this.range = value;
				this.renderHeatCard();
			});
		}
		return control;
	}

	private heatmap(weeks: number): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "ohd-heat-scroll";
		const heat = wrap.createDiv("ohd-heat");
		// 事件委托：几百个格子只挂一个监听器
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
		// 容器级事件委托：重绘不重复挂监听器
		list.addEventListener("click", (event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>(".ohd-row");
			const path = row?.dataset.path;
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) this.openFile(file);
		});
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
			row.dataset.path = file.path;
			const dot = row.createSpan("ohd-dot");
			dot.style.background = colorFor(file.path);
			const main = row.createDiv("ohd-row-main");
			main.createSpan({ cls: "ohd-row-title", text: this.noteTitle(file) });
			main.createSpan({ cls: "ohd-row-sub", text: `${this.folderLabel(file)} · ${relativeTime(file.stat.mtime)}` });
			row.createSpan({ cls: "ohd-row-words", text: words === undefined ? "… 字" : `${words.toLocaleString()} 字` });
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
		const tasks = this.plugin.tasks.tasksFor(this.selectedDate);
		const list = panel.createDiv("ohd-tasks");
		// 容器级事件委托
		list.addEventListener("click", (event) => {
			const target = event.target as HTMLElement;
			const row = target.closest<HTMLElement>(".ohd-task");
			if (!row) return;
			const id = row.dataset.taskId;
			if (!id) return;
			if (target.closest(".ohd-check")) {
				this.plugin.tasks.toggle(this.selectedDate, id);
				this.renderAgenda();
			} else if (target.closest(".ohd-task-del")) {
				this.plugin.tasks.remove(this.selectedDate, id);
				this.renderAgenda();
			}
		});
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
		notes.addEventListener("click", (event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>(".ohd-daynote");
			const path = row?.dataset.path;
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) this.openFile(file);
		});
		const created = (this.data.createdByDay.get(this.selectedDate) ?? [])
			.slice()
			.sort(
				(a, b) => this.createdTimestamp(a) - this.createdTimestamp(b)
			);
		if (!created.length) notes.createDiv({ cls: "ohd-empty-sm", text: "这天没有创建笔记" });
		for (const file of created) {
			const row = notes.createDiv("ohd-daynote");
			row.dataset.path = file.path;
			const icon = row.createSpan("ohd-ic-doc");
			setIcon(icon, "file-text");
			row.createSpan({ cls: "ohd-daynote-title", text: this.noteTitle(file) });
		}
	}

	private renderTask(parent: HTMLElement, task: { id: string; time: string; text: string; done: boolean }): void {
		const row = parent.createDiv("ohd-task");
		row.dataset.taskId = task.id;
		row.createDiv({ cls: `ohd-check${task.done ? " is-done" : ""}`, text: task.done ? "✓" : "" });
		row.createSpan({ cls: "ohd-task-time", text: task.time || "—" });
		row.createSpan({ cls: `ohd-task-text${task.done ? " is-done" : ""}`, text: task.text });
		row.createEl("button", { cls: "ohd-task-del", text: "×", attr: { title: "删除", "aria-label": "删除日程" } });
	}

	private addTask(raw: string): boolean {
		const task = this.plugin.tasks.add(this.selectedDate, raw);
		if (!task) return false;
		this.renderAgenda();
		this.showToast("已添加日程 ✦");
		this.panels.agenda?.querySelector<HTMLInputElement>(".ohd-add-input")?.focus();
		return true;
	}

	private renderCalendar(): void {
		const panel = this.panels.calendar;
		if (!panel) return;
		panel.empty();
		const controls = document.createElement("div");
		controls.className = "ohd-cal-nav";
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
		this.renderHeatCard();
		this.renderCalendar();
		this.renderAgenda();
	}

	private openFile(file: TFile): void {
		void this.plugin.openNote(file);
		this.showToast(`打开：${this.noteTitle(file)}`);
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
