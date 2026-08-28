import {
	AbstractInputSuggest,
	App,
	normalizePath,
	PluginSettingTab,
	Setting,
	TFolder,
	TFile,
} from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import type { FilterKind, SortDirection, SortOption } from "./types";

export type DefaultListKind = Extract<FilterKind, "all" | "inbox" | "archive">;

export interface DashboardTask {
	id: string;
	time: string;
	text: string;
	done: boolean;
}

export interface DashboardSettings {
	weekStartsMonday: boolean;
	heatmapWeeks: number;
	recentLimit: number;
	favorites: string[];
	navCollapsed: string[];
	tasksByDate: Record<string, DashboardTask[]>;
	navigationRoot: string;
	bookTitle: string;
	bookWords: number;
}

export interface TolariaNavigatorSettings {
	openHomeOnStartup: boolean;
	dashboard: DashboardSettings;
	defaultList: DefaultListKind;
	defaultSort: SortOption;
	defaultSortDirection: SortDirection;
	newNoteFolder: string;
	collapsedSidebarGroups: string[];
	pinnedNotePaths: string[];
	legacyFavoriteFlagsMigrated: boolean;
	folderExpansionState: Record<string, boolean>;
	newNoteTemplatePath: string;
}

export const DEFAULT_SETTINGS: TolariaNavigatorSettings = {
	openHomeOnStartup: true,
	dashboard: {
		weekStartsMonday: false,
		heatmapWeeks: 18,
		recentLimit: 7,
		favorites: [],
		navCollapsed: [],
		tasksByDate: {},
		navigationRoot: "notes",
		bookTitle: "龙族",
		bookWords: 300000,
	},
	defaultList: "all",
	defaultSort: "modified",
	defaultSortDirection: "desc",
	newNoteFolder: "inbox",
	collapsedSidebarGroups: ["group-tags", "group-folders"],
	pinnedNotePaths: [],
	legacyFavoriteFlagsMigrated: false,
	folderExpansionState: {},
	newNoteTemplatePath: "templates/inbox-item.md",
};

const LIST_LABELS: Record<DefaultListKind, string> = {
	all: "全部笔记",
	inbox: "收件箱",
	archive: "归档",
};

const SORT_LABELS: Record<SortOption, string> = {
	modified: "已修改",
	created: "创建时间",
	title: "标题",
	status: "状态",
};

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const needle = query.trim().toLowerCase();
		return this.app.vault
			.getAllFolders()
			.filter((folder) => folder.path.toLowerCase().includes(needle))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path || "/");
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input");
		this.close();
	}
}

class TemplateFileSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, private inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFile[] {
		const needle = query.trim().toLowerCase();
		return this.app.vault
			.getMarkdownFiles()
			.filter(
				(file) =>
					file.path.startsWith("templates/") &&
					file.path.toLowerCase().includes(needle)
			)
			.slice(0, 50);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.inputEl.value = file.path;
		this.inputEl.trigger("input");
		this.close();
	}
}

