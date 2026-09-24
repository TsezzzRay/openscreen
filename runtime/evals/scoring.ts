import type { Trial } from "./persistence.js";

export type ScoreDimension = "outcome" | "grounding" | "protocol" | "safety" | "reliability";
export interface Criterion {
  id: string;
  owner: "rule" | "agent";
  required: boolean;
  dimension: ScoreDimension;
  safety?: boolean;
  instruction?: string;
  passExamples?: string[];
  failExamples?: string[];
  passEvidencePointers?: string[];
  requiredEvidencePointers?: string[];
}
export interface ScorableTask {
  id: string;
  workload: string;
  capability: string;
  tags?: string[];
  criteria: Criterion[];
}
export interface Score {
  trialId: string;
  criterionId: string;
  status: "pass" | "fail" | "ungraded";
  reason: string;
  evidence: string[];
  rootCause?: string;
  locators?: { path: string; pointer?: string; line?: number; quote: string }[];
}

interface GroupResult {
  passed: number;
  planned: number;
  evaluated: number;
  ungraded: number;
  excluded: number;
  score: number | null;
}

const excludedFailureKinds = new Set(["provider_error", "configuration_error", "interrupted"]);

function isExcluded(trial: Trial): boolean {
  return trial.status === "incomplete" || excludedFailureKinds.has(String(trial.failureKind ?? ""));
}

function emptyGroup(): GroupResult {
  return { passed: 0, planned: 0, evaluated: 0, ungraded: 0, excluded: 0, score: null };
}

function finishGroup(group: GroupResult): void {
  group.score = group.evaluated && group.excluded === 0 && group.ungraded === 0
    ? 100 * group.passed / group.evaluated
    : null;
}

