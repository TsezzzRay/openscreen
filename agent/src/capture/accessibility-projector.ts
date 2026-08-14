import type {
  CapturedAccessibility,
  CaptureDiagnosticMetadata,
} from "./api.js";
import type { CaptureArtifact } from "./artifact.js";
import type { AccessibilityNode } from "./native/protocol.js";

const CAPTURE_AX_MAX_CHARACTERS = 10_000;
const CAPTURE_AX_MAX_TEXT_BLOCK_CHARACTERS = 2_048;

export type AccessibilityProjectionDiagnostics = NonNullable<
  CaptureDiagnosticMetadata["accessibilityProjection"]
>;

type AccessibilityProjection = {
  context?: CapturedAccessibility;
  diagnostics: AccessibilityProjectionDiagnostics;
};

const SHELL_ROLES = new Set([
  "AXMenuBar",
  "AXMenu",
  "AXMenuItem",
  "AXToolbar",
  "AXStatusBar",
  "AXScrollBar",
  "AXSplitter",
]);

const CONTENT_ROOT_ROLES = new Set([
  "AXWebArea",
  "AXDocument",
]);

const SEMANTIC_ELEMENT_ROLES = new Set([
  "AXButton",
  "AXCheckBox",
  "AXComboBox",
  "AXLink",
  "AXListBox",
  "AXMenuButton",
  "AXPopUpButton",
  "AXRadioButton",
  "AXSlider",
  "AXTab",
  "AXTextArea",
  "AXTextField",
  "AXToggle",
]);

export function projectCapturedAccessibility(
  artifact: CaptureArtifact,
): CapturedAccessibility | undefined {
  return projectAccessibilityWithDiagnostics(artifact).context;
}

