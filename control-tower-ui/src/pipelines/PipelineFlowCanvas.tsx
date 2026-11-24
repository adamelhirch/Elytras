import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  buildPipelineFlowGraph,
  type PipelineFlowNodeData,
} from "./flow";
import { PipelineFlowNode } from "./PipelineFlowNode";
import type { PipelineDraftStep, PipelineOutputDeliveryMode } from "./types";

type PipelineFlowCanvasProps = {
  editingPipelineId: string;
  steps: PipelineDraftStep[];
  selectedStepId: string;
  nodePositions: Record<string, { x: number; y: number }>;
  outputDeliveryMode: PipelineOutputDeliveryMode;
  viewport: { x: number; y: number; zoom: number } | null;
  outputLabelsByStepId: Record<string, string>;
  modelLabelsByStepId: Record<string, string>;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodeClick: (nodeId: string) => void;
  onNodePositionsChange: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (connection: Connection) => void;
  onEdgeDoubleClick: (edge: Edge) => void;
  onAddStep: () => void;
  onReset: () => void;
};

const nodeTypes: NodeTypes = {
  pipelineStep: PipelineFlowNode,
};

function extractNodePositions(nodes: Node[]) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.position]));
}

function mergeGraphNodes(
  currentNodes: Node<PipelineFlowNodeData>[],
  nextNodes: Node<PipelineFlowNodeData>[],
  nextPositions: Record<string, { x: number; y: number }>,
) {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return nextNodes.map((node) => {
    const currentNode = currentById.get(node.id);
    const preservedPosition =
      currentNode?.position || nextPositions[node.id] || node.position;
    if (!currentNode) {
      return node;
    }
    return {
      ...currentNode,
      ...node,
      data: node.data,
      position: preservedPosition,
      selected: node.data.selected,
      dragging: currentNode.dragging || false,
      measured: currentNode.measured,
      width: currentNode.width,
      height: currentNode.height,
    };
  });
}

export function PipelineFlowCanvas(props: PipelineFlowCanvasProps) {
  const flowInstanceRef = useRef<ReactFlowInstance<Node<PipelineFlowNodeData>, Edge> | null>(null);
  const viewportAppliedKeyRef = useRef("");
  const graph = useMemo(
    () =>
      buildPipelineFlowGraph({
        steps: props.steps,
        nodePositions: props.nodePositions,
        selectedStepId: props.selectedStepId,
        outputDeliveryMode: props.outputDeliveryMode,
        outputLabelsByStepId: props.outputLabelsByStepId,
        modelLabelsByStepId: props.modelLabelsByStepId,
      }),
    [
      props.modelLabelsByStepId,
      props.nodePositions,
      props.outputLabelsByStepId,
      props.outputDeliveryMode,
      props.selectedStepId,
      props.steps,
    ],
  );
  const [nodes, setNodes] = useNodesState<Node<PipelineFlowNodeData>>(graph.nodes);
  const [edges, setEdges] = useEdgesState<Edge>(graph.edges);
  const nodesRef = useRef(nodes);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    setNodes((current) => mergeGraphNodes(current, graph.nodes, props.nodePositions));
  }, [graph.nodes, props.nodePositions, setNodes]);

  useEffect(() => {
    setEdges(graph.edges);
  }, [graph.edges, setEdges]);

  useEffect(() => {
    const instance = flowInstanceRef.current;
    if (!instance) {
      return;
    }
    const viewportKey = `${props.editingPipelineId || "draft"}:${props.viewport ? "saved" : "fit"}`;
    if (viewportAppliedKeyRef.current === viewportKey) {
      return;
    }
    viewportAppliedKeyRef.current = viewportKey;
    window.requestAnimationFrame(() => {
      if (!flowInstanceRef.current) {
        return;
      }
      if (props.viewport) {
        flowInstanceRef.current.setViewport(props.viewport, { duration: 0 });
        return;
      }
      flowInstanceRef.current.fitView({
        padding: 0.24,
        duration: 0,
        minZoom: 0.35,
        maxZoom: 1,
      });
    });
  }, [props.editingPipelineId, props.viewport, props.steps.length]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(changes, nodesRef.current);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    },
    [setNodes],
  );

  return (
    <section className="pipeline-flow-shell">
      <div className="pipeline-flow-toolbar">
        <div className="info-row compact">
          <strong>Canvas pipeline</strong>
          <small className="muted-line">
            Drag pour ranger, relie deux noeuds pour creer un lien, double-clique un edge pour le
            supprimer.
          </small>
        </div>
        <div className="button-row">
          <button type="button" className="ghost-button" onClick={props.onAddStep}>
            + etape
          </button>
          <button type="button" className="ghost-button" onClick={props.onReset}>
            Reset
          </button>
        </div>
      </div>
      <div className="pipeline-reactflow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={0.35}
          maxZoom={1.4}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          onInit={(instance) => {
            flowInstanceRef.current = instance;
          }}
          onMoveEnd={(_, viewport) => props.onViewportChange(viewport)}
          onNodeClick={(_, node) => props.onNodeClick(node.id)}
          onNodesChange={handleNodesChange}
          onNodeDragStop={(_, node) => {
            const nextNodes = nodesRef.current.map((entry) =>
              entry.id === node.id ? { ...entry, position: node.position, dragging: false } : entry,
            );
            nodesRef.current = nextNodes;
            setNodes(nextNodes);
            props.onNodePositionsChange(extractNodePositions(nextNodes));
          }}
          onConnect={(connection) => {
            setEdges((current) =>
              addEdge(
                {
                  ...connection,
                  type: "smoothstep",
                },
                current,
              ),
            );
            props.onConnect(connection);
          }}
          onEdgeDoubleClick={(_, edge) => props.onEdgeDoubleClick(edge)}
        >
          <Background gap={20} size={1} color="rgba(57, 78, 68, 0.12)" />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => (node.id === props.selectedStepId ? "#2f6556" : "#d8d0bf")}
            maskColor="rgba(247, 241, 229, 0.55)"
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}
