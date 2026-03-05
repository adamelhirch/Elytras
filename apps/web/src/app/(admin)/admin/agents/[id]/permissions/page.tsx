import { redirect } from "next/navigation";

// Les permissions agents sont gérées via les groupes
export default async function AdminAgentPermissionsPage() {
  redirect("/admin/groups");
}