export function projectAccessibilityWithDiagnostics(
  artifact: CaptureArtifact,
): AccessibilityProjection {
  const snapshot = artifact.result.accessibility.snapshot;
  if (
    snapshot === undefined ||
    (
      artifact.result.accessibility.quality !== undefined &&
      artifact.result.accessibility.quality !== "useful"
    )
  ) {
    return {
      diagnostics: {
        included: false,
        omittedReason: snapshot === undefined
          ? "capture_unavailable"
          : "no_useful_content",
        projectedNodeCount: 0,
      },
    };
  }
  const normalized = normalizeUsefulAccessibility(snapshot.root, [
    artifact.result.window.applicationName,
    artifact.result.window.title,
  ]);
  if (
    normalized.focusedElement === undefined &&
    normalized.url === undefined &&
    normalized.visibleText.length === 0
  ) {
    return {
      diagnostics: {
        included: false,
        omittedReason: "no_useful_content",
        projectedNodeCount: 0,
        candidateNodeCount: normalized.candidateNodeCount,
        usefulTextCharacters: 0,
        uniqueTextBlocks: 0,
        contentRootFound: normalized.contentRootFound,
        projectionTruncated: normalized.textBlockTruncated,
      },
    };
  }
  const focused = normalized.focusedElement;
  let projection: CapturedAccessibility = {
    captureId: artifact.captureId,
    application: "Unknown",
  };
  const application = fitString(
    artifact.result.window.applicationName,
    256,
    (value) => ({ ...projection, application: value }),
  );
  if (application !== undefined) projection = { ...projection, application };
  const windowTitle = fitString(
    artifact.result.window.title,
    512,
    (value) => ({ ...projection, windowTitle: value }),
  );
  if (windowTitle !== undefined) projection = { ...projection, windowTitle };
  if (focused !== undefined) {
    const role = fitString(
      focused.role,
      256,
      (value) => ({ ...projection, focusedElement: { role: value } }),
    );
    if (role !== undefined) {
      projection = { ...projection, focusedElement: { role } };
      const title = fitString(
        focused.title,
        512,
        (value) => ({
          ...projection,
          focusedElement: { ...projection.focusedElement!, title: value },
        }),
      );
      if (title !== undefined) {
        projection = {
          ...projection,
          focusedElement: { ...projection.focusedElement!, title },
        };
      }
      const value = fitString(
        focused.value,
        1_024,
        (candidate) => ({
          ...projection,
          focusedElement: {
            ...projection.focusedElement!,
            value: candidate,
          },
        }),
      );
      if (value !== undefined) {
        projection = {
          ...projection,
          focusedElement: { ...projection.focusedElement!, value },
        };
      }
    }
  }
  let semanticElementsTruncated = normalized.semanticElementsTruncated;
  for (const element of normalized.elements) {
    const candidate = {
      role: truncateCharacters(element.role, 128),
      ...(element.name === undefined
        ? {}
        : { name: truncateCharacters(element.name, 256) }),
      ...(element.value === undefined
        ? {}
        : { value: truncateCharacters(element.value, 512) }),
      ...(element.enabled === undefined ? {} : { enabled: element.enabled }),
      ...(element.selected === undefined ? {} : { selected: element.selected }),
    };
    const elements = [...(projection.elements ?? []), candidate];
    const next = { ...projection, elements };
    if (JSON.stringify(next).length > CAPTURE_AX_MAX_CHARACTERS) {
      semanticElementsTruncated = true;
      break;
    }
    projection = next;
  }
  const url = fitString(
    normalized.url,
    2_048,
    (value) => ({ ...projection, url: value }),
  );
  if (url !== undefined) projection = { ...projection, url };
  const visibleText = fitString(
    normalized.visibleText,
    Number.POSITIVE_INFINITY,
    (value) => ({ ...projection, visibleText: value }),
  );
  if (visibleText !== undefined) projection = { ...projection, visibleText };
  const projectionTruncated = normalized.textBlockTruncated ||
    semanticElementsTruncated ||
    (normalized.visibleText.length > 0 && visibleText !== normalized.visibleText);
  if (JSON.stringify(projection).length > CAPTURE_AX_MAX_CHARACTERS) {
    throw new Error("Accessibility capture projection exceeds its fixed bound");
  }
  return {
    context: projection,
    diagnostics: {
      included: true,
      projectedNodeCount: normalized.projectedNodeCount,
      projectedCharacters: JSON.stringify(projection).length,
      candidateNodeCount: normalized.candidateNodeCount,
      usefulTextCharacters: normalized.visibleText.length,
      uniqueTextBlocks: normalized.uniqueTextBlocks,
      contentRootFound: normalized.contentRootFound,
      projectionTruncated,
    },
  };
}

