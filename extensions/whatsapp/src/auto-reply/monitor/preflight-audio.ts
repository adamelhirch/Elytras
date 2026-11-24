import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WebInboundMsg } from "../types.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;

function hasTypedText(body?: string): boolean {
  const trimmed = body?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  return !AUDIO_PLACEHOLDER_RE.test(trimmed);
}

export async function resolveWhatsAppPreflightAudioMentionContext(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const hasAudioAttachment = Boolean(params.msg.mediaType?.startsWith("audio/"));
  const hasTypedTextValue = hasTypedText(params.msg.body);
  const needsPreflightTranscription =
    params.shouldRequireMention &&
    hasAudioAttachment &&
    !hasTypedTextValue &&
    params.mentionRegexes.length > 0;

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("./preflight-audio.runtime.js");
      transcript = await transcribeFirstAudio({
        ctx: {
          MediaPath: params.msg.mediaPath,
          MediaUrl: params.msg.mediaUrl,
          MediaType: params.msg.mediaType,
        },
        cfg: params.cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`whatsapp: audio preflight transcription failed: ${String(err)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText: hasTypedTextValue,
    transcript,
  };
}
