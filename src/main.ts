import {
	Debouncer,
	getAllTags,
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
import { isArchivedCache, isOrganizedCache, NoteFilter, normalizeTag } from "./types";
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
	private persistSettings!: Debouncer<[], Promise<void>>;
	private settingsDirty = false;
	private changedFiles = new Map<string, TFile>();
	private layoutReady = false;
	private lastLayoutCheck = 0;
	private pinnedPaths = new Set<string>();
	private sidebarMetaCache = new Map<string, string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.pinnedPaths = new Set(this.settings.pinnedNotePaths);
		this.collapsedGroups = new Set(this.settings.collapsedSidebarGroups);
		this.folderExpansion = new Map(
			Object.entries(this.settings.folderExpansionState)
		);
		this.service = new VaultService(this.app);
		this.desktop = new DesktopAdapter(this.app);
		this.currentFilter = this.defaultFilter();
		this.refreshAll = debounce(() => this.doRefresh(), 600);
		this.refreshChanged = debounce(() => this.doChangedFileRefresh(), 220);
		this.persistSettings = debounce(async () => {
			this.settingsDirty = false;
			await this.saveSettings();
		}, 800);

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

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				// 文件夹和启动索引阶段也会触发 create，过滤后避免启动刷新风暴
				if (!(file instanceof TFile) || !this.layoutReady) return;
				this.refreshAll();
			})
		);
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
		const resolvedRef = this.app.metadataCache.on("resolved", () => {
			void this.migrateLegacyFavoriteFlags().then((done) => {
				// 一次性迁移：完成后注销监听，避免 "resolved" 每次触发都跑一遍
				if (done) this.app.metadataCache.offref(resolvedRef);
				this.refreshAll();
			});
		});
		this.registerEvent(resolvedRef);
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
				for (const listLeaf of this.app.workspace.getLeavesOfType(
					VIEW_TYPE_TOLARIA_LIST
				)) {
					(listLeaf.view as NoteListView).highlightActiveFile(activePath);
				}
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.layoutReady = true;
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
		this.refreshAll.cancel();
		this.refreshChanged.cancel();
		if (this.settingsDirty) void this.saveSettings();
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
				navigationRoot:
					typeof dashboard.navigationRoot === "string"
						? dashboard.navigationRoot
						: DEFAULT_SETTINGS.dashboard.navigationRoot,
				bookTitle:
					typeof dashboard.bookTitle === "string"
						? dashboard.bookTitle
						: DEFAULT_SETTINGS.dashboard.bookTitle,
				bookWords: this.clampNumber(
					dashboard.bookWords,
					1000,
					10000000,
					DEFAULT_SETTINGS.dashboard.bookWords
				),
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

	/** 高频路径（折叠/置顶/日程等）的防抖持久化，卸载时会 flush。 */
	saveSettingsSoon(): void {
		this.settingsDirty = true;
		this.persistSettings();
	}

	private async migrateLegacyFavoriteFlags(): Promise<boolean> {
		if (this.settings.legacyFavoriteFlagsMigrated) return true;
		const files = this.app.vault.getMarkdownFiles();
		const cachedFiles = files.filter((file) =>
			this.app.metadataCache.getFileCache(file)
		);
		if (files.length > 0 && cachedFiles.length === 0) return false;
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
		return true;
	}

	async toggleSidebarGroup(key: string): Promise<void> {
		if (this.collapsedGroups.has(key)) {
			this.collapsedGroups.delete(key);
		} else {
			this.collapsedGroups.add(key);
		}
		this.settings.collapsedSidebarGroups = [...this.collapsedGroups];
		this.saveSettingsSoon();
	}

	async setFolderExpanded(path: string, expanded: boolean): Promise<void> {
		this.folderExpansion.set(path, expanded);
		this.settings.folderExpansionState = Object.fromEntries(
			this.folderExpansion
		);
		this.saveSettingsSoon();
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
		return this.pinnedPaths.has(path);
	}

	private syncPinnedPaths(): void {
		this.settings.pinnedNotePaths = [...this.pinnedPaths];
	}

	async togglePinnedNote(path: string): Promise<void> {
		if (this.pinnedPaths.has(path)) {
			this.pinnedPaths.delete(path);
		} else {
			this.pinnedPaths.add(path);
		}
		this.syncPinnedPaths();
		this.saveSettingsSoon();
	}

	async replacePinnedNotePath(oldPath: string, newPath: string): Promise<void> {
		if (!this.pinnedPaths.has(oldPath)) return;
		this.pinnedPaths.delete(oldPath);
		this.pinnedPaths.add(newPath);
		this.syncPinnedPaths();
		this.saveSettingsSoon();
	}

	async removePinnedNote(path: string): Promise<void> {
		if (!this.pinnedPaths.delete(path)) return;
		this.syncPinnedPaths();
		this.saveSettingsSoon();
	}

	private async handlePathRename(
		oldPath: string,
		newPath: string
	): Promise<void> {
		this.service.invalidateExcerpt(oldPath);
		this.service.invalidateExcerpt(newPath);
		const nextPinned = new Set<string>();
		for (const path of this.pinnedPaths) {
			nextPinned.add(replacePathPrefix(path, oldPath, newPath));
		}
		this.pinnedPaths = nextPinned;
		this.syncPinnedPaths();
		const favorites = this.settings.dashboard.favorites.map((path) =>
			replacePathPrefix(path, oldPath, newPath)
		);
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
		const meta = this.sidebarMetaCache.get(oldPath);
		if (meta !== undefined) {
			this.sidebarMetaCache.delete(oldPath);
			this.sidebarMetaCache.set(newPath, meta);
		}
		this.saveSettingsSoon();
		this.refreshAll();
	}

	private async handlePathDelete(path: string): Promise<void> {
		this.service.invalidateExcerpt(path);
		this.sidebarMetaCache.delete(path);
		const pinned = removePathsWithin([...this.pinnedPaths], path);
		const favorites = removePathsWithin(
			this.settings.dashboard.favorites,
			path
		);
		this.pinnedPaths = new Set(pinned);
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
		this.saveSettingsSoon();
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

		// 打开笔记等高频调用：刚校验过布局且右侧组仍挂载时直接复用，跳过修复扫描
		if (Date.now() - this.lastLayoutCheck < 1500) {
			const existing = workspace
				.getLeavesOfType(VIEW_TYPE_TOLARIA_LIST)
				.first();
			if (existing && this.isAttachedLeaf(this.editorGroupLeaf)) {
				return existing;
			}
		}

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

		this.lastLayoutCheck = Date.now();
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
		// 纯内容编辑不影响侧边栏的归档/整理/标签统计，跳过其全量重建
		const metaChanged = files.some((file) => this.sidebarSignatureChanged(file));
		if (metaChanged) {
			for (const leaf of this.app.workspace.getLeavesOfType(
				VIEW_TYPE_TOLARIA_SIDEBAR
			)) {
				(leaf.view as SidebarView).refresh();
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_LIST
		)) {
			(leaf.view as NoteListView).refreshFiles(files);
		}
		this.refreshDashboardChanged(files);
	}

	/** 侧边栏统计只依赖归档/整理标记与标签，用签名比较避免无谓刷新。 */
	private sidebarSignature(file: TFile): string {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = (cache ? getAllTags(cache) ?? [] : [])
			.map((tag) => normalizeTag(tag))
			.filter(Boolean)
			.sort()
			.join(",");
		return `${isArchivedCache(cache) ? 1 : 0}|${isOrganizedCache(cache) ? 1 : 0}|${tags}`;
	}

	private sidebarSignatureChanged(file: TFile): boolean {
		const next = this.sidebarSignature(file);
		const previous = this.sidebarMetaCache.get(file.path);
		this.sidebarMetaCache.set(file.path, next);
		return previous === undefined || previous !== next;
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

	private refreshDashboardChanged(files: TFile[]): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_HOME
		)) {
			(leaf.view as HomeDashboardView).refreshChanged(files);
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
		this.refreshDashboard();
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_SIDEBAR
		)) {
			(leaf.view as SidebarView).refresh();
		}
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