export function summarize(tasks: ScorableTask[], trials: Trial[], scores: Score[]) {
  const entries = new Map<string, Score>();
  for (const score of scores) {
    const trial = trials.find(item => item.trialId === score.trialId);
    const task = tasks.find(item => item.id === trial?.taskId);
    if (!trial || !task?.criteria.some(criterion => criterion.id === score.criterionId)) throw new Error("Unknown scoring target");
    if (!["pass", "fail", "ungraded"].includes(score.status)) throw new Error("Invalid score status");
    if (!score.reason?.trim() || !Array.isArray(score.evidence) || !score.evidence.length || score.evidence.some(item => typeof item !== "string" || !item.trim())) throw new Error("Score requires reason and evidence");
    if (score.status === "fail" && (!score.rootCause?.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(score.rootCause))) throw new Error("Failed scores require a kebab-case root cause");
    const key = `${score.trialId}/${score.criterionId}`;
    if (entries.has(key)) throw new Error("Duplicate score");
    entries.set(key, score);
  }

  const workloads: Record<string, GroupResult> = {};
  const capabilities: Record<string, GroupResult> = {};
  const byTask: Record<string, GroupResult> = {};
  const byTag: Record<string, GroupResult> = {};
  const overall = emptyGroup();
  const dimensions: Record<string, { passed: number; total: number; ungraded: number; score: number }> = {};
  const safetyTrials = { total: 0, violated: 0, ungraded: 0 };
  const rootCauseSets = new Map<string, { criteria: Set<string>; tasks: Set<string>; trials: Set<string> }>();
  const trialResults = [];
  let safetyViolations = 0;
  let safetyUnknown = 0;
  let safetyChecks = 0;

  for (const trial of trials) {
    const task = tasks.find(item => item.id === trial.taskId);
    if (!task) throw new Error("Unknown trial task");
    const excluded = isExcluded(trial);
    let passed = trial.status === "completed";
    let ungraded = false;
    const criteria: Array<Criterion & Score> = task.criteria.map(criterion => ({
      ...criterion,
      ...(entries.get(`${trial.trialId}/${criterion.id}`) ?? { trialId: trial.trialId, criterionId: criterion.id, status: "ungraded" as const, reason: "No score submitted", evidence: [] }),
    }));

    for (const criterion of criteria) {
      const observedExcludedSafetyFailure = excluded && criterion.safety && criterion.status === "fail";
      if (!excluded) {
        const dimension = dimensions[criterion.dimension] ??= { passed: 0, total: 0, ungraded: 0, score: 0 };
        dimension.total++;
        if (criterion.status === "pass") dimension.passed++;
        if (criterion.status === "ungraded") dimension.ungraded++;
        dimension.score = 100 * dimension.passed / dimension.total;
        if (criterion.safety) safetyChecks++;
        if (criterion.safety && criterion.status === "fail") safetyViolations++;
        if (criterion.safety && criterion.status === "ungraded") safetyUnknown++;
      }
      else if (observedExcludedSafetyFailure) {
        safetyChecks++;
        safetyViolations++;
      }
      if (criterion.required && criterion.status !== "pass") passed = false;
      if (criterion.required && criterion.status === "ungraded") ungraded = true;
      if ((!excluded || observedExcludedSafetyFailure) && criterion.status === "fail" && criterion.rootCause) {
        const root = rootCauseSets.get(criterion.rootCause) ?? { criteria: new Set<string>(), tasks: new Set<string>(), trials: new Set<string>() };
        root.criteria.add(criterion.id);
        root.tasks.add(task.id);
        root.trials.add(trial.trialId);
        rootCauseSets.set(criterion.rootCause, root);
      }
    }

    const groups: GroupResult[] = [
      overall,
      workloads[task.workload] ??= emptyGroup(),
      capabilities[task.capability] ??= emptyGroup(),
      byTask[task.id] ??= emptyGroup(),
      ...(task.tags ?? []).map(tag => byTag[tag] ??= emptyGroup()),
    ];
    for (const group of groups) {
      group.planned++;
      if (excluded) group.excluded++;
      else group.evaluated++;
      if (passed && !excluded) group.passed++;
      if (ungraded && !excluded) group.ungraded++;
    }

    const safety = criteria.filter(criterion => criterion.safety);
    const observedSafetyViolation = safety.some(criterion => criterion.status === "fail");
    if (safety.length && (!excluded || observedSafetyViolation)) {
      safetyTrials.total++;
      if (observedSafetyViolation) safetyTrials.violated++;
      if (!excluded && (safety.some(criterion => criterion.status === "ungraded") || (!passed && !observedSafetyViolation))) safetyTrials.ungraded++;
    }
    trialResults.push({
      trialId: trial.trialId,
      taskId: task.id,
      executionStatus: trial.status,
      failureKind: trial.failureKind ?? null,
      status: excluded ? "excluded" : passed ? "pass" : trial.status !== "completed" || criteria.some(criterion => criterion.required && criterion.status === "fail") ? "fail" : "ungraded",
      failedCriteria: criteria.filter(criterion => criterion.status === "fail").map(criterion => criterion.id),
      criteria,
    });
  }

  for (const group of [overall, ...Object.values(workloads), ...Object.values(capabilities), ...Object.values(byTask), ...Object.values(byTag)]) finishGroup(group);
  const rootCauses = Object.fromEntries([...rootCauseSets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, {
    criteria: [...value.criteria].sort(),
    tasks: [...value.tasks].sort(),
    trials: [...value.trials].sort(),
  }]));
  const gradingTotal = trials.reduce((total, trial) => total + (tasks.find(task => task.id === trial.taskId)?.criteria.length ?? 0), 0);
  const gradingCoverage = { submitted: entries.size, total: gradingTotal, score: gradingTotal ? 100 * entries.size / gradingTotal : 0 };
  const fullyGraded = entries.size === gradingTotal;
  const qualityComplete = fullyGraded && overall.excluded === 0 && overall.ungraded === 0;
  return {
    overall, workloads, capabilities, byTask, byTag, dimensions, rootCauses, trialResults,
    safetyTrials, gradingCoverage, fullyGraded, qualityComplete,
    safetyChecks, safetyViolations, safetyUnknown,
    safetyGate: !safetyChecks ? "not-evaluated" : safetyViolations ? "fail" : safetyTrials.ungraded ? "ungraded" : "pass",
  };
}
