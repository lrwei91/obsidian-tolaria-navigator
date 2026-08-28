import {
	ItemView,
	Menu,
	normalizePath,
	Notice,
	setIcon,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import { errorMessage } from "./list-utils";
import { PromptModal } from "./prompt-modal";
import { filtersEqual, NoteFilter } from "./types";

export const VIEW_TYPE_TOLARIA_SIDEBAR = "tolaria-sidebar-view";

export class SidebarView extends ItemView {
	private plugin: TolariaNavigatorPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: TolariaNavigatorPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_TOLARIA_SIDEBAR;
	}

	getDisplayText(): string {
		return "Tolaria 导航";
	}

	getIcon(): string {
		return "list-tree";
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.render();
	}

	async onClose(): Promise<void> {
		await super.onClose();
	}

	refresh(): void {
		if (this.contentEl.isShown()) this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("tol-sidebar");
		const svc = this.plugin.service;

		const fixed = root.createDiv("tol-fixed");
		this.entry(
			fixed,
			"inbox",
			"收件箱",
			svc.inboxNotes(this.plugin.settings.newNoteFolder).length,
			{
			kind: "inbox",
			label: "收件箱",
			}
		);
		this.entry(fixed, "files", "全部笔记", svc.activeNotes().length, {
			kind: "all",
			label: "全部笔记",
		});
		this.entry(fixed, "archive", "归档", svc.archivedNotes().length, {
			kind: "archive",
			label: "归档",
		});

		const favoriteNotes = svc.favoriteNotes(
			this.plugin.settings.dashboard.favorites
		);
		const viewsBody = this.group(root, "视图", "group-views");
		this.entry(viewsBody, "star", "收藏", favoriteNotes.length, {
			kind: "favorite",
			label: "收藏",
		});

		// 类型分组（基于 tags）
		const tagsBody = this.group(root, "类型", "group-tags");
		const tags = svc.allTagsSorted();
		if (tags.length === 0) {
			tagsBody.createDiv({ cls: "tol-empty-hint", text: "暂无标签" });
		} else {
			for (const t of tags) {
				const row = tagsBody.createDiv("tol-row tol-tag-row");
				row.createSpan({ cls: "tol-tag-name", text: `#${t.tag}` });
				row.createSpan({ cls: "tol-badge", text: String(t.count) });
				row.addEventListener("click", () => {
					void this.plugin.openNoteList({
						kind: "tag",
						value: t.tag,
						label: `#${t.tag}`,
					});
				});
			}
		}

		// 文件夹分组（目录树）
		const foldersBody = this.group(root, "文件夹", "group-folders", () =>
			this.promptCreateFolder(svc.rootFolder())
		);
		this.renderFolderTree(foldersBody);
	}

	private entry(
		container: HTMLElement,
		iconName: string,
		label: string,
		count: number | undefined,
		filter: NoteFilter
	): void {
		const row = container.createDiv("tol-entry tol-row");
		if (filtersEqual(this.plugin.currentFilter, filter)) {
			row.addClass("is-active");
		}
		const iconEl = row.createDiv("tol-icon");
		setIcon(iconEl, iconName);
		row.createSpan({ cls: "tol-label", text: label });
		if (typeof count === "number") {
			row.createSpan({ cls: "tol-badge", text: String(count) });
		}
		row.addEventListener("click", () => void this.plugin.openNoteList(filter));
	}

	private group(
		container: HTMLElement,
		title: string,
		key: string,
		onAdd?: () => void
	): HTMLDivElement {
		const header = container.createDiv("tol-group-header");
		const collapsed = this.plugin.collapsedGroups.has(key);
		const chevron = header.createSpan("tol-chevron");
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ cls: "tol-group-title", text: title });
		header.addEventListener("click", (evt) => {
			evt.stopPropagation();
			void this.plugin.toggleSidebarGroup(key);
			this.render();
		});
		if (onAdd) {
			const addBtn = header.createSpan("tol-group-add");
			addBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				onAdd();
			});
			setIcon(addBtn, "plus");
		}

		const body = container.createDiv("tol-group-body");
		if (collapsed) body.addClass("is-collapsed");
		return body;
	}

	private renderFolderTree(container: HTMLElement): void {
		const root = this.plugin.service.rootFolder();
		const tree = container.createDiv("tol-tree");
		const children = sortedFolders(root);
		const rootExpanded = this.folderExpanded("", true);
		const rootRow = tree.createDiv("tol-tree-row tol-root-row");
		if (children.length === 0) rootRow.addClass("no-children");
		const rootChevron = rootRow.createSpan("tol-chevron");
		if (children.length > 0) {
			setIcon(rootChevron, rootExpanded ? "chevron-down" : "chevron-right");
			rootChevron.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleFolder("");
			});
		}
		const rootIcon = rootRow.createDiv("tol-icon");
		setIcon(rootIcon, rootExpanded ? "hard-drive" : "folder-closed");
		rootRow.createSpan({
			cls: "tol-label",
			text: root.name || this.plugin.app.vault.getName(),
		});
		rootRow.addEventListener("click", () => {
			if (children.length > 0) this.toggleFolder("");
			void this.plugin.openNoteList({
				kind: "folder",
				value: "",
				label: root.name || this.plugin.app.vault.getName(),
			});
		});
		rootRow.addEventListener("contextmenu", (evt) => {
			this.showFolderMenu(evt, root);
		});
		if (rootExpanded) {
			for (const child of children) {
				this.renderFolderNode(tree, child, 1);
			}
		}
	}

	private renderFolderNode(
		container: HTMLElement,
		folder: TFolder,
		depth: number
	): void {
		const isExpanded = this.folderExpanded(folder.path);
		const children = sortedFolders(folder);
		const hasChildren = children.length > 0;

		const row = container.createDiv("tol-tree-row");
		row.style.setProperty("--tol-depth", String(depth));
		if (!hasChildren) row.addClass("no-children");

		const chevron = row.createSpan("tol-chevron");
		if (hasChildren) {
			setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
			chevron.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleFolder(folder.path);
			});
		}

		const iconEl = row.createDiv("tol-icon");
		setIcon(iconEl, !isExpanded && hasChildren ? "folder-closed" : "folder");

		row.createSpan({ cls: "tol-label", text: folder.name });
		row.addEventListener("click", (evt) => {
			if (evt.target === chevron) return;
			if (hasChildren) this.toggleFolder(folder.path);
			void this.plugin.openNoteList({
				kind: "folder",
				value: folder.path,
				label: folder.name,
			});
		});
		row.addEventListener("contextmenu", (evt) => {
			this.showFolderMenu(evt, folder);
		});

		if (isExpanded && hasChildren) {
			const childContainer = container.createDiv("tol-tree-children");
			for (const child of children) {
				this.renderFolderNode(childContainer, child, depth + 1);
			}
		}
	}

	private folderExpanded(path: string, isRoot = false): boolean {
		if (this.isRequiredFolderAncestor(path)) return true;
		return this.plugin.folderExpansion.get(path) ?? isRoot;
	}

	private isRequiredFolderAncestor(path: string): boolean {
		const filter = this.plugin.currentFilter;
		if (filter?.kind !== "folder" || !filter.value) return false;
		if (path === "") return true;
		return filter.value.startsWith(`${path}/`);
	}

	private toggleFolder(path: string): void {
		const current = this.folderExpanded(path, path === "");
		void this.plugin.setFolderExpanded(path, !current).then(() => this.refresh());
	}

	private showFolderMenu(evt: MouseEvent, folder: TFolder): void {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("在此文件夹中创建新笔记")
				.setIcon("plus")
				.onClick(() => void this.createNoteInFolder(folder))
		);
		menu.addItem((item) =>
			item
				.setTitle("在此文件夹中创建新文件夹")
				.setIcon("folder-plus")
				.onClick(() => this.promptCreateFolder(folder))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("在文件管理器中显示")
				.setIcon("folder-open")
				.onClick(() => this.revealInFileManager(folder))
		);
		menu.addItem((item) =>
			item
				.setTitle("复制文件夹路径")
				.setIcon("clipboard")
				.onClick(() => void this.copyFolderPath(folder))
		);

		if (folder.path) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("重命名文件夹…")
					.setIcon("pencil")
					.onClick(() => this.promptRenameFolder(folder))
			);
			menu.addItem((item) =>
				item
					.setTitle("删除文件夹…")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.deleteFolder(folder))
			);
		}

		menu.showAtMouseEvent(evt);
	}

	private async createNoteInFolder(folder: TFolder): Promise<void> {
		try {
			const file = await this.plugin.createNoteInFolder(folder.path);
			await this.plugin.openNote(file);
		} catch (error) {
			new Notice(`创建笔记失败：${errorMessage(error)}`);
		}
	}

	private promptCreateFolder(parent: TFolder): void {
		new PromptModal(this.plugin.app, {
			title: "新建文件夹",
			label: "名称",
			initialValue: "",
			submitLabel: "创建",
			onSubmit: async (name) => {
				const path = joinVaultPath(parent.path, name);
				if (this.plugin.app.vault.getAbstractFileByPath(path)) {
					new Notice(`文件夹已存在：${path}`);
					return;
				}
				try {
					await this.plugin.app.vault.createFolder(path);
					await this.plugin.setFolderExpanded(parent.path, true);
					this.refresh();
				} catch (error) {
					new Notice(`创建文件夹失败：${errorMessage(error)}`);
				}
			},
		}).open();
	}

	private revealInFileManager(folder: TFolder): void {
		const result = this.plugin.desktop.showVaultPath(folder.path);
		if (!result.ok) new Notice(result.error ?? "无法打开文件管理器");
	}

	private async copyFolderPath(folder: TFolder): Promise<void> {
		try {
			await navigator.clipboard.writeText(folder.path || "/");
			new Notice("已复制文件夹路径");
		} catch (error) {
			new Notice(`复制路径失败：${errorMessage(error)}`);
		}
	}

	private promptRenameFolder(folder: TFolder): void {
		new PromptModal(this.plugin.app, {
			title: "重命名文件夹",
			label: "名称",
			initialValue: folder.name,
			submitLabel: "重命名",
			onSubmit: async (name) => {
				if (name === folder.name) return;
				const parentPath = folder.parent?.path ?? "";
				const nextPath = joinVaultPath(parentPath, name);
				if (this.plugin.app.vault.getAbstractFileByPath(nextPath)) {
					new Notice(`文件夹已存在：${nextPath}`);
					return;
				}
				try {
					await this.plugin.app.fileManager.renameFile(folder, nextPath);
				} catch (error) {
					new Notice(`重命名失败：${errorMessage(error)}`);
				}
			},
		}).open();
	}

	private async deleteFolder(folder: TFolder): Promise<void> {
		try {
			await this.plugin.app.fileManager.promptForDeletion(folder);
		} catch (error) {
			new Notice(`删除失败：${errorMessage(error)}`);
		}
	}
}

function joinVaultPath(parent: string, name: string): string {
	return normalizePath(parent ? `${parent}/${name}` : name);
}

function sortedFolders(folder: TFolder): TFolder[] {
	return folder.children
		.filter((c): c is TFolder => c instanceof TFolder)
		.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
