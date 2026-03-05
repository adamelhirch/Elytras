import { SkillEditor } from "@/components/admin/skill-editor";

export default function NewSkillPage() {
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-1">Nouveau skill</h1>
      <p className="text-gray-400 text-sm mb-8">
        Définissez un skill avec son contenu SKILL.md. Il sera disponible pour les agents et les
        utilisateurs selon les permissions.
      </p>
      <SkillEditor />
    </div>
  );
}
