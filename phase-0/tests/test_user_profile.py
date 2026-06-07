"""Personnalisation utilisateur : profil (endpoints) + injection dans le contexte de l'agent."""
import elytras.main as M
import elytras.rbac as R


def test_profile_endpoints_roundtrip(client, admin, H):
    assert client.get("/me/profile", headers=H(admin.token)).json() == {}      # vide au départ
    r = client.patch("/me/profile", headers=H(admin.token),
                     json={"job_title": "Gérant", "department": "Direction",
                           "tone": "tutoiement", "bio": "Fondateur de Vanille Désire"})
    p = r.json()
    assert p["job_title"] == "Gérant" and p["tone"] == "tutoiement"
    assert client.get("/me/profile", headers=H(admin.token)).json()["bio"].startswith("Fondateur")


def test_profile_injected_in_agent_context(client, admin, H):
    adm, _ = R.find_by_email("admin@x.com")
    R.set_profile(adm, {"job_title": "Électricien", "tone": "vouvoiement", "preferences": "Réponses courtes"})
    instr, _t, _m = M._agent_setup({"id": "o", "name": "O", "instructions": "Tu aides."},
                                   [{"role": "user", "content": "salut"}], "user", adm, None, adm, 0)
    assert "Électricien" in instr and "Vouvoie-le" in instr and "Réponses courtes" in instr
