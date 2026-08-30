import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the app content inside every PWA safe area on mobile", async () => {
  const css = await readFile(new URL("../src/App.css", import.meta.url), "utf8");
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 720px)"));
  const shellStart = mobileBlock.indexOf(".dotShell {");
  const shellEnd = mobileBlock.indexOf("}", shellStart);
  const mobileShell = mobileBlock.slice(shellStart, shellEnd);

  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.match(mobileShell, new RegExp(`padding-${edge}: calc\\(10px \\+ env\\(safe-area-inset-${edge}\\)\\)`));
  }
  assert.doesNotMatch(mobileShell, /padding:\s*10px/);
});
