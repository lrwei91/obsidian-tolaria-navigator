import { debounce, Debouncer, type App } from "obsidian";
import type { DashboardTask } from "./settings";
import { parseTaskInput } from "./list-utils";

function isValidTask(value: unknown): value is DashboardTask {
	if (!value || typeof value !== "object") return false;
	const task = value as Partial<DashboardTask>;
	return (
		typeof task.id === "string" &&
		typeof task.time === "string" &&
		typeof task.text === "string" &&
		typeof task.done === "boolean"
	);
}

function uniqueId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortTasks(tasks: DashboardTask[]): DashboardTask[] {
	return tasks
		.slice()
		.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
}

/**
 * 日程任务的独立存储（插件目录下 tasks.json）。
 * 以前任务存在 settings/data.json 里，日程一多会把配置文件撑爆；
 * 这里拆出来防抖落盘，并在启动时从旧位置一次性迁移。
 */
export class TaskStore {
	private tasks: Record<string, DashboardTask[]> = {};
	private persist!: Debouncer<[], void>;
	private app: App;
	private pluginDir: string;

	constructor(app: App, pluginDir: string) {
		this.app = app;
		this.pluginDir = pluginDir;
		this.persist = debounce(() => void this.write(), 800);
	}

	private get filePath(): string {
		return `${this.pluginDir}/tasks.json`;
	}

	async load(): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(this.filePath))) return;
			const raw = JSON.parse(await this.app.vault.adapter.read(this.filePath));
			if (!raw || typeof raw !== "object") return;
			for (const [key, value] of Object.entries(raw)) {
				if (!Array.isArray(value)) continue;
				const clean = value.filter(isValidTask);
				if (clean.length) this.tasks[key] = clean;
			}
		} catch (error) {
			console.warn("[Tolaria] 读取日程任务失败", error);
		}
	}

	/** 吸收 settings.tasksByDate 里的旧任务，返回迁移的日期数；调用方负责清空并保存设置 */
	absorbLegacy(legacy: Record<string, DashboardTask[]>): number {
		let moved = 0;
		for (const [key, tasks] of Object.entries(legacy)) {
			if (!Array.isArray(tasks) || !tasks.length) continue;
			const clean = tasks.filter(isValidTask);
			if (!clean.length) continue;
			this.tasks[key] = sortTasks([...(this.tasks[key] ?? []), ...clean]);
			moved++;
		}
		if (moved) this.flush();
		return moved;
	}

	tasksFor(dateKey: string): DashboardTask[] {
		return this.tasks[dateKey] ?? [];
	}

	add(dateKey: string, raw: string): DashboardTask | null {
		const parsed = parseTaskInput(raw);
		if (!parsed.text) return null;
		const task: DashboardTask = { id: uniqueId("task"), time: parsed.time, text: parsed.text, done: false };
		this.tasks[dateKey] = sortTasks([...this.tasksFor(dateKey), task]);
		this.persist();
		return task;
	}

	toggle(dateKey: string, id: string): void {
		const task = this.tasksFor(dateKey).find((item) => item.id === id);
		if (!task) return;
		task.done = !task.done;
		this.persist();
	}

	remove(dateKey: string, id: string): void {
		const next = this.tasksFor(dateKey).filter((task) => task.id !== id);
		if (next.length) this.tasks[dateKey] = next;
		else delete this.tasks[dateKey];
		this.persist();
	}

	flush(): void {
		this.persist.cancel();
		void this.write();
	}

	private async write(): Promise<void> {
		try {
			await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.tasks, null, "\t"));
		} catch (error) {
			console.warn("[Tolaria] 保存日程任务失败", error);
		}
	}
}
