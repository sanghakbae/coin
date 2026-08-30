// iOS는 글자가 16px보다 작은 입력칸에 포커스가 가면 화면 전체를 확대한다.
// 모바일 글자 크기를 정리하다 입력칸이 딸려 내려간 적이 두 번 있어, 규칙을
// 테스트로 고정한다. 새 CSS 파일을 추가하면 STYLESHEETS에 함께 넣을 것.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STYLESHEETS = ["src/App.css", "src/pwa.css"];
const FIELD_SELECTORS = ["input", "select", "textarea"];
const MINIMUM_PX = 16;

function readRules(file) {
  // 주석을 걷어낸 뒤 `선택자 { 선언 }` 단위로 자른다. 이 프로젝트 CSS는
  // 중첩 규칙을 쓰지 않아 이 정도로 충분하다.
  const css = readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file,
    selector: match[1].trim().replace(/\s+/g, " "),
    body: match[2],
  }));
}

function targetsField(selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some((part) => FIELD_SELECTORS.some((field) => new RegExp(`(^|[\\s>+~])${field}(\\W|$)`).test(part)));
}

function declaredFontSizes(body) {
  return [...body.matchAll(/font-size\s*:\s*([^;]+)/g)].map((match) => match[1].trim());
}

const rules = STYLESHEETS.flatMap(readRules);

test("입력칸 글자 크기는 어디에서도 16px 아래로 내려가지 않는다", () => {
  const offenders = [];
  for (const rule of rules) {
    if (!targetsField(rule.selector)) continue;
    for (const value of declaredFontSizes(rule.body)) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
      if (px && Number(px[1]) < MINIMUM_PX) {
        offenders.push(`${rule.file}: ${rule.selector} { font-size: ${value} }`);
        continue;
      }
      const rem = /^(\d+(?:\.\d+)?)r?em$/.exec(value);
      if (rem && Number(rem[1]) * 16 < MINIMUM_PX) {
        offenders.push(`${rule.file}: ${rule.selector} { font-size: ${value} }`);
      }
    }
  }
  assert.deepEqual(offenders, [], `iOS가 화면을 확대합니다:\n${offenders.join("\n")}`);
});

test("입력칸 글자 크기를 정하는 규칙이 남아 있다", () => {
  const baseRule = rules.find((rule) => rule.selector === "input, select, textarea");
  assert.ok(baseRule, "input, select, textarea 공통 규칙이 사라졌습니다.");
  assert.match(baseRule.body, /font-size:\s*var\(--input-font-size\)/);

  const variable = rules.find((rule) => rule.selector === ":root" && rule.body.includes("--input-font-size"));
  assert.ok(variable, ":root에 --input-font-size가 없습니다.");
  const declared = /--input-font-size:\s*(\d+(?:\.\d+)?)px/.exec(variable.body);
  assert.ok(declared, "--input-font-size는 px로 적어 주세요.");
  assert.ok(Number(declared[1]) >= MINIMUM_PX, `--input-font-size가 ${declared[1]}px입니다.`);
});

test("확대를 막는 뷰포트 설정이 들어오지 않았다", () => {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(html);
  assert.ok(viewport, "viewport 메타 태그가 없습니다.");
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport[1], /maximum-scale\s*=\s*1/i);
});
