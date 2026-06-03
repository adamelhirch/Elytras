"""RBAC : rôles configurables, capacités, équipes, mots de passe, SSO."""
import elytras.rbac as R


def test_default_roles_present():
    roles = {r["id"] for r in R.list_roles()}
    assert {"admin", "operateur", "lecteur"} <= roles
    assert R.role_caps("admin") == set(R.CAPS)              # admin = toutes les capacités


def test_password_hash_and_verify():
    h, salt, it = R.hash_pw("s3cret")
    assert R.verify_pw("s3cret", h, salt, it)
    assert not R.verify_pw("mauvais", h, salt, it)


def test_custom_role_and_caps(state):
    rid = R.create_role("Comm", ["flow.view", "flow.run", "agent.use"])
    tid = R.create_team("Communication", rid)
    R.create_account("Carla", "carla@x.com", "pw", [tid])
    uid, _ = R.find_by_email("carla@x.com")
    caps = R.caps_for(uid)
    assert "flow.run" in caps and "agent.use" in caps
    assert "flow.create" not in caps and "code.execute" not in caps and "admin" not in caps
    assert not R.is_admin(uid)


def test_admin_role_protected(state):
    assert R.update_role("admin", caps=["flow.view"]) is False   # non modifiable
    assert R.role_caps("admin") == set(R.CAPS)


def test_builtin_role_editable_then_used(state):
    assert R.update_role("operateur", caps=["flow.view", "agent.use"])
    assert "flow.create" not in R.role_caps("operateur")


def test_delete_role_refused_if_used(state):
    rid = R.create_role("Temp", ["flow.view"])
    tid = R.create_team("T", rid)
    assert R.delete_role(rid) is False                      # utilisé par une équipe
    R.delete_team(tid)
    assert R.delete_role(rid) is True


def test_login_token_roundtrip(state):
    tid = R.create_team("Ops", "operateur")
    R.create_account("Bob", "bob@x.com", "pw-bob", [tid])
    assert R.login("bob@x.com", "FAUX") is None
    tok = R.login("bob@x.com", "pw-bob")
    uid, _ = R.find_by_email("bob@x.com")
    assert R.resolve_token(tok) == uid
    R.revoke_token(tok)
    assert R.resolve_token(tok) is None


def test_sso_resolve_and_provisioning(state):
    tid = R.create_team("Comm", "lecteur")
    R.create_account_sso("Ann", "ann@x.com", [tid])
    assert R.sso_resolve("ann@x.com", "Ann")                # rattachement par email
    assert R.sso_resolve("inconnu@x.com", "X") is None      # pas de provisioning par défaut
    R.set_sso({"auto_provision": True, "default_team": tid})
    new = R.sso_resolve("bob@x.com", "Bob")
    assert new and tid in (R.get_account(new) or {}).get("team_ids", [])


def test_setup_needed_transitions(state):
    assert R.setup_needed() is True
    R.setup_first_admin("Léo", "leo@x.com", "pw")
    assert R.setup_needed() is False
