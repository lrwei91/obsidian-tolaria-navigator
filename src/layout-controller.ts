import {
	MarkdownView,
	TFile,
	WorkspaceLeaf,
	WorkspaceTabs,
} from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import { VIEW_TYPE_TOLARIA_HOME } from "./home-dashboard";
import { VIEW_TYPE_TOLARIA_LIST } from "./note-list";
import { VIEW_TYPE_TOLARIA_SIDEBAR } from "./sidebar";

/**
 * 工作区布局控制：保证主区恒定为 [Tolaria 列表 | 文档标签组] 两栏，
 * 并负责在右侧文档组中打开笔记（主页控制台优先）。
 */
export class LayoutController {
	private editorGroupLeaf: WorkspaceLeaf | null = null;
	private lastLayoutCheck = 0;

	constructor(private plugin: TolariaNavigatorPlugin) {}

	dispose(): void {
		this.editorGroupLeaf = null;
	}

	async openHomepage(): Promise<void> {
		const listLeaf = await this.ensureLayout(false);
		if (!listLeaf) return;
		let dashboard = this.plugin.app.workspace
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
		await this.plugin.app.workspace.revealLeaf(dashboard);
	}

	/** 始终在右侧文档标签组打开文件；存在主页控制台时通过它定位标签组。 */
	async openNoteInEditorGroup(
		file: TFile,
		listLeaf: WorkspaceLeaf
	): Promise<boolean> {
		const workspace = this.plugin.app.workspace;
		const dashboard = workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.find((leaf) => this.isSiblingGroupLeaf(leaf, listLeaf));
		if (dashboard) {
			await workspace.revealLeaf(dashboard);
			workspace.setActiveLeaf(dashboard, { focus: true });
			await new Promise<void>((resolve) =>
				window.requestAnimationFrame(() => resolve())
			);
			await this.openInTabGroup(file, dashboard);
			return true;
		}

		const editorGroup = this.isAttachedLeaf(this.editorGroupLeaf)
			? this.editorGroupLeaf
			: this.findEditorGroupLeaf(listLeaf);
		if (this.isAttachedLeaf(editorGroup)) {
			await this.openInTabGroup(file, editorGroup);
			return true;
		}

		// “启动时打开主页”关闭时，空白右侧 leaf 可能被 Obsidian 自动回收。
		// 此处直接创建持久的文档 leaf，避免继续依赖已经失效的缓存引用。
		const editor = workspace.createLeafBySplit(listLeaf, "vertical", false);
		await editor.setViewState({
			type: "markdown",
			state: { file: file.path },
			active: true,
		});
		this.editorGroupLeaf = editor;
		workspace.setActiveLeaf(editor, { focus: true });
		return true;
	}

	/**
	 * 保证主区恒定为 [Tolaria 列表 | 文档标签组] 两栏：
	 * - 列表 leaf 不存在则在编辑器左侧补建
	 * - 右侧允许主页控制台等自定义视图作为标签存在
	 * - 只有右侧完全不存在时才补建新的标签组，不因缺少 Markdown leaf 而分栏
	 * - openHome 为真且右侧是空白视图时，打开 Tolaria 内置主页控制台
	 */
	async ensureLayout(openHome: boolean): Promise<WorkspaceLeaf | null> {
		const workspace = this.plugin.app.workspace;

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
		editorGroup = await this.mergeExtraDocumentGroups(listLeaf, editorGroup);
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

	/** 在 host 所在标签组打开文件：已有同文件标签则激活，否则新建标签。 */
	private async openInTabGroup(file: TFile, host: WorkspaceLeaf): Promise<void> {
		const existing = this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.find(
				(leaf) =>
					leaf.parent === host.parent &&
					leaf.view instanceof MarkdownView &&
					leaf.view.file?.path === file.path
			);
		if (existing) {
			this.editorGroupLeaf = existing;
			this.plugin.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		const editor = host.view.getViewType() === "empty" ? host : this.createTabInGroup(host);
		if (host.view.getViewType() === "empty") {
			await editor.setViewState({
				type: "markdown",
				state: { file: file.path },
				active: true,
			});
		} else {
			await editor.openFile(file);
		}
		this.editorGroupLeaf = editor;
		this.plugin.app.workspace.setActiveLeaf(editor, { focus: true });
	}

	/** 主页控制台标签创建时默认锁定，避免被日常打开的笔记替换。 */
	private pinHomeTab(leaf: WorkspaceLeaf): void {
		leaf.setPinned(true);
	}

	private allWorkspaceLeaves(): WorkspaceLeaf[] {
		const leaves = new Set<WorkspaceLeaf>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => leaves.add(leaf));
		// Obsidian 1.13.x 的 iterateAllLeaves 不会稳定包含 empty 视图；
		// 关闭“启动时打开主页”后，右侧占位标签正是这种 leaf。
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("empty")) {
			leaves.add(leaf);
		}
		return [...leaves];
	}

