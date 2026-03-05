import { ChatInterface } from "@/components/chat/chat-interface";
import { listAgentsForUser, listSkillsForUser } from "@elytras/db";
import { getSession } from "@/lib/auth/session";

export default async function ChatPage() {
  const session = await getSession();
  const agentList = await listAgentsForUser(session!.userId);
  const skillList = await listSkillsForUser(session!.userId);

  return (
    <ChatInterface
      agents={agentList.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? undefined,
        model: a.model ?? undefined,
        avatarUrl: a.avatarUrl ?? undefined,
      }))}
      skills={skillList.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? undefined,
        content: s.skillMdContent,
      }))}
    />
  );
}
