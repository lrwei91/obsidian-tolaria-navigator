import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// 用法：node version-bump.mjs 1.2.3（不传参数则沿用 package.json 的当前版本）
const targetVersion =
	process.argv[2] ??
	JSON.parse(readFileSync("package.json", "utf8")).version;

if (!/^\d+\.\d+\.\d+/.test(targetVersion)) {
	console.error(`无效版本号：${targetVersion}，用法：node version-bump.mjs <x.y.z>`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

const versionsPath = path.resolve("versions.json");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n", "utf8");

for (const file of ["package.json", "manifest.json"]) {
	const fullPath = path.resolve(file);
	const content = readFileSync(fullPath, "utf8");
	const updated = content.replace(
		/("version"\s*:\s*")[^"]*(")/,
		`$1${targetVersion}$2`
	);
	writeFileSync(fullPath, updated, "utf8");
}

console.log(`版本已更新为 ${targetVersion}（package.json / manifest.json / versions.json）`);
