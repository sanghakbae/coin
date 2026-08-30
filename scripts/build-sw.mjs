// vite build 뒤에 dist/를 훑어 서비스워커를 만든다.
// 캐시 이름에 들어가는 버전은 파일 내용 해시라, 내용이 그대로면 배포해도
// 사용자에게 "새 버전" 안내가 뜨지 않는다.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const templatePath = resolve(root, "scripts/sw-template.js");

// 앱 껍데기만 미리 받아 둔다. 여기 없는 파일은 처음 쓰일 때 런타임 캐시에 담긴다.
const PRECACHE_EXTENSIONS = [".html", ".js", ".css", ".svg", ".png", ".webmanifest"];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(distDir)
  .filter((file) => PRECACHE_EXTENSIONS.includes(file.slice(file.lastIndexOf("."))))
  .sort();

if (!files.some((file) => file.endsWith("index.html"))) {
  console.error("dist/index.html이 없습니다. `vite build`를 먼저 실행하세요.");
  process.exit(1);
}

const hash = createHash("sha256");
const urls = [];
for (const file of files) {
  const url = `/${relative(distDir, file).split(/[\\/]/).join("/")}`;
  urls.push(url);
  hash.update(url);
  hash.update(readFileSync(file));
}

const version = hash.digest("hex").slice(0, 12);
const template = readFileSync(templatePath, "utf8");
const source = template
  .replace("__BUILD_VERSION__", version)
  .replace("__PRECACHE_URLS__", JSON.stringify(urls, null, 2));

writeFileSync(resolve(distDir, "sw.js"), source);

const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`sw.js · 버전 ${version} · 미리 받는 파일 ${urls.length}개 (${(bytes / 1024).toFixed(0)}kB)`);
