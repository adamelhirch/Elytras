import { GroupEditor } from "@/components/admin/group-editor";

export default function NewGroupPage() {
  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-2xl font-bold text-white mb-1">Nouveau groupe</h1>
      <p className="text-gray-400 text-sm mb-8">
        Donnez un nom au groupe. Vous pourrez ensuite y ajouter des membres, des agents et des skills.
      </p>
      <GroupEditor />
    </div>
  );
}
