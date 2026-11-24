import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PipelineFlowBranchHandle, PipelineFlowNodeData } from "./flow";

function handleTop(index: number, count: number) {
  if (count <= 1) {
    return "50%";
  }
  const spread = count === 2 ? 22 : Math.min(16, 44 / Math.max(count - 1, 1));
  const offset = (index - (count - 1) / 2) * spread;
  return `${50 + offset}%`;
}

function branchToneClass(branch: PipelineFlowBranchHandle) {
  if (branch.tone === "conditional") {
    return "conditional";
  }
  if (branch.tone === "fan-out") {
    return "fanout";
  }
  return "linear";
}

export function PipelineFlowNode({ data, selected }: NodeProps<PipelineFlowNodeData>) {
  const branchHandles = data.branchHandles.length
    ? data.branchHandles
    : [{ id: "branch-0", label: "suite", tone: "linear" as const }];

  return (
    <div className={`pipeline-flow-node-card ${selected || data.selected ? "selected" : ""}`}>
      <Handle
        type="target"
        position={Position.Left}
        className="pipeline-flow-handle pipeline-flow-handle-target"
      />
      {branchHandles.map((branch, index) => (
        <Handle
          key={`${data.title}-${branch.id}`}
          id={branch.id}
          type="source"
          position={Position.Right}
          className={`pipeline-flow-handle pipeline-flow-handle-source ${branchToneClass(branch)}`}
          style={{ top: handleTop(index, branchHandles.length) }}
        />
      ))}

      <div className="pipeline-flow-node-head">
        <span className="eyebrow">Step {data.stepNumber}</span>
        <span className="inline-tag">{data.routingLabel}</span>
      </div>
      <strong>{data.title}</strong>
      <small className="muted-line">
        {data.agentId} · {data.modelLabel}
      </small>

      {data.conditionLabel ? (
        <div className="pipeline-flow-condition">
          <span className="eyebrow">Condition</span>
          <strong>{data.conditionLabel}</strong>
        </div>
      ) : null}

      <div className="pipeline-flow-node-stats">
        <span>{data.outputLabel}</span>
        <span>{data.linkCountLabel}</span>
      </div>

      {data.incomingLabels.length ? (
        <div className="pipeline-flow-node-tags">
          {data.incomingLabels.map((label) => (
            <span key={`${data.title}-${label}`}>{label}</span>
          ))}
        </div>
      ) : null}

      <div className="pipeline-flow-branch-list">
        {branchHandles.map((branch) => (
          <div
            key={`${data.title}-${branch.id}-row`}
            className={`pipeline-flow-branch-row ${branchToneClass(branch)}`}
          >
            <span className="mono">{branch.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
