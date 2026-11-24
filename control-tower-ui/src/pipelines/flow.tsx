import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type {
  PipelineConnectionDescriptor,
  PipelineDraftStep,
  PipelineIncomingDescriptor,
  PipelineOutputDeliveryMode,
} from "./types";

export type PipelineFlowBranchHandle = {
  id: string;
  label: string;
  tone: PipelineDraftStep["routingMode"];
};

export type PipelineFlowNodeData = {
  stepNumber: number;
  title: string;
  agentId: string;
  modelLabel: string;
  routingLabel: string;
  outputLabel: string;
  linkCountLabel: string;
  incomingLabels: string[];
  conditionLabel?: string;
  branchHandles: PipelineFlowBranchHandle[];
  selected: boolean;
};

const PIPELINE_NODE_X = 88;
const PIPELINE_NODE_Y = 72;
const PIPELINE_NODE_X_GAP = 320;
const PIPELINE_NODE_Y_GAP = 190;

export function defaultPipelineNodePosition(index: number) {
  return {
    x: 80 + (index % 4) * 260,
    y: 48 + Math.floor(index / 4) * 200,
  };
}

export function formatRoutingModeLabel(mode: PipelineDraftStep["routingMode"]) {
  if (mode === "fan-out") {
    return "multi-sortie";
  }
  if (mode === "conditional") {
    return "condition";
  }
  if (mode === "terminal") {
    return "fin";
  }
  return "lineaire";
}

export function getPipelineDraftStepTitle(step: PipelineDraftStep, index: number) {
  return step.name.trim() || `Step ${index + 1}`;
}

export function getEffectiveDraftStepNextStepIds(
  step: PipelineDraftStep,
  steps: PipelineDraftStep[],
  index: number,
) {
  if (step.routingMode === "terminal") {
    return [];
  }
  const validStepIds = new Set(steps.map((entry) => entry.id));
  const explicitNext = step.nextStepIds.filter(
    (nextStepId) => nextStepId !== step.id && validStepIds.has(nextStepId),
  );
  if (explicitNext.length > 0) {
    return explicitNext;
  }
  const sequentialNext = steps[index + 1];
  return sequentialNext ? [sequentialNext.id] : [];
}

export function describeDraftStepNextTitles(step: PipelineDraftStep, steps: PipelineDraftStep[]) {
  const stepIndex = steps.findIndex((entry) => entry.id === step.id);
  return getEffectiveDraftStepNextStepIds(step, steps, stepIndex)
    .map((nextStepId) => {
      const nextIndex = steps.findIndex((entry) => entry.id === nextStepId);
      const nextStep = steps[nextIndex];
      return nextStep ? getPipelineDraftStepTitle(nextStep, nextIndex) : nextStepId;
    })
    .filter(Boolean);
}

export function getDraftStepConnectionDescriptors(
  step: PipelineDraftStep,
  steps: PipelineDraftStep[],
): PipelineConnectionDescriptor[] {
  const stepIndex = steps.findIndex((entry) => entry.id === step.id);
  const nextStepIds = getEffectiveDraftStepNextStepIds(step, steps, stepIndex);

  if (nextStepIds.length === 0) {
    return [{ kind: "terminal", branchLabel: "stop", title: "Fin du pipeline" }];
  }

  return nextStepIds
    .map((nextStepId, branchIndex) => {
      const nextStepIndex = steps.findIndex((entry) => entry.id === nextStepId);
      const nextStep = steps[nextStepIndex];
      if (!nextStep) {
        return null;
      }

      let branchLabel = "puis";
      if (step.routingMode === "fan-out") {
        branchLabel = nextStepIds.length > 1 ? `branche ${branchIndex + 1}` : "branche";
      } else if (step.routingMode === "conditional") {
        if (branchIndex === 0) {
          branchLabel = step.condition.trim() ? `si ${step.condition.trim()}` : "si condition";
        } else if (branchIndex === 1) {
          branchLabel = "sinon";
        } else {
          branchLabel = `sinon ${branchIndex}`;
        }
      }

      return {
        kind: "target" as const,
        branchLabel,
        title: getPipelineDraftStepTitle(nextStep, nextStepIndex),
        targetStepId: nextStep.id,
      };
    })
    .filter(Boolean) as PipelineConnectionDescriptor[];
}

export function getDraftStepIncomingDescriptors(
  stepId: string,
  steps: PipelineDraftStep[],
): PipelineIncomingDescriptor[] {
  return steps.flatMap((sourceStep, sourceIndex) =>
    getDraftStepConnectionDescriptors(sourceStep, steps)
      .filter((descriptor) => descriptor.targetStepId === stepId)
      .map((descriptor) => ({
        sourceStepId: sourceStep.id,
        sourceTitle: getPipelineDraftStepTitle(sourceStep, sourceIndex),
        branchLabel: descriptor.branchLabel,
        routingMode: sourceStep.routingMode,
      })),
  );
}

