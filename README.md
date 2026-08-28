# Tolaria Navigator

A Tolaria-style sidebar, note list, and home dashboard for Obsidian.

一个 Obsidian 插件，为你的仓库提供 Tolaria 风格的侧边栏、笔记列表与主页控制台：导航、统计、日历、日程和收藏。

## Features / 功能

- **Sidebar / 侧边栏**：Tolaria 风格的导航侧边栏——收件箱、全部笔记、归档、收藏计数，标签分类与可展开的文件夹树，支持右键新建/重命名/删除文件夹。
- **Note list / 笔记列表**：虚拟滚动的卡片式列表，支持按文件夹/标签/收藏过滤、多字段排序、关键词搜索、置顶与键盘导航（`↑/↓` 选择、`Enter` 打开、`/` 搜索）。
- **Home dashboard / 主页控制台**：聚合笔记概览（活动热力图、连续记录、总字数）、最近编辑、分类导航、日历、每日日程和收藏面板。
- **Layout manager / 布局管理**：自动维持「侧边栏 | 笔记列表 | 文档标签组」三栏布局，主页控制台标签默认锁定不被覆盖。

## Install / 安装

### From release files / 手动安装

1. 从 [Releases](https://github.com/lrwei91/obsidian-tolaria-navigator/releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 在你的仓库中创建目录 `.obsidian/plugins/tolaria-navigator/`，把三个文件放进去。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Tolaria Navigator**。

### Via BRAT / 通过 BRAT 安装

1. 先安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 运行 BRAT 命令 `Add beta plugin`，输入 `lrwei91/obsidian-tolaria-navigator`。

## Settings / 设置

插件设置页可配置：启动时是否打开主页控制台、一周起始日、热力图周数、最近编辑条数、**分类导航根目录**（默认 `notes`，留空则统计整个仓库）、**总字数换算书目**（页脚“约等于几本书”的换算依据，可留空隐藏）、默认列表与排序、新建笔记的文件夹与模板。

## Developing / 从源码构建

```bash
npm install
npm run dev      # 开发模式（监听变更）
npm test         # 运行单元测试（Node >= 22.6）
npm run build    # 类型检查并打包生成 main.js
```

发布新版本时运行 `npm version <x.y.z>`，它会同步 `package.json`、`manifest.json`、`versions.json`；推送 tag 后 GitHub Actions 会自动构建并创建 Release。

## Compatibility / 兼容性

需要 Obsidian `1.4.0` 或更高版本。

## Screenshots / 截图

<!-- 欢迎补充：侧边栏 / 笔记列表 / 主页控制台 截图 -->

## License

[MIT](LICENSE)
