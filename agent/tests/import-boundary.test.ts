import assert from "node:assert/strict";
import test from "node:test";

import { moduleSpecifiers } from "./import-boundary.js";

test("finds every supported module-loading syntax", () => {
  const source = `
    import value from "bound-import";
    import "side-effect-import";
    export { value } from "named-export";
    export * from "star-export";
    import legacy = require("import-equals");
    const commonJs = require("commonjs-require");
    const dynamic = import("dynamic-import");
  `;

  assert.deepEqual(moduleSpecifiers(source, "fixture.ts"), [
    "bound-import",
    "side-effect-import",
    "named-export",
    "star-export",
    "import-equals",
    "commonjs-require",
    "dynamic-import",
  ]);
});

test("ignores comments, ordinary strings, and non-literal loaders", () => {
  const source = `
    // import "commented-import";
    /* require("commented-require"); */
    const text = 'import "ordinary-string"';
    const template = \`require("ordinary-template")\`;
    const regularExpression = /require\\("ordinary-regex"\\)/;
    if (condition) /require("control-body-regex")/.test(value);
    loader.require("member-require");
    loader.import("member-import");
    require(variableName);
    import(dynamicName);
  `;

  assert.deepEqual(moduleSpecifiers(source, "fixture.ts"), []);
});

test("finds module loads inside template expressions", () => {
  const source = "const value = `text ${import(\"template-expression\")}`;";

  assert.deepEqual(moduleSpecifiers(source, "fixture.ts"), [
    "template-expression",
  ]);
});
