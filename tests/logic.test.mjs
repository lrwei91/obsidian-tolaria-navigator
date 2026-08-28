import assert from "node:assert/strict";
import test from "node:test";
import {
	pathIsWithin,
	removePathsWithin,
	replacePathPrefix,
} from "../src/path-utils.ts";
import {
	isArchivedFrontmatter,
	parseFrontmatterDate,
} from "../src/types.ts";
import { applyTemplate, getVirtualRange } from "../src/list-utils.ts";

test("收件箱和根目录使用严格的文件夹边界", () => {
	assert.equal(pathIsWithin("inbox/note.md", "inbox"), true);
	assert.equal(pathIsWithin("inbox/deep/note.md", "inbox"), true);
	assert.equal(pathIsWithin("inbox-old/note.md", "inbox"), false);
	assert.equal(pathIsWithin("notes/note.md", ""), true);
});

test("文件与文件夹重命名会迁移保存路径", () => {
	assert.equal(
		replacePathPrefix("notes/a.md", "notes/a.md", "notes/b.md"),
		"notes/b.md"
	);
	assert.equal(
		replacePathPrefix("notes/topic/a.md", "notes/topic", "notes/area"),
		"notes/area/a.md"
	);
	assert.equal(
		replacePathPrefix("projects/a.md", "notes/topic", "notes/area"),
		"projects/a.md"
	);
});

test("删除文件夹会清理其下保存路径", () => {
	assert.deepEqual(
		removePathsWithin(
			["notes/topic/a.md", "notes/topic/deep/b.md", "notes/other.md"],
			"notes/topic"
		),
		["notes/other.md"]
	);
});

test("归档状态兼容 archived 标记和 status 字段", () => {
	assert.equal(isArchivedFrontmatter({ archived: true }), true);
	assert.equal(isArchivedFrontmatter({ status: " Archived " }), true);
	assert.equal(isArchivedFrontmatter({ status: "active" }), false);
	assert.equal(isArchivedFrontmatter(undefined), false);
});

test("创建时间优先解析 frontmatter 日期", () => {
	const localDate = new Date(2026, 7, 25).getTime();
	assert.equal(parseFrontmatterDate("2026-08-25"), localDate);
	assert.equal(parseFrontmatterDate("not-a-date"), null);
	assert.equal(parseFrontmatterDate("2026-02-30"), null);
	assert.equal(parseFrontmatterDate(1_700_000_000), 1_700_000_000_000);
});

test("虚拟列表只返回视口与缓冲区范围", () => {
	assert.deepEqual(getVirtualRange(1000, 100, 5000, 600, 3), {
		start: 47,
		end: 59,
	});
	assert.deepEqual(getVirtualRange(2, 100, 0, 600, 3), {
		start: 0,
		end: 2,
	});
});

test("主库模板替换标题与日期占位符", () => {
	assert.equal(
		applyTemplate("# {{title}}\n{{date}} / {{title}}", "未命名", "2026-08-25"),
		"# 未命名\n2026-08-25 / 未命名"
	);
});