function normalizeUsefulAccessibility(
  root: AccessibilityNode,
  excludedText: Array<string | undefined>,
): {
  focusedElement?: {
    role: string;
    title?: string;
    value?: string;
  };
  visibleText: string;
  url?: string;
  projectedNodeCount: number;
  candidateNodeCount: number;
  uniqueTextBlocks: number;
  contentRootFound: boolean;
  textBlockTruncated: boolean;
  elements: NonNullable<CapturedAccessibility["elements"]>;
  semanticElementsTruncated: boolean;
} {
  const lines: string[] = [];
  const seen = new Set<string>();
  const projectedNodes = new Set<AccessibilityNode>();
  const candidateNodes = new Set<AccessibilityNode>();
  const excluded = new Set(
    excludedText
      .map(normalizedTextKey)
      .filter((value): value is string => value !== undefined),
  );
  let focusedElement: {
    role: string;
    title?: string;
    value?: string;
  } | undefined;
  let url: string | undefined;
  let textBlockTruncated = false;
  let semanticElementsTruncated = false;
  const elements: NonNullable<CapturedAccessibility["elements"]> = [];

  const contentRoots: AccessibilityNode[] = [];
  const findContentRoots = (node: AccessibilityNode) => {
    if (SHELL_ROLES.has(node.role)) return;
    if (CONTENT_ROOT_ROLES.has(node.role)) {
      contentRoots.push(node);
      return;
    }
    for (const child of node.children ?? []) findContentRoots(child);
  };
  findContentRoots(root);
  const prioritizedRoots = new Set(contentRoots);

  const visit = (
    node: AccessibilityNode,
    isRoot = false,
    skipPrioritizedRoots = false,
    collectText = true,
  ) => {
    if (SHELL_ROLES.has(node.role)) {
      if (!collectText) {
        for (const child of node.children ?? []) {
          visit(child, false, skipPrioritizedRoots, false);
        }
      }
      return;
    }
    if (skipPrioritizedRoots && prioritizedRoots.has(node)) return;
    const candidates = isRoot
      ? []
      : [node.title, node.value, node.description];
    const meaningful = candidates
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate));
    if (meaningful.length > 0) candidateNodes.add(node);
    const useful = meaningful.filter((candidate) => {
      const key = normalizedTextKey(candidate);
      return key !== undefined && !excluded.has(key);
    });
    let contributed = false;
    for (const candidate of useful) {
      if (url === undefined && /^https?:\/\/\S+$/i.test(candidate)) {
        url = candidate;
        contributed = true;
      }
      if (!collectText) continue;
      const bounded = boundTextBlock(candidate);
      if (bounded !== candidate) textBlockTruncated = true;
      if (seen.has(bounded)) continue;
      seen.add(bounded);
      lines.push(bounded);
      contributed = true;
    }
    if (node.focused && focusedElement === undefined && useful.length > 0) {
      const title = useful.includes(node.title?.trim() ?? "")
        ? node.title?.trim()
        : undefined;
      const value = useful.includes(node.value?.trim() ?? "")
        ? node.value?.trim()
        : undefined;
      focusedElement = {
        role: node.role,
        ...(title ? { title } : {}),
        ...(value ? { value } : {}),
      };
      contributed = true;
    }
    if (
      collectText &&
      !node.focused &&
      SEMANTIC_ELEMENT_ROLES.has(node.role) &&
      useful.length > 0
    ) {
      if (elements.length < 64) {
        const name = [node.title, node.description]
          .map((value) => value?.trim())
          .find((value): value is string =>
            Boolean(value) && useful.includes(value!)
          );
        const value = node.value?.trim();
        elements.push({
          role: node.role,
          ...(name === undefined ? {} : { name }),
          ...(value === undefined || !useful.includes(value) ? {} : { value }),
          ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
          ...(node.selected === undefined ? {} : { selected: node.selected }),
        });
      } else {
        semanticElementsTruncated = true;
      }
    }
    if (contributed) projectedNodes.add(node);
    for (const child of node.children ?? []) {
      visit(child, false, skipPrioritizedRoots, collectText);
    }
  };
  for (const contentRoot of contentRoots) visit(contentRoot);
  visit(root, true, true, contentRoots.length === 0);
  return {
    ...(focusedElement === undefined ? {} : { focusedElement }),
    visibleText: lines.join("\n"),
    ...(url === undefined ? {} : { url }),
    projectedNodeCount: projectedNodes.size,
    candidateNodeCount: candidateNodes.size,
    uniqueTextBlocks: lines.length,
    contentRootFound: contentRoots.length > 0,
    textBlockTruncated,
    elements,
    semanticElementsTruncated,
  };
}

function normalizedTextKey(value: string | undefined) {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  return normalized || undefined;
}

function boundTextBlock(value: string) {
  const characters = [...value];
  if (characters.length <= CAPTURE_AX_MAX_TEXT_BLOCK_CHARACTERS) return value;
  return characters
    .slice(0, CAPTURE_AX_MAX_TEXT_BLOCK_CHARACTERS - 1)
    .join("") + "…";
}

function truncateCharacters(value: string, maximum: number) {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  return characters.slice(0, maximum - 1).join("") + "…";
}

function fitString(
  value: string | undefined,
  maximum: number,
  build: (value: string) => CapturedAccessibility,
) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  let low = 0;
  let high = Math.min(characters.length, maximum);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (JSON.stringify(build(candidate)).length <= CAPTURE_AX_MAX_CHARACTERS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low === 0 ? undefined : characters.slice(0, low).join("");
}
