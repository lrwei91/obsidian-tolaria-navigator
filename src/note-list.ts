import {
	App,
	ItemView,
	MarkdownView,
	Menu,
	Modal,
	normalizePath,
	Notice,
	Setting,
	setIcon,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import { getVirtualRange } from "./list-utils";
import {
	getDefaultDirection,
	isArchivedCache,
	NoteFilter,
	SORT_LABELS,
	SORT_OPTIONS,
	SortDirection,
	SortOption,
} from "./types";

export const VIEW_TYPE_TOLARIA_LIST = "tolaria-note-list-view";

const SEARCH_DEBOUNCE_MS = 180;
const VIRTUAL_ROW_HEIGHT = 132;
const VIRTUAL_OVERSCAN = 4;

export class NoteListView extends ItemView {
	private plugin: TolariaNavigatorPlugin;
	private filter: NoteFilter = { kind: "all", label: "全部笔记" };
	private sortOption: SortOption = "modified";
	private sortDirection: SortDirection = "desc";
	private searchVisible = false;
	private searchQuery = "";
	private renderSeq = 0;
	private cardsTimer: number | null = null;
	private tabGroupEl: HTMLElement | null = null;
	private visibleFiles: TFile[] = [];
	private selectedPath: string | null = null;
	private virtualViewport: HTMLElement | null = null;
	private virtualWindow: HTMLElement | null = null;
	private virtualFrame: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TolariaNavigatorPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.sortOption = plugin.settings.defaultSort;
		this.sortDirection = plugin.settings.defaultSortDirection;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_TOLARIA_LIST;
	}

	getDisplayText(): string {
		return "Tolaria 笔记列表";
	}

	getIcon(): string {
		return "list";
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.containerEl.addClass("tol-note-list-view");
		this.tabGroupEl = this.containerEl.closest<HTMLElement>(".workspace-tabs");
		this.tabGroupEl?.addClass("tol-note-list-tabs");
		this.contentEl.tabIndex = 0;
		this.registerDomEvent(this.contentEl, "keydown", (event) =>
			this.handleKeyboard(event)
		);
		this.filter = this.plugin.currentFilter ?? this.filter;
		await this.renderList();
	}

	async onClose(): Promise<void> {
		await super.onClose();
		this.tabGroupEl?.removeClass("tol-note-list-tabs");
		this.tabGroupEl = null;
		if (this.cardsTimer !== null) window.clearTimeout(this.cardsTimer);
		if (this.virtualFrame !== null) window.cancelAnimationFrame(this.virtualFrame);
	}

	async setFilter(filter: NoteFilter): Promise<void> {
		const changed =
			this.filter.kind !== filter.kind || this.filter.value !== filter.value;
		this.filter = filter;
		if (changed) this.searchQuery = "";
		await this.renderList();
	}

	async refresh(): Promise<void> {
		if (this.contentEl.isShown()) await this.renderList();
	}

	refreshFiles(_files: TFile[]): void {
		if (!this.contentEl.isShown() || !this.virtualViewport) return;
		const next = this.computeFiles();
		const sameOrder =
			next.length === this.visibleFiles.length &&
			next.every((file, index) => file.path === this.visibleFiles[index]?.path);
		this.visibleFiles = next;
		if (
			this.selectedPath &&
			!this.visibleFiles.some((file) => file.path === this.selectedPath)
		) {
			this.selectedPath = null;
		}
		if (sameOrder) this.renderVirtualWindow();
		else this.resetVirtualList();
	}

	focusList(): void {
		this.virtualViewport?.focus();
	}

	openSelected(): void {
		const file = this.selectedFile();
		if (file) void this.plugin.openNote(file);
	}

	showSelectedMenu(): void {
		const file = this.selectedFile();
		if (!file || !this.virtualViewport) return;
		const rect = this.virtualViewport.getBoundingClientRect();
		this.createNoteMenu(file).showAtPosition({
			x: rect.left + Math.min(rect.width / 2, 220),
			y: rect.top + Math.min(rect.height / 2, 180),
		});
	}

	private selectFiles(): TFile[] {
		const svc = this.plugin.service;
		switch (this.filter.kind) {
			case "inbox":
				return svc.inboxNotes(this.plugin.settings.newNoteFolder);
			case "archive":
				return svc.archivedNotes();
			case "favorite":
				return svc.favoriteNotes(this.plugin.settings.dashboard.favorites);
			case "folder":
				return svc.notesInFolder(this.filter.value ?? "");
			case "tag":
				return svc.notesWithTag(this.filter.value ?? "");
			default:
				return svc.activeNotes();
		}
	}

	private async renderList(): Promise<void> {
		const seq = ++this.renderSeq;
		const root = this.contentEl;
		root.empty();
		root.addClass("tol-note-list");

		this.renderHeader(root);

		if (this.searchVisible) {
			this.renderSearchBar(root);
		}

		const cards = root.createDiv("tol-cards");
		cards.tabIndex = 0;
		cards.setAttribute("role", "listbox");
		cards.setAttribute("aria-label", `${this.filter.label}笔记列表`);
		this.renderCards(cards, seq);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv("tol-list-header");
		header.createSpan({ cls: "tol-list-title", text: this.filter.label });

		const actions = header.createDiv("tol-header-actions");

		const sortBtn = actions.createEl("button", {
			cls: "tol-header-btn tol-sort-btn",
			attr: { "aria-label": "排序" },
		});
		const sortArrow = sortBtn.createSpan("tol-btn-icon");
		setIcon(sortArrow, this.sortDirection === "asc" ? "arrow-up" : "arrow-down");
		sortBtn.createSpan({ text: SORT_LABELS[this.sortOption] });
		sortBtn.addEventListener("click", (evt) => this.showSortMenu(evt));

		const searchBtn = actions.createEl("button", {
			cls: "tol-header-btn tol-icon-btn",
			attr: { "aria-label": "搜索当前列表" },
		});
		setIcon(searchBtn.createSpan("tol-btn-icon"), "search");
		if (this.searchVisible) searchBtn.addClass("is-active");
		searchBtn.addEventListener("click", () => {
			this.searchVisible = !this.searchVisible;
			if (!this.searchVisible) this.searchQuery = "";
			void this.renderList();
			if (this.searchVisible) {
				window.setTimeout(() => {
					this.contentEl.querySelector<HTMLInputElement>(
						".tol-search-input"
					)?.focus();
				}, 0);
			}
		});

		const createBtn = actions.createEl("button", {
			cls: "tol-header-btn tol-icon-btn",
			attr: { "aria-label": "新建笔记" },
		});
		setIcon(createBtn.createSpan("tol-btn-icon"), "plus");
		createBtn.addEventListener("click", () => void this.createNote());

		const keyboardBtn = actions.createEl("button", {
			cls: "tol-header-btn tol-icon-btn",
			attr: { "aria-label": "键盘操作" },
		});
		setIcon(keyboardBtn.createSpan("tol-btn-icon"), "keyboard");
		keyboardBtn.addEventListener("click", (event) =>
			this.showKeyboardMenu(event)
		);
	}

	private showSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const option of SORT_OPTIONS) {
			menu.addItem((item) =>
				item
					.setTitle(SORT_LABELS[option])
					.setChecked(option === this.sortOption)
					.onClick(() => {
						this.sortOption = option;
						this.sortDirection = getDefaultDirection(option);
						void this.plugin.saveListSort(
							this.sortOption,
							this.sortDirection
						);
						void this.renderList();
					})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("升序")
				.setIcon("arrow-up")
				.setChecked(this.sortDirection === "asc")
				.onClick(() => {
					this.sortDirection = "asc";
					void this.plugin.saveListSort(
						this.sortOption,
						this.sortDirection
					);
					void this.renderList();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("降序")
				.setIcon("arrow-down")
				.setChecked(this.sortDirection === "desc")
				.onClick(() => {
					this.sortDirection = "desc";
					void this.plugin.saveListSort(
						this.sortOption,
						this.sortDirection
					);
					void this.renderList();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	private renderSearchBar(root: HTMLElement): void {
		const bar = root.createDiv("tol-search-bar");
		const input = bar.createEl("input", {
			cls: "tol-search-input",
			attr: {
				type: "text",
				placeholder: `在「${this.filter.label}」中搜索…`,
				spellcheck: "false",
			},
		});
		input.value = this.searchQuery;
		input.addEventListener("input", () => {
			this.searchQuery = input.value;
			this.scheduleRenderCards();
		});
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape") {
				this.searchVisible = false;
				this.searchQuery = "";
				void this.renderList();
			}
		});
	}

	private scheduleRenderCards(): void {
		if (this.cardsTimer !== null) window.clearTimeout(this.cardsTimer);
		this.cardsTimer = window.setTimeout(() => {
			this.cardsTimer = null;
			const seq = this.renderSeq;
			const wrap =
				this.contentEl.querySelector<HTMLElement>(".tol-cards");
			if (!wrap || !this.contentEl.isShown()) return;
			wrap.empty();
			this.renderCards(wrap, seq);
		}, SEARCH_DEBOUNCE_MS);
	}

	private renderCards(container: HTMLElement, seq: number): void {
		this.virtualViewport = container;
		this.visibleFiles = this.computeFiles();
		this.resetVirtualList(seq);
	}

	private computeFiles(): TFile[] {
		let files = this.selectFiles();
		const query = this.searchQuery.trim().toLowerCase();
		if (query) {
			files = files.filter(
				(f) =>
					f.path.toLowerCase().includes(query) ||
					this.plugin.service
						.noteTitle(f)
						.toLowerCase()
						.includes(query)
			);
		}
		files = this.plugin.service.sortNotes(
			files,
			this.sortOption,
			this.sortDirection
		);
		files = files.sort(
			(a, b) =>
				Number(this.plugin.isNotePinned(b.path)) -
				Number(this.plugin.isNotePinned(a.path))
		);
		return files;
	}

	private resetVirtualList(seq = this.renderSeq): void {
		const container = this.virtualViewport;
		if (!container) return;
		container.empty();
		this.virtualWindow = null;

		if (this.visibleFiles.length === 0) {
			container.createDiv({
				cls: "tol-list-empty",
				text: this.searchQuery.trim()
					? "没有匹配的笔记"
					: "这里还没有笔记",
			});
			return;
		}
		const spacer = container.createDiv("tol-virtual-spacer");
		spacer.style.height = `${this.visibleFiles.length * VIRTUAL_ROW_HEIGHT}px`;
		this.virtualWindow = spacer.createDiv("tol-virtual-window");
		container.onscroll = () => this.scheduleVirtualRender();
		if (seq === this.renderSeq) this.renderVirtualWindow();
	}

	private scheduleVirtualRender(): void {
		if (this.virtualFrame !== null) return;
		this.virtualFrame = window.requestAnimationFrame(() => {
			this.virtualFrame = null;
			this.renderVirtualWindow();
		});
	}

	private renderVirtualWindow(): void {
		const viewport = this.virtualViewport;
		const virtualWindow = this.virtualWindow;
		if (!viewport || !virtualWindow) return;
		const { start, end } = getVirtualRange(
			this.visibleFiles.length,
			VIRTUAL_ROW_HEIGHT,
			viewport.scrollTop,
			viewport.clientHeight || 600,
			VIRTUAL_OVERSCAN
		);
		virtualWindow.empty();
		virtualWindow.style.transform = `translateY(${start * VIRTUAL_ROW_HEIGHT}px)`;
		for (let index = start; index < end; index++) {
			const row = virtualWindow.createDiv(
				`tol-virtual-row${index > 0 ? " has-divider" : ""}`
			);
			row.style.height = `${VIRTUAL_ROW_HEIGHT}px`;
			row.setAttribute("role", "option");
			row.setAttribute(
				"aria-selected",
				String(this.visibleFiles[index].path === this.selectedPath)
			);
			if (index > 0) {
				const divider = row.createDiv("tol-card-divider");
				divider.style.height = "1px";
				divider.style.margin = "0 16px";
				divider.style.backgroundColor = "var(--text-faint)";
				divider.style.opacity = "0.72";
			}
			this.renderCard(row, this.visibleFiles[index]);
		}
		this.highlightActiveFile();
	}

	highlightActiveFile(activePath?: string | null): void {
		const active = activePath ?? this.app.workspace.getActiveFile()?.path ?? null;
		const cards = this.contentEl.querySelectorAll<HTMLElement>(".tol-card");
		for (const card of cards) {
			const isActive = active !== null && card.dataset.path === active;
			card.toggleClass("is-active", isActive);
		}
	}

	private renderCard(container: HTMLElement, file: TFile): void {
		const svc = this.plugin.service;
		const title = svc.noteTitle(file);

		const card = container.createDiv("tol-card");
		card.dataset.path = file.path;
		if (file.path === this.selectedPath) card.addClass("is-keyboard-selected");
		card.addEventListener("click", () => {
			this.selectedPath = file.path;
			void this.plugin.openNote(file);
		});
		card.addEventListener("contextmenu", (evt) => {
			this.selectedPath = file.path;
			this.showNoteMenu(evt, file);
		});

		const top = card.createDiv("tol-card-top");
		top.createSpan("tol-card-dot");
		top.createSpan({ cls: "tol-card-title", text: title });
		const badges = top.createSpan("tol-card-badges");
		if (this.plugin.isNotePinned(file.path)) {
			this.statusBadge(badges, "pin", "置顶", "is-pinned");
		}
		const archived = isArchivedCache(this.app.metadataCache.getFileCache(file));
		if (archived) {
			this.statusBadge(badges, "archive", "归档", "is-archived");
		}
		const status = svc.noteStatus(file);
		if (status && status.toLowerCase() !== "archived") {
			this.statusBadge(badges, "circle-dot", status, "is-status");
		}
		const openIcon = top.createSpan("tol-card-open-icon");
		setIcon(openIcon, "file-text");

		card.createDiv({ cls: "tol-card-excerpt" });

		const meta = card.createDiv("tol-card-meta");
		meta.createSpan({
			cls: "tol-meta-left",
			text: svc.formatDate(file.stat.mtime),
		});
		meta.createSpan({
			cls: "tol-meta-right",
			text: `Created ${svc.formatDate(svc.noteCreatedTimestamp(file))}`,
		});

		void svc.excerpt(file).then((text) => {
			const el = card.querySelector<HTMLElement>(".tol-card-excerpt");
			if (el && card.isConnected) el.setText(text || "（无正文预览）");
		});
	}

	private statusBadge(
		container: HTMLElement,
		iconName: string,
		label: string,
		className: string
	): void {
		const badge = container.createSpan(`tol-status-badge ${className}`);
		badge.title = label;
		setIcon(badge.createSpan("tol-status-icon"), iconName);
		badge.createSpan({ cls: "tol-status-label", text: label });
	}

	private handleKeyboard(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target?.isContentEditable
		) {
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			this.moveSelection(event.key === "ArrowDown" ? 1 : -1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			this.openSelected();
		} else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
			event.preventDefault();
			this.showSelectedMenu();
		} else if (event.key === "/") {
			event.preventDefault();
			this.searchVisible = true;
			void this.renderList().then(() =>
				this.contentEl.querySelector<HTMLInputElement>(".tol-search-input")?.focus()
			);
		}
	}

	private moveSelection(direction: 1 | -1): void {
		if (!this.visibleFiles.length) return;
		const current = this.visibleFiles.findIndex(
			(file) => file.path === this.selectedPath
		);
		const next =
			current < 0
				? direction > 0
					? 0
					: this.visibleFiles.length - 1
				: Math.max(
						0,
						Math.min(this.visibleFiles.length - 1, current + direction)
					);
		this.selectedPath = this.visibleFiles[next].path;
		this.ensureIndexVisible(next);
		this.renderVirtualWindow();
	}

	private ensureIndexVisible(index: number): void {
		const viewport = this.virtualViewport;
		if (!viewport) return;
		const top = index * VIRTUAL_ROW_HEIGHT;
		const bottom = top + VIRTUAL_ROW_HEIGHT;
		if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (bottom > viewport.scrollTop + viewport.clientHeight) {
			viewport.scrollTop = bottom - viewport.clientHeight;
		}
	}

	private selectedFile(): TFile | null {
		if (!this.selectedPath) return null;
		return (
			this.visibleFiles.find((file) => file.path === this.selectedPath) ?? null
		);
	}

	private showKeyboardMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const [shortcut, action] of [
			["↑ / ↓", "选择上一条或下一条"],
			["Enter", "打开所选笔记"],
			["Shift + F10", "打开所选笔记菜单"],
			["/", "搜索当前列表"],
		] as const) {
			menu.addItem((item) =>
				item.setTitle(`${shortcut}  ${action}`).setDisabled(true)
			);
		}
		menu.showAtMouseEvent(event);
	}

	private showNoteMenu(evt: MouseEvent, file: TFile): void {
		evt.preventDefault();
		evt.stopPropagation();
		this.createNoteMenu(file).showAtMouseEvent(evt);
	}

	private createNoteMenu(file: TFile): Menu {
		const menu = new Menu();
		const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const favorite = this.plugin.settings.dashboard.favorites.includes(file.path);
		const organized = frontmatter?.organized === true;
		const archived = isArchivedCache(
			this.plugin.app.metadataCache.getFileCache(file)
		);
		const pinned = this.plugin.isNotePinned(file.path);

		menu.addItem((item) =>
			item
				.setTitle("在新窗口中打开")
				.setIcon("square-arrow-out-up-right")
				.onClick(() => void this.openInNewWindow(file))
		);
		menu.addItem((item) =>
			item
				.setTitle(favorite ? "从收藏视图移除" : "添加到收藏视图")
				.setIcon("star")
				.setChecked(favorite)
				.onClick(() => void this.plugin.toggleDashboardFavorite(file.path))
		);
		menu.addItem((item) =>
			item
				.setTitle(pinned ? "取消置顶" : "置顶这条笔记")
				.setIcon("pin")
				.setChecked(pinned)
				.onClick(async () => {
					await this.plugin.togglePinnedNote(file.path);
					await this.refresh();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle(organized ? "标记为未整理" : "标记为已整理")
				.setIcon("circle-check")
				.setChecked(organized)
				.onClick(() =>
					void this.toggleFrontmatterFlag(file, "organized", "整理状态")
				)
		);
		menu.addItem((item) =>
			item
				.setTitle("重命名文件名…")
				.setIcon("pencil")
				.onClick(() => this.promptRenameFile(file))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("在文件管理器中显示")
				.setIcon("folder-open")
				.onClick(() => this.revealInFileManager(file))
		);
		menu.addItem((item) =>
			item
				.setTitle("复制文件路径")
				.setIcon("clipboard")
				.onClick(() => void this.copyFilePath(file))
		);
		menu.addItem((item) =>
			item
				.setTitle("将笔记导出为 PDF")
				.setIcon("file-type-2")
				.onClick(() => void this.exportPdf(file))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(archived ? "取消归档这条笔记" : "归档这条笔记")
				.setIcon("archive")
				.onClick(() => void this.toggleArchiveState(file, archived))
		);
		menu.addItem((item) =>
			item
				.setTitle("删除这条笔记")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.deleteNote(file))
		);

		return menu;
	}

	private async openInNewWindow(file: TFile): Promise<void> {
		try {
			await this.plugin.app.workspace.getLeaf("window").openFile(file);
		} catch (error) {
			new Notice(`无法在新窗口打开：${noteActionError(error)}`);
		}
	}

	private async toggleFrontmatterFlag(
		file: TFile,
		key: "organized",
		label: string
	): Promise<void> {
		try {
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (frontmatter[key] === true) {
					delete frontmatter[key];
				} else {
					frontmatter[key] = true;
				}
			});
			await this.refresh();
		} catch (error) {
			new Notice(`${label}更新失败：${noteActionError(error)}`);
		}
	}

	private async toggleArchiveState(
		file: TFile,
		currentlyArchived: boolean
	): Promise<void> {
		try {
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (currentlyArchived) {
					delete frontmatter["archived"];
					if (
						String(frontmatter["status"] ?? "")
							.trim()
							.toLowerCase() === "archived"
					) {
						delete frontmatter["status"];
					}
				} else {
					frontmatter["archived"] = true;
				}
			});
			await this.refresh();
		} catch (error) {
			new Notice(`归档状态更新失败：${noteActionError(error)}`);
		}
	}

	private promptRenameFile(file: TFile): void {
		new NoteNameModal(this.plugin.app, file.basename, async (value) => {
			const oldPath = file.path;
			const filename = value.toLowerCase().endsWith(".md")
				? value
				: `${value}.md`;
			const parentPath = file.parent?.path ?? "";
			const nextPath = normalizePath(
				parentPath ? `${parentPath}/${filename}` : filename
			);
			if (nextPath === file.path) return;
			if (this.plugin.app.vault.getAbstractFileByPath(nextPath)) {
				new Notice(`文件已存在：${nextPath}`);
				return;
			}
			try {
				await this.plugin.app.fileManager.renameFile(file, nextPath);
				await this.plugin.replacePinnedNotePath(oldPath, nextPath);
			} catch (error) {
				new Notice(`重命名失败：${noteActionError(error)}`);
			}
		}).open();
	}

	private revealInFileManager(file: TFile): void {
		const result = this.plugin.desktop.showVaultPath(file.path);
		if (!result.ok) new Notice(result.error ?? "无法打开文件管理器");
	}

	private async copyFilePath(file: TFile): Promise<void> {
		try {
			await navigator.clipboard.writeText(file.path);
			new Notice("已复制文件路径");
		} catch (error) {
			new Notice(`复制路径失败：${noteActionError(error)}`);
		}
	}

	private async exportPdf(file: TFile): Promise<void> {
		await this.plugin.openNote(file);
		const fileLeaf = this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.find(
				(leaf) =>
					leaf.view instanceof MarkdownView && leaf.view.file === file
			);
		if (fileLeaf) {
			this.plugin.app.workspace.setActiveLeaf(fileLeaf, { focus: true });
		}
		const commands = (
			this.plugin.app as unknown as {
				commands?: {
					findCommand(id: string): unknown;
					executeCommandById(id: string): boolean;
				};
		}
		).commands;
		if (!commands?.findCommand("workspace:export-pdf")) {
			new Notice("当前 Obsidian 版本不支持导出 PDF 命令");
			return;
		}
		commands.executeCommandById("workspace:export-pdf");
	}

	private async deleteNote(file: TFile): Promise<void> {
		try {
			const deleted = await this.plugin.app.fileManager.promptForDeletion(file);
			if (deleted) await this.plugin.removePinnedNote(file.path);
		} catch (error) {
			new Notice(`删除失败：${noteActionError(error)}`);
		}
	}

	/** 新建笔记：文件夹视图建到当前文件夹；其余视图按收件箱工作流建到 inbox/ */
	private async createNote(): Promise<void> {
		const folderPath =
			this.filter.kind === "folder"
				? (this.filter.value ?? "")
				: this.plugin.settings.newNoteFolder;
		try {
			const file = await this.plugin.createNoteInFolder(folderPath);
			new Notice(`已创建：${file.path}`);
			await this.refresh();
			await this.plugin.openNote(file);
		} catch (err) {
			new Notice(`创建失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

class NoteNameModal extends Modal {
	private value: string;

	constructor(
		app: App,
		initialValue: string,
		private onSubmit: (value: string) => Promise<void>
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen(): void {
		this.setTitle("重命名笔记");
		let inputEl: HTMLInputElement;
		new Setting(this.contentEl).setName("文件名").addText((text) => {
			inputEl = text.inputEl;
			text.setValue(this.value).onChange((value) => (this.value = value));
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") void this.submit();
			});
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("重命名")
					.setCta()
					.onClick(() => void this.submit())
			);
		window.setTimeout(() => {
			inputEl.focus();
			inputEl.select();
		}, 0);
	}

	private async submit(): Promise<void> {
		const value = this.value.trim();
		if (!value) {
			new Notice("文件名不能为空");
			return;
		}
		if (/[\\/]/.test(value)) {
			new Notice("文件名不能包含斜杠");
			return;
		}
		this.close();
		await this.onSubmit(value);
	}
}

function noteActionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
