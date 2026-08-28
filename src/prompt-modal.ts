import { App, Modal, Notice, Setting } from "obsidian";

export interface PromptModalOptions {
	title: string;
	label: string;
	initialValue: string;
	submitLabel: string;
	onSubmit: (value: string) => Promise<void>;
}

/** 通用的单行文本输入弹窗（重命名文件/文件夹等）。 */
export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private options: PromptModalOptions
	) {
		super(app);
		this.value = options.initialValue;
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		let inputEl: HTMLInputElement;
		new Setting(this.contentEl).setName(this.options.label).addText((text) => {
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
					.setButtonText(this.options.submitLabel)
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
			new Notice(`${this.options.label}不能为空`);
			return;
		}
		if (/[\\/]/.test(value)) {
			new Notice(`${this.options.label}不能包含斜杠`);
			return;
		}
		this.close();
		await this.options.onSubmit(value);
	}
}
