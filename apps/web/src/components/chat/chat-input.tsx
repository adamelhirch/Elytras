"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Agent, Skill, Attachment } from "./chat-interface";

type Props = {
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  agents: Agent[];
  skills: Skill[];
  onMentionAgent: (agent: Agent) => void;
};

type Popup =
  | { type: "agent"; query: string; pos: number }
  | { type: "skill"; query: string; pos: number }
  | null;

export function ChatInput({ onSend, onStop, streaming, disabled, agents, skills, onMentionAgent }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {return;}
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);

    // Détecter @mention (agent)
    const atIdx = before.lastIndexOf("@");
    if (atIdx !== -1 && !before.slice(atIdx).includes(" ")) {
      setPopup({ type: "agent", query: before.slice(atIdx + 1), pos: atIdx });
      return;
    }

    // Détecter /skill
    const slashIdx = before.lastIndexOf("/");
    if (slashIdx !== -1 && !before.slice(slashIdx).includes(" ")) {
      setPopup({ type: "skill", query: before.slice(slashIdx + 1), pos: slashIdx });
      return;
    }

    setPopup(null);
  }, []);

  const send = useCallback(() => {
    if (!text.trim() || streaming || disabled) {return;}
    onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
    setPopup(null);
  }, [text, streaming, disabled, attachments, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
      if (e.key === "Escape") {setPopup(null);}
    },
    [send],
  );

  function pickAgent(agent: Agent) {
    if (!popup) {return;}
    const before = text.slice(0, popup.pos);
    const after = text.slice(popup.pos + 1 + popup.query.length);
    setText(before + after);
    setPopup(null);
    onMentionAgent(agent);
    textareaRef.current?.focus();
  }

  function pickSkill(skill: Skill) {
    if (!popup) {return;}
    // Retirer le /query du texte et ajouter le skill en pièce jointe
    const before = text.slice(0, popup.pos);
    const after = text.slice(popup.pos + 1 + popup.query.length);
    setText(before + after);
    setPopup(null);
    // Ajouter comme attachment de type skill
    setAttachments((prev) => {
      if (prev.some((a) => a.type === "skill" && a.name === skill.name)) {return prev;}
      return [...prev, { name: skill.name, content: skill.content, type: "skill" }];
    });
    textareaRef.current?.focus();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const results = await Promise.all(
      files.map(
        (f) =>
          new Promise<Attachment>((resolve) => {
            const reader = new FileReader();
            reader.addEventListener(
              "load",
              () => {
                resolve({ name: f.name, content: reader.result as string, type: "file" });
              },
              { once: true },
            );
            reader.readAsText(f);
          }),
      ),
    );
    setAttachments((prev) => [...prev, ...results]);
    e.target.value = "";
  }

  const filteredAgents =
    popup?.type === "agent"
      ? agents.filter((a) => a.name.toLowerCase().includes(popup.query.toLowerCase()))
      : [];

  const filteredSkills =
    popup?.type === "skill"
      ? skills.filter((s) => s.name.toLowerCase().includes(popup.query.toLowerCase()))
      : [];

  return (
    <div className="flex flex-col gap-2">
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((att, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ${
                att.type === "skill"
                  ? "bg-violet-500/20 text-violet-300"
                  : "bg-white/10 text-gray-300"
              }`}
            >
              {att.type === "skill" ? "⚡" : "📄"} {att.name}
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-current opacity-50 hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* @agent popup */}
      {popup?.type === "agent" && filteredAgents.length > 0 && (
        <div className="bg-[#1a1d27] border border-white/10 rounded-xl shadow-xl overflow-hidden">
          {filteredAgents.map((agent) => (
            <button
              key={agent.id}
              onMouseDown={(e) => { e.preventDefault(); pickAgent(agent); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors text-left"
            >
              <span className="w-5 h-5 rounded-full bg-indigo-500/30 text-indigo-300 text-[10px] flex items-center justify-center font-semibold shrink-0">
                {agent.name[0]?.toUpperCase()}
              </span>
              <span>{agent.name}</span>
              {agent.model && <span className="text-xs text-gray-600 font-mono ml-auto">{agent.model}</span>}
            </button>
          ))}
        </div>
      )}

      {/* /skill popup */}
      {popup?.type === "skill" && filteredSkills.length > 0 && (
        <div className="bg-[#1a1d27] border border-white/10 rounded-xl shadow-xl overflow-hidden">
          {filteredSkills.map((skill) => (
            <button
              key={skill.id}
              onMouseDown={(e) => { e.preventDefault(); pickSkill(skill); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors text-left"
            >
              <span className="w-5 h-5 rounded bg-violet-500/30 text-violet-300 text-xs flex items-center justify-center shrink-0">
                ⚡
              </span>
              <span>{skill.name}</span>
              {skill.description && (
                <span className="text-xs text-gray-600 ml-auto truncate max-w-[140px]">{skill.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus-within:border-white/20 transition-colors">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.json,.csv,.ts,.js,.py,.html,.css"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="text-gray-500 hover:text-gray-300 transition-colors shrink-0 pb-0.5 disabled:opacity-40"
          title="Joindre un fichier"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled || streaming}
          rows={1}
          placeholder={
            disabled
              ? "Sélectionnez un agent…"
              : "Message… (@ agent, /skill, Maj+Entrée pour newline)"
          }
          className="flex-1 bg-transparent resize-none text-sm text-white placeholder-gray-600 outline-none leading-relaxed disabled:opacity-50"
        />

        {streaming ? (
          <button
            onClick={onStop}
            className="shrink-0 w-8 h-8 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-400 flex items-center justify-center transition-colors"
            title="Arrêter"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={send}
            disabled={disabled || !text.trim()}
            className="shrink-0 w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
            title="Envoyer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
