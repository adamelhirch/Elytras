import type { SessionMessage } from "../types";

type SessionExportParams = {
  sessionKey: string;
  sessionLabel: string;
  messages: SessionMessage[];
};

function sanitizeFileName(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session"
  );
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function buildAttachmentSummary(message: SessionMessage) {
  if (!message.attachments?.length) {
    return "";
  }
  const images = message.attachments.length;
  return `\n\n[attachments: ${images} image${images > 1 ? "s" : ""}]`;
}

export function exportSessionTranscriptMarkdown(params: SessionExportParams) {
  if (!params.messages.length) {
    return;
  }
  const lines = [
    `# ${params.sessionLabel}`,
    "",
    `sessionKey: ${params.sessionKey}`,
    `exportedAt: ${new Date().toISOString()}`,
    "",
  ];
  for (const message of params.messages) {
    lines.push(
      `## ${message.role}${message.timestamp ? ` · ${new Date(message.timestamp).toISOString()}` : ""}`,
      "",
      `${message.text || "(message vide)"}${buildAttachmentSummary(message)}`,
      "",
    );
  }
  downloadBlob(
    new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }),
    `${sanitizeFileName(params.sessionLabel)}-${Date.now()}.md`,
  );
}

export function exportSessionTranscriptJson(params: SessionExportParams) {
  if (!params.messages.length) {
    return;
  }
  const payload = {
    sessionKey: params.sessionKey,
    sessionLabel: params.sessionLabel,
    exportedAt: new Date().toISOString(),
    messageCount: params.messages.length,
    messages: params.messages,
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
    `${sanitizeFileName(params.sessionLabel)}-${Date.now()}.json`,
  );
}
