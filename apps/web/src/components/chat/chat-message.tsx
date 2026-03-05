"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "./chat-interface";

type Props = {
  message: Message;
};

function isBlankContent(value: string): boolean {
  return value.replace(/[\s\u200B-\u200D\uFEFF]/g, "").length === 0;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  const renderMarkdown = !isUser && !isError;
  const isEmptyAssistantBubble =
    !isUser && !isError && !message.streaming && isBlankContent(message.content);

  if (isEmptyAssistantBubble) {
    return null;
  }

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatar */}
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs text-gray-300 font-semibold">
            U
          </div>
        ) : (
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${
              isError ? "bg-red-500/20 text-red-400" : "bg-indigo-500/20 text-indigo-300"
            }`}
          >
            {message.agentName
              ? message.agentName
                  .split(" ")
                  .map((w: string) => w[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()
              : "✦"}
          </div>
        )}
      </div>

      {/* Bubble */}
      <div className={`max-w-[75%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {/* Agent name */}
        {!isUser && message.agentName && (
          <span className="text-xs text-gray-500 px-1">{message.agentName}</span>
        )}

        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1">
            {message.attachments.map((att, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                  att.type === "file"
                    ? "bg-white/10 text-gray-300"
                    : "bg-violet-500/20 text-violet-300"
                }`}
              >
                {att.type === "file" ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                {att.name}
              </span>
            ))}
          </div>
        )}

        {/* Content */}
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed break-words ${
            isUser
              ? "bg-indigo-600 text-white rounded-tr-sm"
              : isError
                ? "bg-red-500/10 border border-red-500/30 text-red-400 rounded-tl-sm"
                : "bg-white/5 text-gray-100 rounded-tl-sm"
          }`}
        >
          {message.content ? (
            renderMarkdown ? (
              <div
                className={[
                  "[&_p]:my-0 [&_p+p]:mt-2",
                  "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1",
                  "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1",
                  "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1",
                  "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2",
                  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2",
                  "[&_li]:my-0.5",
                  "[&_a]:underline [&_a]:underline-offset-2 [&_a]:text-indigo-300",
                  "[&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:italic",
                  "[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded",
                  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3",
                  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                ].join(" ")}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
            ) : (
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            )
          ) : (
            message.streaming ? null : "\u00a0"
          )}
          {message.streaming && (
            <span className="inline-flex gap-0.5 ml-1 align-middle">
              <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:0ms]" />
              <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:150ms]" />
              <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce [animation-delay:300ms]" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
