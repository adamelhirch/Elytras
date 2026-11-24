export type PipelineOutputDeliveryMode = "final-only" | "step-only" | "step-and-final";

export type PipelineDraftStep = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  outputTargets: string[];
  skillIds: string[];
  nextStepIds: string[];
  routingMode: "linear" | "fan-out" | "conditional" | "terminal";
  condition: string;
  modelRef: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
};

export type PipelineConnectionDescriptor = {
  kind: "target" | "terminal";
  branchLabel: string;
  title: string;
  targetStepId?: string;
};

export type PipelineIncomingDescriptor = {
  sourceStepId: string;
  sourceTitle: string;
  branchLabel: string;
  routingMode: PipelineDraftStep["routingMode"];
};

export type PipelineForm = {
  name: string;
  description: string;
  ownerId: string;
  teamId: string;
  status: "draft" | "queued" | "running" | "paused" | "failed" | "done";
  outputTargets: string;
  outputDeliveryMode: PipelineOutputDeliveryMode;
  steps: PipelineDraftStep[];
};

export type PipelineEditorMode = "create" | "edit";
