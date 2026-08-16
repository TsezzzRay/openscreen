import { basename } from "node:path";

import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isIdentifier,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast/is";

export type ImportBoundarySource = {
  fileName: string;
  source: string;
};

export function moduleSpecifiers(source: string, fileName: string): string[] {
  return moduleSpecifiersForSources([{ fileName, source }]).get(fileName) ?? [];
}

export function moduleSpecifiersForSources(
  sources: ImportBoundarySource[],
): ReadonlyMap<string, string[]> {
  const root = "/openscreen-import-boundary";
  const virtualSources = sources.map((item, index) => ({
    originalName: item.fileName,
    fileName: `${root}/${index}-${basename(item.fileName)}`,
    source: item.source,
  }));
  const files = Object.fromEntries([
    ...virtualSources.map((item) => [item.fileName, item.source] as const),
    [`${root}/tsconfig.json`, JSON.stringify({
      compilerOptions: { noLib: true },
      files: virtualSources.map((item) => item.fileName),
    })],
  ]);
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem(files),
  });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({
      openFiles: virtualSources.map((item) => item.fileName),
    });
    const results = new Map<string, string[]>();
    for (const item of virtualSources) {
      const project = snapshot.getDefaultProjectForFile(item.fileName);
      const file = project?.program.getSourceFile(item.fileName);
      if (!file) throw new Error(`Unable to parse ${item.originalName}`);
      results.set(item.originalName, collectSpecifiers(file));
    }
    return results;
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

function collectSpecifiers(file: SourceFile): string[] {
  const found: Array<{ position: number; specifier: string }> = file.imports
    .filter(isStringLiteralLikeNode)
    .map((node) => ({ position: node.pos, specifier: node.text }));
  const visit = (node: Node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      isStringLiteralLikeNode(node.arguments[0]!)
    ) {
      found.push({
        position: node.arguments[0]!.pos,
        specifier: node.arguments[0]!.text,
      });
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  const unique = new Map<string, { position: number; specifier: string }>();
  for (const item of found) {
    unique.set(`${item.position}:${item.specifier}`, item);
  }
  return [...unique.values()]
    .sort((left, right) => left.position - right.position)
    .map((item) => item.specifier);
}