function calculatePipelineColumnByStepId(steps: PipelineDraftStep[]) {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const incomingById = new Map<string, string[]>(steps.map((step) => [step.id, [] as string[]]));
  for (const [index, step] of steps.entries()) {
    for (const nextStepId of getEffectiveDraftStepNextStepIds(step, steps, index)) {
      const currentIncoming = incomingById.get(nextStepId) || [];
      incomingById.set(nextStepId, [...currentIncoming, step.id]);
    }
  }

  const columnById = new Map<string, number>();
  const roots = steps.filter((step) => (incomingById.get(step.id) || []).length === 0);
  for (const root of roots.length ? roots : steps.slice(0, 1)) {
    columnById.set(root.id, 0);
  }

  let changed = true;
  let passes = 0;
  while (changed && passes < steps.length * 4) {
    changed = false;
    passes += 1;
    for (const step of steps) {
      const predecessors = incomingById.get(step.id) || [];
      if (predecessors.length === 0) {
        if (!columnById.has(step.id)) {
          columnById.set(step.id, 0);
          changed = true;
        }
        continue;
      }
      if (predecessors.some((predecessorId) => !columnById.has(predecessorId))) {
        continue;
      }
      const branchingPredecessors = predecessors.filter((predecessorId) => {
        const predecessor = stepById.get(predecessorId);
        return predecessor?.routingMode === "conditional" || predecessor?.routingMode === "fan-out";
      });
      const nextColumn =
        branchingPredecessors.length > 0
          ? Math.min(
              ...branchingPredecessors.map(
                (predecessorId) => (columnById.get(predecessorId) || 0) + 1,
              ),
            )
          : Math.max(
              ...predecessors.map((predecessorId) => (columnById.get(predecessorId) || 0) + 1),
            );
      if (columnById.get(step.id) !== nextColumn) {
        columnById.set(step.id, nextColumn);
        changed = true;
      }
    }
  }

  let fallbackColumn = 0;
  for (const step of steps) {
    const assignedColumn = columnById.get(step.id);
    if (typeof assignedColumn === "number") {
      fallbackColumn = Math.max(fallbackColumn, assignedColumn);
      continue;
    }
    columnById.set(step.id, fallbackColumn);
  }
  return columnById;
}

function reserveRow(columnRows: Map<number, number[]>, column: number, desiredRow: number) {
  const occupied = [...(columnRows.get(column) || [])];
  const base = Math.round(desiredRow);
  for (let radius = 0; radius < 48; radius += 1) {
    const candidates = radius === 0 ? [base] : [base - radius, base + radius];
    for (const candidate of candidates) {
      if (!occupied.includes(candidate)) {
        columnRows.set(column, [...occupied, candidate]);
        return candidate;
      }
    }
  }
  const fallback = base + occupied.length + 1;
  columnRows.set(column, [...occupied, fallback]);
  return fallback;
}

function branchRowOffset(branchIndex: number, branchCount: number) {
  if (branchCount <= 1) {
    return 0;
  }
  return (branchIndex - (branchCount - 1) / 2) * 2;
}

export function buildPipelineAutoLayoutPositions(steps: PipelineDraftStep[]) {
  if (steps.length === 0) {
    return {};
  }

  const stepById = new Map(steps.map((step) => [step.id, step]));
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));
  const incomingById = new Map<string, string[]>(steps.map((step) => [step.id, [] as string[]]));
  const columnById = calculatePipelineColumnByStepId(steps);
  for (const [index, step] of steps.entries()) {
    for (const nextStepId of getEffectiveDraftStepNextStepIds(step, steps, index)) {
      const currentIncoming = incomingById.get(nextStepId) || [];
      incomingById.set(nextStepId, [...currentIncoming, step.id]);
    }
  }

  const columnRows = new Map<number, number[]>();
  const rowById = new Map<string, number>();
  let nextRootRow = 0;

  for (const step of steps) {
    const column = columnById.get(step.id) || 0;
    const predecessors = incomingById.get(step.id) || [];
    let desiredRow = nextRootRow;

    if (predecessors.length === 0) {
      desiredRow = nextRootRow;
      nextRootRow += 4;
    } else if (predecessors.length === 1) {
      const predecessorId = predecessors[0];
      const predecessorStep = stepById.get(predecessorId);
      const predecessorIndex = stepIndexById.get(predecessorId) || 0;
      const predecessorRow = rowById.get(predecessorId) ?? nextRootRow;
      const siblingIds = predecessorStep
        ? getEffectiveDraftStepNextStepIds(predecessorStep, steps, predecessorIndex)
        : [];
      const branchIndex = siblingIds.indexOf(step.id);
      if (
        predecessorStep &&
        branchIndex >= 0 &&
        siblingIds.length > 1 &&
        (predecessorStep.routingMode === "conditional" ||
          predecessorStep.routingMode === "fan-out")
      ) {
        desiredRow = predecessorRow + branchRowOffset(branchIndex, siblingIds.length);
      } else {
        desiredRow = predecessorRow;
      }
    } else {
      const predecessorRows = predecessors
        .map((predecessorId) => rowById.get(predecessorId))
        .filter((value): value is number => typeof value === "number");
      desiredRow =
        predecessorRows.length > 0
          ? predecessorRows.reduce((total, value) => total + value, 0) / predecessorRows.length
          : nextRootRow;
    }

    rowById.set(step.id, reserveRow(columnRows, column, desiredRow));
  }

  const minRow = Math.min(...rowById.values());
  return Object.fromEntries(
    steps.map((step, index) => {
      const column = columnById.get(step.id) || 0;
      const row = (rowById.get(step.id) || index) - minRow;
      return [
        step.id,
        {
          x: PIPELINE_NODE_X + column * PIPELINE_NODE_X_GAP,
          y: PIPELINE_NODE_Y + row * PIPELINE_NODE_Y_GAP,
        },
      ];
    }),
  );
}

