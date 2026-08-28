import { App, FileSystemAdapter, Platform } from "obsidian";

interface ElectronShellBridge {
	shell?: {
		showItemInFolder(path: string): void;
	};
}

export interface DesktopActionResult {
	ok: boolean;
	error?: string;
}

/** 将非公开 Electron bridge 约束在单一适配层，避免业务视图直接依赖。 */
export class DesktopAdapter {
	constructor(private app: App) {}

	showVaultPath(path: string): DesktopActionResult {
		if (!Platform.isDesktopApp) {
			return { ok: false, error: "当前平台不支持在文件管理器中显示" };
		}
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return { ok: false, error: "当前存储方式不支持在文件管理器中显示" };
		}
		const bridge = (window as unknown as { electron?: ElectronShellBridge })
			.electron;
		if (!bridge?.shell) {
			return { ok: false, error: "Obsidian 桌面桥接不可用" };
		}
		bridge.shell.showItemInFolder(adapter.getFullPath(path));
		return { ok: true };
	}
}
