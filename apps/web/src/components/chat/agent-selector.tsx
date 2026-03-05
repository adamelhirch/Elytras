"use client";

import { useState, useRef, useEffect } from "react";
import type { Agent } from "./chat-interface";

type Props = {
  agents: Agent[];
  selected: Agent | null;
  onSelect: (agent: Agent) => void;
};

export function AgentSelector({ agents, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm font-medium text-white"
      >
        <AgentAvatar agent={selected} size="sm" />
        <span>{selected?.name ?? "Sélectionner un agent"}</span>
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-[#1a1d27] border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="p-1">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => {
                  onSelect(agent);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  selected?.id === agent.id
                    ? "bg-indigo-500/20 text-indigo-300"
                    : "text-gray-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <AgentAvatar agent={agent} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{agent.name}</div>
                  {agent.description && (
                    <div className="text-xs text-gray-500 truncate">{agent.description}</div>
                  )}
                </div>
                {selected?.id === agent.id && (
                  <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentAvatar({ agent, size }: { agent: Agent | null; size: "sm" | "md" }) {
  const dim = size === "sm" ? "w-5 h-5 text-[10px]" : "w-7 h-7 text-xs";

  if (agent?.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={agent.avatarUrl}
        alt={agent.name}
        className={`${dim} rounded-full object-cover`}
      />
    );
  }

  const initials = agent?.name
    ? agent.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <div
      className={`${dim} rounded-full bg-indigo-500/30 text-indigo-300 flex items-center justify-center font-semibold shrink-0`}
    >
      {initials}
    </div>
  );
}