export class TolariaNavigatorSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TolariaNavigatorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("主页控制台").setHeading();

		new Setting(containerEl)
			.setName("启动时打开主页")
			.setDesc("Obsidian 启动并恢复 Tolaria 三栏布局时，在右侧打开主页控制台。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openHomeOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.openHomeOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("一周从周一开始")
			.setDesc("影响活动热力图与日历的起始列；关闭时从周日开始。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dashboard.weekStartsMonday)
					.onChange(async (value) => {
						this.plugin.settings.dashboard.weekStartsMonday = value;
						await this.plugin.saveSettings();
						this.plugin.refreshDashboard();
					})
			);

		new Setting(containerEl)
			.setName("热力图周数")
			.setDesc("“全部”范围最多显示的周数；窄窗口会自动减少列数。")
			.addSlider((slider) =>
				slider
					.setLimits(12, 26, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.dashboard.heatmapWeeks)
					.onChange(async (value) => {
						this.plugin.settings.dashboard.heatmapWeeks = value;
						await this.plugin.saveSettings();
						this.plugin.refreshDashboard();
					})
			);

		new Setting(containerEl)
			.setName("最近编辑条数")
			.setDesc("主页控制台“最近编辑”面板显示的笔记数量。")
			.addSlider((slider) =>
				slider
					.setLimits(3, 15, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.dashboard.recentLimit)
					.onChange(async (value) => {
						this.plugin.settings.dashboard.recentLimit = value;
						await this.plugin.saveSettings();
						this.plugin.refreshDashboard();
					})
			);

		new Setting(containerEl)
			.setName("分类导航根目录")
			.setDesc("主页控制台“分类导航”扫描的目录，按其一级子目录归类；留空则使用整个仓库。")
			.addSearch((search) => {
				new FolderSuggest(this.app, search.inputEl);
				search
					.setPlaceholder(DEFAULT_SETTINGS.dashboard.navigationRoot)
					.setValue(this.plugin.settings.dashboard.navigationRoot)
					.onChange(async (value) => {
						this.plugin.settings.dashboard.navigationRoot = normalizeSettingPath(value);
						await this.plugin.saveSettings();
						this.plugin.refreshDashboard();
					});
			});

		new Setting(containerEl)
			.setName("总字数换算书目")
			.setDesc("概览页脚把总字数换算成“约等于几本书”的书名；留空则不显示换算。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.dashboard.bookTitle)
					.setValue(this.plugin.settings.dashboard.bookTitle)
					.onChange(async (value) => {
						this.plugin.settings.dashboard.bookTitle = value.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshDashboard();
					})
			);

		new Setting(containerEl)
			.setName("单本书字数")
			.setDesc("总字数换算使用的单本书字数。")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.dashboard.bookWords))
					.setValue(String(this.plugin.settings.dashboard.bookWords))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.dashboard.bookWords = parsed;
							await this.plugin.saveSettings();
							this.plugin.refreshDashboard();
						}
					})
			);

		new Setting(containerEl).setName("笔记列表").setHeading();

		new Setting(containerEl)
			.setName("默认列表")
			.setDesc("插件启动时中栏默认展示的列表。")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(LIST_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.defaultList)
					.onChange(async (value) => {
						this.plugin.settings.defaultList = value as DefaultListKind;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("默认排序")
			.setDesc("列表首次打开时使用的排序字段。列表中的排序菜单会同步更新此设置。")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(SORT_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.defaultSort)
					.onChange(async (value) => {
						this.plugin.settings.defaultSort = value as SortOption;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("默认排序方向")
			.setDesc("列表首次打开时使用的升序或降序。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("desc", "降序")
					.addOption("asc", "升序")
					.setValue(this.plugin.settings.defaultSortDirection)
					.onChange(async (value) => {
						this.plugin.settings.defaultSortDirection = value as SortDirection;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("新建笔记").setHeading();

		new Setting(containerEl)
			.setName("默认新建文件夹")
			.setDesc("在非文件夹列表点击“新建笔记”时使用的位置；文件夹列表仍在当前文件夹创建。")
			.addSearch((search) => {
				new FolderSuggest(this.app, search.inputEl);
				search
					.setPlaceholder(DEFAULT_SETTINGS.newNoteFolder)
					.setValue(this.plugin.settings.newNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.newNoteFolder = normalizeSettingPath(value);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("新建笔记模板")
			.setDesc("新建笔记时复制的主库模板；留空则创建空白 Markdown。")
			.addSearch((search) => {
				new TemplateFileSuggest(this.app, search.inputEl);
				search
					.setPlaceholder(DEFAULT_SETTINGS.newNoteTemplatePath)
					.setValue(this.plugin.settings.newNoteTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.newNoteTemplatePath = normalizeSettingPath(value);
						await this.plugin.saveSettings();
					});
			});
	}
}

function normalizeSettingPath(value: string): string {
	const trimmed = value.trim();
	return trimmed ? normalizePath(trimmed) : "";
}
