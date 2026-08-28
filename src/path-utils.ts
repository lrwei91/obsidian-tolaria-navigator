function trimSlashes(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

/** 判断文件是否位于指定文件夹内；空文件夹路径代表整个库。 */
export function pathIsWithin(filePath: string, folderPath: string): boolean {
	const folder = trimSlashes(folderPath);
	if (!folder) return true;
	const file = trimSlashes(filePath);
	return file.startsWith(`${folder}/`);
}

/** 将文件或文件夹路径从旧前缀迁移到新前缀；不相关时返回原值。 */
export function replacePathPrefix(
	path: string,
	oldPrefix: string,
	newPrefix: string
): string {
	const oldPath = trimSlashes(oldPrefix);
	const newPath = trimSlashes(newPrefix);
	const normalized = trimSlashes(path);
	if (normalized === oldPath) return newPath;
	if (!oldPath || !normalized.startsWith(`${oldPath}/`)) return normalized;
	const suffix = normalized.slice(oldPath.length + 1);
	return newPath ? `${newPath}/${suffix}` : suffix;
}

export function removePathsWithin(paths: string[], deletedPath: string): string[] {
	const target = trimSlashes(deletedPath);
	return paths.filter((path) => {
		const normalized = trimSlashes(path);
		return normalized !== target && !normalized.startsWith(`${target}/`);
	});
}
