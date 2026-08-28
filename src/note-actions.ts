import { MarkdownView, Notice, normalizePath, TFile } from "obsidian";
import type TolariaNavigatorPlugin from "./main";
import type { NoteFilter } from "./types";
import { errorMessage } from "./list-utils";
import { PromptModal } from "./prompt-modal";

/** 笔记列表中的文件级操作（重命名/归档/删除/导出等），与视图渲染解耦。 */
export class NoteActions {
	constructor(
		private plugin: TolariaNavigatorPlugin,
		private refresh: () => Promise<void>
	) {}

	async openInNewWindow(file: TFile): Promise<void> {
		try {
			await this.plugin.app.workspace.getLeaf("window").openFile(file);
		} catch (error) {
			new Notice(`无法在新窗口打开：${errorMessage(error)}`);
		}
	}

	toggleOrganized(file: TFile): Promise<void> {
		return this.toggleFrontmatterFlag(file, "organized", "整理状态");
	}

	async toggleArchive(file: TFile, currentlyArchived: boolean): Promise<void> {
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
			new Notice(`归档状态更新失败：${errorMessage(error)}`);
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
			new Notice(`${label}更新失败：${errorMessage(error)}`);
		}
	}

	promptRename(file: TFile): void {
		new PromptModal(this.plugin.app, {
			title: "重命名笔记",
			label: "文件名",
			initialValue: file.basename,
			submitLabel: "重命名",
			onSubmit: async (value) => {
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
					new Notice(`重命名失败：${errorMessage(error)}`);
				}
			},
		}).open();
	}

	revealInFileManager(file: TFile): void {
		const result = this.plugin.desktop.showVaultPath(file.path);
		if (!result.ok) new Notice(result.error ?? "无法打开文件管理器");
	}

	async copyFilePath(file: TFile): Promise<void> {
		try {
			await navigator.clipboard.writeText(file.path);
			new Notice("已复制文件路径");
		} catch (error) {
			new Notice(`复制路径失败：${errorMessage(error)}`);
		}
	}

	async exportPdf(file: TFile): Promise<void> {
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

	async deleteNote(file: TFile): Promise<void> {
		try {
			const deleted = await this.plugin.app.fileManager.promptForDeletion(file);
			if (deleted) await this.plugin.removePinnedNote(file.path);
		} catch (error) {
			new Notice(`删除失败：${errorMessage(error)}`);
		}
	}

	/** 新建笔记：文件夹视图建到当前文件夹；其余视图按收件箱工作流建到 inbox/ */
	async createNote(filter: NoteFilter): Promise<void> {
		const folderPath =
			filter.kind === "folder"
				? (filter.value ?? "")
				: this.plugin.settings.newNoteFolder;
		try {
			const file = await this.plugin.createNoteInFolder(folderPath);
			new Notice(`已创建：${file.path}`);
			await this.refresh();
			await this.plugin.openNote(file);
		} catch (err) {
			new Notice(`创建失败：${errorMessage(err)}`);
		}
	}
}
