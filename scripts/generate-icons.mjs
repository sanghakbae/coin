// assets/icon.svg 하나에서 홈 화면 아이콘과 파비콘을 전부 만든다.
// 색이나 모양을 바꿀 때는 원본 SVG만 고치고 `npm run icons`를 다시 돌리면 된다.
// 결과물은 public/에 커밋해 두므로 배포 빌드에는 변환기가 필요 없다.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "assets/icon.svg");
const outputDir = resolve(root, "public");

const OUTPUTS = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon-32.png", size: 32 },
  { file: "favicon-96.png", size: 96 },
];

const RENDERERS = [
  {
    name: "rsvg-convert",
    probe: ["--version"],
    args: (size, out) => ["-w", String(size), "-h", String(size), source, "-o", out],
  },
  {
    name: "magick",
    probe: ["-version"],
    args: (size, out) => ["-background", "none", source, "-resize", `${size}x${size}`, out],
  },
  {
    name: "convert",
    probe: ["-version"],
    args: (size, out) => ["-background", "none", source, "-resize", `${size}x${size}`, out],
  },
];

const renderer = RENDERERS.find((candidate) => {
  try {
    execFileSync(candidate.name, candidate.probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

if (!renderer) {
  console.error(
    "SVG를 PNG로 바꿀 도구를 찾지 못했습니다.\n" +
      "  brew install librsvg      (rsvg-convert)\n" +
      "  brew install imagemagick  (magick)\n" +
      "둘 중 하나를 설치한 뒤 다시 실행하세요.\n" +
      "아이콘 파일은 public/에 커밋되어 있으므로 배포 빌드에는 영향이 없습니다.",
  );
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

for (const { file, size } of OUTPUTS) {
  execFileSync(renderer.name, renderer.args(size, resolve(outputDir, file)));
  console.log(`${file} ${size}x${size}`);
}

// 파비콘은 벡터를 그대로 쓰고, SVG를 못 읽는 브라우저만 위 PNG로 떨어진다.
copyFileSync(source, resolve(outputDir, "favicon.svg"));
console.log("favicon.svg");
console.log(`${renderer.name}(으)로 생성했습니다. 색을 바꿨다면 manifest.webmanifest와 index.html의 theme-color도 함께 확인하세요.`);
