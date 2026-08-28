import {
	Debouncer,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	TFolder,
	debounce,
	WorkspaceLeaf,
	WorkspaceTabs,
} from "obsidian";
import { SidebarView, VIEW_TYPE_TOLARIA_SIDEBAR } from "./sidebar";
import { NoteListView, VIEW_TYPE_TOLARIA_LIST } from "./note-list";
import {
	HomeDashboardView,
	VIEW_TYPE_TOLARIA_HOME,
} from "./home-dashboard";
import { NoteFilter } from "./types";
import { VaultService } from "./vault-service";
import { removePathsWithin, replacePathPrefix } from "./path-utils";
import { DesktopAdapter } from "./desktop-adapter";
import { applyTemplate } from "./list-utils";
import {
	DEFAULT_SETTINGS,
	DashboardSettings,
	TolariaNavigatorSettings,
	TolariaNavigatorSettingTab,
} from "./settings";

/** 等待 homepage 等启动类插件完成布局后再修正三栏结构 */
const LAYOUT_FIX_DELAY_MS = 1200;
const LEGACY_DASHBOARD_PLUGIN_PATH =
	"plugins/obsidian-home-dashboard/data.json";

export default class TolariaNavigatorPlugin extends Plugin {
	service!: VaultService;
	desktop!: DesktopAdapter;
	declare settings: TolariaNavigatorSettings;
	currentFilter: NoteFilter | null = null;
	folderExpansion = new Map<string, boolean>();
	collapsedGroups = new Set<string>();
	private editorGroupLeaf: WorkspaceLeaf | null = null;
	private refreshAll!: Debouncer<[], void>;
	private refreshChanged!: Debouncer<[], void>;
	private changedFiles = new Map<string, TFile>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.collapsedGroups = new Set(this.settings.collapsedSidebarGroups);
		this.folderExpansion = new Map(
			Object.entries(this.settings.folderExpansionState)
		);
		this.service = new VaultService(this.app);
		this.desktop = new DesktopAdapter(this.app);
		this.currentFilter = this.defaultFilter();
		this.refreshAll = debounce(() => this.doRefresh(), 600);
		this.refreshChanged = debounce(() => this.doChangedFileRefresh(), 220);

		this.registerView(
			VIEW_TYPE_TOLARIA_SIDEBAR,
			(leaf) => new SidebarView(leaf, this)
		);
		this.registerView(
			VIEW_TYPE_TOLARIA_LIST,
			(leaf) => new NoteListView(leaf, this)
		);
		this.registerView(
			VIEW_TYPE_TOLARIA_HOME,
			(leaf) => new HomeDashboardView(leaf, this)
		);

		this.addRibbonIcon("list-tree", "打开 Tolaria 导航", () => {
			void this.activateSidebar();
		});
		this.addSettingTab(new TolariaNavigatorSettingTab(this.app, this));

