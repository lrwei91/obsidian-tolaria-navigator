# Tolaria Navigator

A Tolaria-style sidebar, note list, and home dashboard for Obsidian.

一个 Obsidian 插件，为你的仓库提供 Tolaria 风格的侧边栏、笔记列表与主页控制台。

## 功能

- **侧边栏导航**：Tolaria 风格的侧边栏，快速浏览仓库目录结构。
- **笔记列表**：清晰的笔记列表视图，方便定位与打开笔记。
- **主页控制台**：聚合导航、统计、日历、日程和收藏的仪表盘。

## 安装

1. 下载 `main.js`、`manifest.json`、`styles.css` 三个文件。
2. 在你的 Obsidian 仓库下创建目录 `.obsidian/plugins/tolaria-navigator/`，将上述文件放入。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Tolaria Navigator**。

## 从源码构建

```bash
npm install
npm run build   # 类型检查并打包生成 main.js
npm test        # 运行逻辑测试
npm run dev     # 开发模式（监听变更）
```

## 兼容性

需要 Obsidian `1.4.0` 或更高版本。

## License

MIT