	private isAttachedLeaf(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
		return !!leaf && this.allWorkspaceLeaves().includes(leaf);
	}

	/** 与主页控制台一致：先激活目标组，再让 Obsidian 在当前组创建新标签。 */
	private createTabInGroup(host: WorkspaceLeaf): WorkspaceLeaf {
		this.plugin.app.workspace.setActiveLeaf(host, { focus: true });
		return this.plugin.app.workspace.getLeaf(true);
	}

	private findEditorGroupLeaf(listLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
		const dashboard = this.plugin.app.workspace
			.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME)
			.find((leaf) => this.isSiblingGroupLeaf(leaf, listLeaf));
		if (dashboard) return dashboard;
		if (
			this.isAttachedLeaf(this.editorGroupLeaf) &&
			this.isSiblingGroupLeaf(this.editorGroupLeaf, listLeaf)
		) {
			return this.editorGroupLeaf;
		}
		const candidates = [
			...this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TOLARIA_HOME),
			...this.plugin.app.workspace.getLeavesOfType("markdown"),
			...this.plugin.app.workspace.getLeavesOfType("empty"),
		].filter(
			(leaf) =>
				leaf !== listLeaf &&
				this.isSiblingGroupLeaf(leaf, listLeaf) &&
				leaf.view.getViewType() !== VIEW_TYPE_TOLARIA_SIDEBAR
		);
		// 优先复用有内容的标签组；右侧只剩空白新标签页时也直接复用，避免重复分栏
		return (
			candidates.find((leaf) => leaf.view.getViewType() !== "empty") ??
			candidates.find((leaf) => leaf.view.getViewType() === "empty") ??
			null
		);
	}

	private isSiblingGroupLeaf(
		leaf: WorkspaceLeaf,
		listLeaf: WorkspaceLeaf
	): boolean {
		return (
			leaf.parent instanceof WorkspaceTabs &&
			listLeaf.parent instanceof WorkspaceTabs &&
			leaf.parent !== listLeaf.parent
		);
	}

	/** 创建真正的右侧标签组，并立即放入持久视图，避免空分栏被 Obsidian 回收。 */
	private async createRightGroup(
		listLeaf: WorkspaceLeaf,
		viewType: string = VIEW_TYPE_TOLARIA_HOME
	): Promise<WorkspaceLeaf> {
		const workspace = this.plugin.app.workspace;
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
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(
			VIEW_TYPE_TOLARIA_HOME
		)) {
			if (
				leaf !== editorGroup &&
				leaf.getContainer() === listLeaf.getContainer() &&
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
		let dashboard = this.plugin.app.workspace
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
			const existing = this.plugin.app.workspace
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

	/** 将误建成独立分栏的文档收回右侧标签组，保持主区始终只有两栏。 */
	private async mergeExtraDocumentGroups(
		listLeaf: WorkspaceLeaf,
		editorGroup: WorkspaceLeaf
	): Promise<WorkspaceLeaf> {
		const extras = this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.filter(
				(leaf) =>
					leaf.parent !== editorGroup.parent &&
					this.isSiblingGroupLeaf(leaf, listLeaf) &&
					leaf.view instanceof MarkdownView &&
					leaf.view.file
			);
		for (const leaf of extras) {
			const file = (leaf.view as MarkdownView).file;
			if (!file) continue;
			const existing = this.plugin.app.workspace
				.getLeavesOfType("markdown")
				.find(
					(candidate) =>
						candidate.parent === editorGroup.parent &&
						candidate.view instanceof MarkdownView &&
						candidate.view.file?.path === file.path
				);
			if (!existing) {
				const target = this.createTabInGroup(editorGroup);
				await target.openFile(file);
			}
			leaf.detach();
		}
		return editorGroup;
	}

	/** 清理旧版本误建的主区空白分栏，不触碰包含文档或自定义视图的分栏。 */
	private cleanupEmptyMainGroups(
		listLeaf: WorkspaceLeaf,
		editorGroup: WorkspaceLeaf
	): void {
		if (!this.isSiblingGroupLeaf(editorGroup, listLeaf)) return;
		for (const leaf of this.allWorkspaceLeaves()) {
			if (
				leaf.parent !== listLeaf.parent &&
				leaf.parent !== editorGroup.parent &&
				this.isSiblingGroupLeaf(leaf, listLeaf) &&
				leaf.view.getViewType() === "empty"
			) {
				leaf.detach();
			}
		}
	}
}