		this.addCommand({
			id: "open-sidebar",
			name: "打开 Tolaria 侧边栏",
			callback: () => void this.activateSidebar(),
		});
		this.addCommand({
			id: "reset-layout",
			name: "重置三栏布局",
			callback: () => void this.ensureLayout(this.settings.openHomeOnStartup),
		});
		this.addCommand({
			id: "open-homepage",
			name: "打开主页控制台",
			callback: () => void this.openHomepage(),
		});
		this.addCommand({
			id: "toggle-dashboard-favorite-current",
			name: "将当前文件加入/移出控制台收藏",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.toggleDashboardFavorite(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "open-all-notes",
			name: "打开全部笔记列表",
			callback: () =>
				void this.openNoteList({ kind: "all", label: "全部笔记" }),
		});
		this.addCommand({
			id: "open-inbox",
			name: "打开收件箱",
			callback: () =>
				void this.openNoteList({ kind: "inbox", label: "收件箱" }),
		});
		this.addCommand({
			id: "focus-note-list",
			name: "聚焦笔记列表（启用键盘选择）",
			callback: () => this.activeListView()?.focusList(),
		});
		this.addCommand({
			id: "open-selected-note",
			name: "打开列表中选中的笔记",
			callback: () => this.activeListView()?.openSelected(),
		});
		this.addCommand({
			id: "open-selected-note-menu",
			name: "打开列表中选中笔记的菜单",
			callback: () => this.activeListView()?.showSelectedMenu(),
		});

		this.registerEvent(this.app.vault.on("create", () => this.refreshAll()));
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				void this.handlePathDelete(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.handlePathRename(oldPath, file.path);
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const favorite = this.settings.dashboard.favorites.includes(file.path);
				menu.addItem((item) =>
					item
						.setTitle(favorite ? "从控制台收藏移除" : "添加到控制台收藏")
						.setIcon("star")
						.onClick(() => void this.toggleDashboardFavorite(file.path))
				);
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				void this.migrateLegacyFavoriteFlags();
				this.refreshAll();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.service.invalidateExcerpt(file.path);
				this.changedFiles.set(file.path, file);
				this.refreshChanged();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const activePath = file?.path ?? null;
				for (const leaf of this.app.workspace.getLeavesOfType(
					VIEW_TYPE_TOLARIA_LIST
				)) {
					(leaf.view as NoteListView).highlightActiveFile(activePath);
				}
			})
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const activePath =
					leaf?.view instanceof MarkdownView
						? (leaf.view.file?.path ?? null)
						: (this.app.workspace.getActiveFile()?.path ?? null);
				for (const leaf of this.app.workspace.getLeavesOfType(
					VIEW_TYPE_TOLARIA_LIST
				)) {
					(leaf.view as NoteListView).highlightActiveFile(activePath);
				}
			})
		);

		this.app.workspace.onLayoutReady(() => {
			void this.migrateLegacyFavoriteFlags();
			const fixLayout = () => {
				void this.ensureLayout(this.settings.openHomeOnStartup).then(() =>
					this.doRefresh()
				);
			};
			const firstTimer = window.setTimeout(fixLayout, LAYOUT_FIX_DELAY_MS);
			const retryTimer = window.setTimeout(fixLayout, LAYOUT_FIX_DELAY_MS * 3);
			this.register(() => {
				window.clearTimeout(firstTimer);
				window.clearTimeout(retryTimer);
			});
		});
	}

	onunload(): void {
		this.editorGroupLeaf = null;
	}

	private defaultFilter(): NoteFilter {
		const kind = this.settings.defaultList;
		return {
			kind,
			label:
				kind === "inbox" ? "收件箱" : kind === "archive" ? "归档" : "全部笔记",
		};
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<TolariaNavigatorSettings> | null;
		const legacy = saved?.dashboard ? null : await this.loadLegacyDashboardSettings();
		const dashboard = {
			...DEFAULT_SETTINGS.dashboard,
			...(legacy ?? {}),
			...(saved?.dashboard ?? {}),
		};
		this.settings = {
			openHomeOnStartup:
				saved?.openHomeOnStartup ?? legacy?.openOnStartup ?? DEFAULT_SETTINGS.openHomeOnStartup,
			dashboard: {
				weekStartsMonday: dashboard.weekStartsMonday === true,
				heatmapWeeks: this.clampNumber(dashboard.heatmapWeeks, 12, 26, 18),
				recentLimit: this.clampNumber(dashboard.recentLimit, 3, 15, 7),
				favorites: Array.isArray(dashboard.favorites) ? dashboard.favorites.filter((path): path is string => typeof path === "string") : [],
				navCollapsed: Array.isArray(dashboard.navCollapsed) ? dashboard.navCollapsed.filter((key): key is string => typeof key === "string") : [],
				tasksByDate: dashboard.tasksByDate && typeof dashboard.tasksByDate === "object" ? dashboard.tasksByDate : {},
			},
			defaultList: saved?.defaultList ?? DEFAULT_SETTINGS.defaultList,
			defaultSort: saved?.defaultSort ?? DEFAULT_SETTINGS.defaultSort,
			defaultSortDirection:
				saved?.defaultSortDirection ?? DEFAULT_SETTINGS.defaultSortDirection,
			newNoteFolder: saved?.newNoteFolder ?? DEFAULT_SETTINGS.newNoteFolder,
			collapsedSidebarGroups: Array.isArray(saved?.collapsedSidebarGroups)
				? saved.collapsedSidebarGroups
				: [...DEFAULT_SETTINGS.collapsedSidebarGroups],
			pinnedNotePaths: Array.isArray(saved?.pinnedNotePaths)
				? saved.pinnedNotePaths
				: [],
			legacyFavoriteFlagsMigrated:
				saved?.legacyFavoriteFlagsMigrated === true,
			folderExpansionState:
				saved?.folderExpansionState &&
				typeof saved.folderExpansionState === "object"
					? saved.folderExpansionState
					: {},
			newNoteTemplatePath:
				saved?.newNoteTemplatePath ?? DEFAULT_SETTINGS.newNoteTemplatePath,
		};
		if (!saved?.dashboard) await this.saveSettings();
	}

	private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value)
			? Math.max(min, Math.min(max, Math.round(value)))
			: fallback;
	}

	private async loadLegacyDashboardSettings(): Promise<
		(Partial<DashboardSettings> & { openOnStartup?: boolean }) | null
	> {
		try {
			const path = `${this.app.vault.configDir}/${LEGACY_DASHBOARD_PLUGIN_PATH}`;
			if (!(await this.app.vault.adapter.exists(path))) {
				return null;
			}
			return JSON.parse(await this.app.vault.adapter.read(path)) as Partial<
				DashboardSettings
			> & { openOnStartup?: boolean };
		} catch (error) {
			console.warn("[Tolaria] 读取旧主页控制台设置失败", error);
			return null;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async migrateLegacyFavoriteFlags(): Promise<void> {
		if (this.settings.legacyFavoriteFlagsMigrated) return;
		const files = this.app.vault.getMarkdownFiles();
		const cachedFiles = files.filter((file) =>
			this.app.metadataCache.getFileCache(file)
		);
		if (files.length > 0 && cachedFiles.length === 0) return;
		const legacyFavorites = cachedFiles
			.filter(
				(file) =>
					this.app.metadataCache.getFileCache(file)?.frontmatter?.[
						"favorite"
					] === true
			)
			.map((file) => file.path);
		this.settings.dashboard.favorites = [
			...new Set([
				...this.settings.dashboard.favorites,
				...legacyFavorites,
			]),
		];
		this.settings.legacyFavoriteFlagsMigrated = true;
		await this.saveSettings();
		this.refreshDashboard();
	}

	async toggleSidebarGroup(key: string): Promise<void> {
		if (this.collapsedGroups.has(key)) {
			this.collapsedGroups.delete(key);
		} else {
			this.collapsedGroups.add(key);
		}
		this.settings.collapsedSidebarGroups = [...this.collapsedGroups];
		await this.saveSettings();
	}

	async setFolderExpanded(path: string, expanded: boolean): Promise<void> {
		this.folderExpansion.set(path, expanded);
		this.settings.folderExpansionState = Object.fromEntries(
			this.folderExpansion
		);
		await this.saveSettings();
	}

	async createNoteInFolder(folderPath: string): Promise<TFile> {
		const vault = this.app.vault;
		if (
			folderPath &&
			!(vault.getAbstractFileByPath(folderPath) instanceof TFolder)
		) {
			await vault.createFolder(folderPath);
		}
		const base = "未命名";
		let title = base;
		let filename = `${title}.md`;
		let index = 1;
		while (
			vault.getAbstractFileByPath(
				folderPath ? `${folderPath}/${filename}` : filename
			)
		) {
			title = `${base} ${index++}`;
			filename = `${title}.md`;
		}
		const path = folderPath ? `${folderPath}/${filename}` : filename;
		let content = "";
		const template = vault.getAbstractFileByPath(
			this.settings.newNoteTemplatePath
		);
		if (this.settings.newNoteTemplatePath && !(template instanceof TFile)) {
			throw new Error(
				`找不到新建笔记模板：${this.settings.newNoteTemplatePath}`
			);
		}
		if (template instanceof TFile) {
			content = applyTemplate(
				await vault.cachedRead(template),
				title,
				this.todayKey()
			);
		}
		return vault.create(path, content);
	}

	private todayKey(): string {
		const date = new Date();
		return [
			date.getFullYear(),
			String(date.getMonth() + 1).padStart(2, "0"),
			String(date.getDate()).padStart(2, "0"),
		].join("-");
	}

	isNotePinned(path: string): boolean {
		return this.settings.pinnedNotePaths.includes(path);
	}

	async togglePinnedNote(path: string): Promise<void> {
		if (this.isNotePinned(path)) {
			this.settings.pinnedNotePaths = this.settings.pinnedNotePaths.filter(
				(pinnedPath) => pinnedPath !== path
			);
		} else {
			this.settings.pinnedNotePaths = [
				...this.settings.pinnedNotePaths,
				path,
			];
		}
		await this.saveSettings();
	}

	async replacePinnedNotePath(oldPath: string, newPath: string): Promise<void> {
		if (!this.isNotePinned(oldPath)) return;
		this.settings.pinnedNotePaths = this.settings.pinnedNotePaths.map((path) =>
			path === oldPath ? newPath : path
		);
		await this.saveSettings();
	}

	async removePinnedNote(path: string): Promise<void> {
		if (!this.isNotePinned(path)) return;
		this.settings.pinnedNotePaths = this.settings.pinnedNotePaths.filter(
			(pinnedPath) => pinnedPath !== path
		);
		await this.saveSettings();
	}

	private async handlePathRename(
		oldPath: string,
		newPath: string
	): Promise<void> {
		this.service.invalidateExcerpt(oldPath);
		this.service.invalidateExcerpt(newPath);
		const pinned = this.settings.pinnedNotePaths.map((path) =>
			replacePathPrefix(path, oldPath, newPath)
		);
		const favorites = this.settings.dashboard.favorites.map((path) =>
			replacePathPrefix(path, oldPath, newPath)
		);
		this.settings.pinnedNotePaths = [...new Set(pinned)];
		this.settings.dashboard.favorites = [...new Set(favorites)];

		if (this.currentFilter?.kind === "folder") {
			this.currentFilter.value = replacePathPrefix(
				this.currentFilter.value ?? "",
				oldPath,
				newPath
			);
		}
		this.folderExpansion = new Map(
			[...this.folderExpansion.entries()].map(([path, expanded]) => [
				replacePathPrefix(path, oldPath, newPath),
				expanded,
			])
		);
		this.settings.folderExpansionState = Object.fromEntries(
			this.folderExpansion
		);
		await this.saveSettings();
		this.refreshAll();
	}

	private async handlePathDelete(path: string): Promise<void> {
		this.service.invalidateExcerpt(path);
		const pinned = removePathsWithin(this.settings.pinnedNotePaths, path);
		const favorites = removePathsWithin(
			this.settings.dashboard.favorites,
			path
		);
		this.settings.pinnedNotePaths = pinned;
		this.settings.dashboard.favorites = favorites;
		if (
			this.currentFilter?.kind === "folder" &&
			removePathsWithin([this.currentFilter.value ?? ""], path).length === 0
		) {
			this.currentFilter = this.defaultFilter();
		}
		for (const key of [...this.folderExpansion.keys()]) {
			if (removePathsWithin([key], path).length === 0) {
				this.folderExpansion.delete(key);
			}
		}
		this.settings.folderExpansionState = Object.fromEntries(
			this.folderExpansion
		);
		await this.saveSettings();
		this.refreshAll();
	}

	async saveListSort(
		option: TolariaNavigatorSettings["defaultSort"],
		direction: TolariaNavigatorSettings["defaultSortDirection"]
	): Promise<void> {
		this.settings.defaultSort = option;
		this.settings.defaultSortDirection = direction;
		await this.saveSettings();
	}

	async openHomepage(): Promise<void> {
		const listLeaf = await this.ensureLayout(false);
		if (!listLeaf) return;
		let dashboard = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.first();
		if (!dashboard) {
			const host = this.editorGroupLeaf;
			if (!this.isAttachedLeaf(host)) return;
			dashboard = host.view.getViewType() === "empty" ? host : this.createTabInGroup(host);
			await dashboard.setViewState({ type: VIEW_TYPE_TOLARIA_HOME, active: true });
			this.pinHomeTab(dashboard);
		}
		this.editorGroupLeaf = dashboard;
		await this.app.workspace.revealLeaf(dashboard);
	}

	/** 主页控制台标签创建时默认锁定，避免被日常打开的笔记替换。 */
	private pinHomeTab(leaf: WorkspaceLeaf): void {
		leaf.setPinned(true);
	}

	private allWorkspaceLeaves(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		return leaves;
	}

	private isAttachedLeaf(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
		return !!leaf && this.allWorkspaceLeaves().includes(leaf);
	}

	/** 与主页控制台一致：先激活目标组，再让 Obsidian 在当前组创建新标签。 */
	private createTabInGroup(host: WorkspaceLeaf): WorkspaceLeaf {
		this.app.workspace.setActiveLeaf(host, { focus: true });
		return this.app.workspace.getLeaf(true);
	}

	/** 始终在主页控制台所在的标签组打开文件，不依赖控制台视图当前是否激活。 */
	private async openFromHomeDashboard(file: TFile): Promise<boolean> {
		const dashboard = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.first();
		if (!dashboard) return false;
		const existing = this.app.workspace
			.getLeavesOfType("markdown")
			.find(
				(leaf) =>
					leaf.parent === dashboard.parent &&
					leaf.view instanceof MarkdownView &&
					leaf.view.file?.path === file.path
			);
		if (existing) {
			this.editorGroupLeaf = existing;
			await this.app.workspace.revealLeaf(existing);
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return true;
		}
		await this.app.workspace.revealLeaf(dashboard);
		this.app.workspace.setActiveLeaf(dashboard, { focus: true });
		await new Promise<void>((resolve) =>
			window.requestAnimationFrame(() => resolve())
		);
		const editor = this.createTabInGroup(dashboard);
		await editor.openFile(file);
		this.editorGroupLeaf = editor;
		this.app.workspace.setActiveLeaf(editor, { focus: true });
		return true;
	}

	private findEditorGroupLeaf(listLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
		const root = listLeaf.getRoot();
		const dashboard = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.find(
				(leaf) =>
					leaf.parent instanceof WorkspaceTabs &&
					leaf.parent !== listLeaf.parent &&
					leaf.getRoot() === root
			);
		if (dashboard) return dashboard;
		if (
			this.isAttachedLeaf(this.editorGroupLeaf) &&
			this.editorGroupLeaf.parent instanceof WorkspaceTabs &&
			this.editorGroupLeaf.parent !== listLeaf.parent &&
			this.editorGroupLeaf.getRoot() === root
		) {
			return this.editorGroupLeaf;
		}
		return (
			this.allWorkspaceLeaves().find(
				(leaf) =>
					leaf !== listLeaf &&
					leaf.parent instanceof WorkspaceTabs &&
					leaf.parent !== listLeaf.parent &&
					leaf.getRoot() === root &&
					leaf.view.getViewType() !== VIEW_TYPE_TOLARIA_SIDEBAR &&
					leaf.view.getViewType() !== "empty"
			) ?? null
		);
	}

	/** 创建真正的右侧标签组，并立即放入持久视图，避免空分栏被 Obsidian 回收。 */
	private async createRightGroup(
		listLeaf: WorkspaceLeaf,
		viewType: string = VIEW_TYPE_TOLARIA_HOME
	): Promise<WorkspaceLeaf> {
		const workspace = this.app.workspace;
		const leaf = workspace.createLeafBySplit(listLeaf, "vertical", false);
		await leaf.setViewState({ type: viewType, active: false });
		if (viewType === VIEW_TYPE_TOLARIA_HOME) this.pinHomeTab(leaf);
		return leaf;
	}

	/** 清理旧修复误建在根分栏下、无法承载标签的裸控制台 leaf。 */
	private cleanupMalformedDashboardLeaves(
		listLeaf: WorkspaceLeaf,
		editorGroup: WorkspaceLeaf
	): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_HOME
		)) {
			if (
				leaf !== editorGroup &&
				leaf.getRoot() === listLeaf.getRoot() &&
				!(leaf.parent instanceof WorkspaceTabs)
			) {
				leaf.detach();
			}
		}
	}

	/** 将旧布局中与列表同组的控制台和文档迁回右侧标签组。 */
	private async repairListGroup(
		listLeaf: WorkspaceLeaf,
		editorGroup: WorkspaceLeaf
	): Promise<WorkspaceLeaf> {
		const misplaced = this.allWorkspaceLeaves().filter(
			(leaf) => leaf !== listLeaf && leaf.parent === listLeaf.parent
		);
		if (!misplaced.length) return editorGroup;

		const misplacedDashboard = misplaced.find(
			(leaf) => leaf.view.getViewType() === VIEW_TYPE_TOLARIA_HOME
		);
		let dashboard = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.find((leaf) => leaf.parent === editorGroup.parent);
		if (misplacedDashboard && !dashboard) {
			dashboard =
				editorGroup.view.getViewType() === "empty"
					? editorGroup
					: this.createTabInGroup(editorGroup);
			await dashboard.setViewState({
				type: VIEW_TYPE_TOLARIA_HOME,
				active: false,
			});
			this.pinHomeTab(dashboard);
		}
		misplacedDashboard?.detach();

		for (const leaf of misplaced) {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) continue;
			const file = leaf.view.file;
			const existing = this.app.workspace
				.getLeavesOfType("markdown")
				.find(
					(candidate) =>
						candidate.parent === editorGroup.parent &&
						candidate.view instanceof MarkdownView &&
						candidate.view.file?.path === file.path
				);
			if (!existing) {
				const target =
					editorGroup.view.getViewType() === "empty"
						? editorGroup
						: this.createTabInGroup(editorGroup);
				await target.openFile(file);
			}
			leaf.detach();
		}

		return dashboard ?? editorGroup;
	}

	/** 清理旧版本误建的主区空白分栏，不触碰包含文档或自定义视图的分栏。 */
	private cleanupEmptyMainGroups(
		listLeaf: WorkspaceLeaf,
		editorGroup: WorkspaceLeaf
	): void {
		const mainRoot = listLeaf.getRoot();
		if (editorGroup.getRoot() !== mainRoot) return;
		for (const leaf of this.allWorkspaceLeaves()) {
			if (
				leaf.parent !== listLeaf.parent &&
				leaf.parent !== editorGroup.parent &&
				leaf.getRoot() === mainRoot &&
				leaf.view.getViewType() === "empty"
			) {
				leaf.detach();
			}
		}
	}

	/**
	 * 保证主区恒定为 [Tolaria 列表 | 文档标签组] 两栏：
	 * - 列表 leaf 不存在则在编辑器左侧补建
	 * - 右侧允许主页控制台等自定义视图作为标签存在
	 * - 只有右侧完全不存在时才补建新的标签组，不因缺少 Markdown leaf 而分栏
	 * - openHome 为真且右侧是空白视图时，打开 Tolaria 内置主页控制台
	 */
	async ensureLayout(openHome: boolean): Promise<WorkspaceLeaf | null> {
		const workspace = this.app.workspace;

		const listLeaves = workspace.getLeavesOfType(VIEW_TYPE_TOLARIA_LIST);
		for (let i = 1; i < listLeaves.length; i++) {
			listLeaves[i].detach();
		}
		let listLeaf = listLeaves.first() ?? null;

		if (!listLeaf) {
			const base = workspace.getMostRecentLeaf();
			if (!base) return null;
			// before=true：新列表放在编辑器左侧
			const created = workspace.createLeafBySplit(base, "vertical", true);
			await created.setViewState({
				type: VIEW_TYPE_TOLARIA_LIST,
				active: false,
			});
			listLeaf = created;
		}

		let editorGroup = this.findEditorGroupLeaf(listLeaf);
		if (!editorGroup) {
			const misplaced = this.allWorkspaceLeaves().filter(
				(leaf) => leaf !== listLeaf && leaf.parent === listLeaf.parent
			);
			const firstDocument = misplaced.find(
				(leaf) => leaf.view instanceof MarkdownView && leaf.view.file
			) as WorkspaceLeaf | undefined;
			const hasDashboard = misplaced.some(
				(leaf) => leaf.view.getViewType() === VIEW_TYPE_TOLARIA_HOME
			);
			editorGroup = await this.createRightGroup(
				listLeaf,
				hasDashboard || (!firstDocument && openHome)
					? VIEW_TYPE_TOLARIA_HOME
					: "empty"
			);
		} else {
			this.cleanupEmptyMainGroups(listLeaf, editorGroup);
		}
		editorGroup = await this.repairListGroup(listLeaf, editorGroup);
		this.cleanupMalformedDashboardLeaves(listLeaf, editorGroup);
		this.editorGroupLeaf = editorGroup;

		if (openHome && editorGroup.view.getViewType() === "empty") {
			await editorGroup.setViewState({
				type: VIEW_TYPE_TOLARIA_HOME,
				active: false,
			});
			this.pinHomeTab(editorGroup);
		}

		return listLeaf;
	}

	private doRefresh(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_SIDEBAR
		)) {
			(leaf.view as SidebarView).refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_LIST
		)) {
			(leaf.view as NoteListView).refresh();
		}
		this.refreshDashboard();
	}

	private doChangedFileRefresh(): void {
		const files = [...this.changedFiles.values()];
		this.changedFiles.clear();
		if (!files.length) return;
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_SIDEBAR
		)) {
			(leaf.view as SidebarView).refresh();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_LIST
		)) {
			(leaf.view as NoteListView).refreshFiles(files);
		}
		this.refreshDashboard();
	}

	private activeListView(): NoteListView | null {
		const active = this.app.workspace.getActiveViewOfType(NoteListView);
		if (active) return active;
		const leaf = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_LIST)
			.first();
		return leaf ? (leaf.view as NoteListView) : null;
	}

	refreshDashboard(recomputeWords = false): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_HOME
		)) {
			(leaf.view as HomeDashboardView).refresh(recomputeWords);
		}
	}

	async toggleDashboardFavorite(path: string): Promise<void> {
		const favorites = this.settings.dashboard.favorites;
		const existing = favorites.indexOf(path);
		this.settings.dashboard.favorites =
			existing >= 0
				? favorites.filter((favorite) => favorite !== path)
				: [...favorites, path];
		await this.saveSettings();
		new Notice(existing >= 0 ? "已移除收藏" : "已添加收藏 ★");
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_HOME
		)) {
			(leaf.view as HomeDashboardView).renderFavorites();
		}
		this.refreshAll();
	}

	vaultIconName(): string {
		return "hard-drive";
	}

	async activateSidebar(): Promise<void> {
		const workspace = this.app.workspace;
		let leaf = workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_SIDEBAR)
			.first();
		if (!leaf) {
			const left = workspace.getLeftLeaf(false);
			if (!left) return;
			await left.setViewState({
				type: VIEW_TYPE_TOLARIA_SIDEBAR,
				active: true,
			});
			leaf = left;
		}
		await workspace.revealLeaf(leaf);
	}

	async openNoteList(filter: NoteFilter): Promise<void> {
		this.currentFilter = filter;
		const listLeaf = await this.ensureLayout(false);
		if (!listLeaf) return;
		await (listLeaf.view as NoteListView).setFilter(filter);
		void this.app.workspace.revealLeaf(listLeaf);
		for (const sl of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_SIDEBAR
		)) {
			(sl.view as SidebarView).refresh();
		}
	}

	async openNote(file: TFile): Promise<void> {
		try {
			const listLeaf = await this.ensureLayout(false);
			if (!listLeaf) {
				new Notice("Tolaria：找不到笔记列表区域");
				return;
			}
			if (await this.openFromHomeDashboard(file)) return;
			const editorGroup = this.editorGroupLeaf;
			if (!this.isAttachedLeaf(editorGroup)) {
				new Notice("Tolaria：找不到右侧文档标签组");
				return;
			}

			const existing = this.app.workspace
				.getLeavesOfType("markdown")
				.find(
					(leaf) =>
						leaf.parent === editorGroup.parent &&
						leaf.view instanceof MarkdownView &&
						leaf.view.file?.path === file.path
				);
			if (existing) {
				this.editorGroupLeaf = existing;
				this.app.workspace.setActiveLeaf(existing, { focus: true });
				return;
			}

			const editor = this.createTabInGroup(editorGroup);
			await editor.openFile(file);
			this.editorGroupLeaf = editor;
			this.app.workspace.setActiveLeaf(editor, { focus: true });
		} catch (error) {
			console.error("[Tolaria] 打开笔记失败", error);
			new Notice(`Tolaria 打开失败：${String(error)}`);
		}
	}
}