type BuildFlowGraphParams = {
  steps: PipelineDraftStep[];
  nodePositions: Record<string, { x: number; y: number }>;
  selectedStepId: string;
  outputDeliveryMode: PipelineOutputDeliveryMode;
  outputLabelsByStepId: Record<string, string>;
  modelLabelsByStepId: Record<string, string>;
};

export function buildPipelineFlowGraph(params: BuildFlowGraphParams): {
  nodes: Node<PipelineFlowNodeData>[];
  edges: Edge[];
} {
  const autoPositions = buildPipelineAutoLayoutPositions(params.steps);

  const nodes: Node<PipelineFlowNodeData>[] = params.steps.map((step, index) => {
    const effectiveNextTitles = describeDraftStepNextTitles(step, params.steps);
    const incomingDescriptors = getDraftStepIncomingDescriptors(step.id, params.steps);
    const branchDescriptors = getDraftStepConnectionDescriptors(step, params.steps).filter(
      (descriptor): descriptor is PipelineConnectionDescriptor & { targetStepId: string } =>
        descriptor.kind === "target" && Boolean(descriptor.targetStepId),
    );
    const effectiveModelRef = params.modelLabelsByStepId[step.id] || "";
    const selected = step.id === params.selectedStepId;
    return {
      id: step.id,
      type: "pipelineStep",
      position:
        params.nodePositions[step.id] ||
        autoPositions[step.id] ||
        defaultPipelineNodePosition(index),
      draggable: true,
      data: {
        stepNumber: index + 1,
        title: getPipelineDraftStepTitle(step, index),
        agentId: step.agentId,
        modelLabel: effectiveModelRef || "inherit",
        routingLabel: formatRoutingModeLabel(step.routingMode),
        outputLabel:
          params.outputDeliveryMode === "final-only"
            ? "sortie finale pipeline"
            : params.outputDeliveryMode === "step-only"
              ? params.outputLabelsByStepId[step.id] || "sorties d'etape"
            : params.outputLabelsByStepId[step.id] || "0 outputs",
        linkCountLabel:
          step.routingMode === "conditional"
            ? `${branchDescriptors.length || 0} branches`
            : `${effectiveNextTitles.length || 0} links`,
        incomingLabels: incomingDescriptors
          .slice(0, 2)
          .map((descriptor) => descriptor.branchLabel),
        conditionLabel: step.routingMode === "conditional" ? step.condition.trim() : "",
        branchHandles: branchDescriptors.map((descriptor, descriptorIndex) => ({
          id: `branch-${descriptorIndex}`,
          label: descriptor.branchLabel,
          tone: step.routingMode,
        })),
        selected,
      },
      style: {
        width: 280,
        borderRadius: 22,
        border: "none",
        background: "transparent",
        boxShadow: "none",
        padding: 0,
      },
    };
  });

  const edges: Edge[] = params.steps.flatMap((step) =>
    getDraftStepConnectionDescriptors(step, params.steps)
      .filter((descriptor): descriptor is PipelineConnectionDescriptor & { targetStepId: string } =>
        descriptor.kind === "target" && Boolean(descriptor.targetStepId),
      )
      .map((descriptor, descriptorIndex) => ({
        id: `${step.id}:${descriptor.targetStepId}:${descriptorIndex}`,
        source: step.id,
        sourceHandle: `branch-${descriptorIndex}`,
        target: descriptor.targetStepId,
        label: descriptor.branchLabel,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color:
            step.routingMode === "conditional"
              ? "#bc6a39"
              : step.routingMode === "fan-out"
                ? "#9c5b2e"
                : "#2f6556",
        },
        style: {
          stroke:
            step.routingMode === "conditional"
              ? "#bc6a39"
              : step.routingMode === "fan-out"
                ? "#9c5b2e"
                : "#2f6556",
          strokeWidth: params.selectedStepId === step.id ? 2.5 : 1.8,
        },
        labelStyle: {
          fill: "#3b433f",
          fontSize: 12,
          fontWeight: 700,
        },
        labelBgPadding: [8, 4],
        labelBgBorderRadius: 999,
        labelBgStyle: {
          fill: "#fff9f0",
          fillOpacity: 0.96,
          stroke: "rgba(47, 101, 86, 0.12)",
        },
      })),
  );

  return { nodes, edges };
}
