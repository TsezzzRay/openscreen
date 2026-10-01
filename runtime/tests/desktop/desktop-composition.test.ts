import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production runtime connects CUA typing and the native AX focus guard", async () => {
  const driver = await readFile("runtime/src/desktop/cua-driver.ts", "utf8");
  assert.match(driver, /desktopType:\s*async/);
  assert.match(driver, /desktopDriver\.typeText\(/);
  assert.match(driver, /createDesktopFocusGuard:\s*async/);
  assert.match(driver, /createNativeDesktopFocusGuard\(/);
  assert.match(driver, /InputDeliveryMode\.Background/);
  assert.doesNotMatch(driver, /InputDeliveryMode\.Foreground/);
  assert.match(driver, /desktopActionResult\(result\)/);
  assert.match(driver, /desktopActionResult\(result\.action, result\.text\)/);
  assert.equal(driver.match(/return desktopActionResult\(/g)?.length, 3);
});
