"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Définition des champs requis par type de channel
const CHANNEL_FIELDS: Record<
  string,
  { key: string; label: string; placeholder: string; sensitive?: boolean; multiline?: boolean; hint?: string }[]
> = {
  telegram: [
    {
      key: "botToken",
      label: "Bot Token",
      placeholder: "1234567890:AAF...",
      sensitive: true,
      hint: "Obtenu via @BotFather sur Telegram",
    },
  ],
  discord: [
    {
      key: "token",
      label: "Bot Token",
      placeholder: "MTIz...",
      sensitive: true,
      hint: "Obtenu depuis le Discord Developer Portal",
    },
  ],
  slack: [
    {
      key: "botToken",
      label: "Bot Token (xoxb-…)",
      placeholder: "xoxb-...",
      sensitive: true,
      hint: "OAuth token du bot Slack",
    },
    {
      key: "appToken",
      label: "App Token (xapp-…)",
      placeholder: "xapp-...",
      sensitive: true,
      hint: "Token Socket Mode — généré dans les paramètres de l'app Slack",
    },
    {
      key: "signingSecret",
      label: "Signing Secret",
      placeholder: "abc123...",
      sensitive: true,
      hint: "Clé de vérification des webhooks HTTP (si pas Socket Mode)",
    },
  ],
  signal: [
    {
      key: "account",
      label: "Numéro de téléphone",
      placeholder: "+33612345678",
      hint: "Numéro enregistré dans signal-cli",
    },
    {
      key: "httpUrl",
      label: "URL signal-cli REST",
      placeholder: "http://localhost:8080",
      hint: "URL du service signal-cli en mode daemon REST",
    },
  ],
  imessage: [
    {
      key: "dbPath",
      label: "Chemin SQLite iMessage",
      placeholder: "/Users/you/Library/Messages/chat.db",
      hint: "Chemin vers la base SQLite iMessage (macOS uniquement)",
    },
    {
      key: "cliPath",
      label: "Chemin CLI (optionnel)",
      placeholder: "/usr/local/bin/imessage-cli",
      hint: "Chemin vers l'outil CLI pour envoyer des messages",
    },
  ],
  irc: [
    {
      key: "host",
      label: "Serveur IRC",
      placeholder: "irc.libera.chat",
    },
    {
      key: "port",
      label: "Port",
      placeholder: "6697",
    },
    {
      key: "nick",
      label: "Pseudo",
      placeholder: "mybot",
    },
    {
      key: "password",
      label: "Mot de passe (SASL/NickServ)",
      placeholder: "secret",
      sensitive: true,
    },
  ],
  whatsapp: [
    {
      key: "_info",
      label: "",
      placeholder: "",
      hint: "WhatsApp nécessite un scan QR code via l'interface CLI d'OpenClaw. La configuration se fait via `openclaw gateway run` et non depuis cette interface.",
    },
  ],
  web: [
    {
      key: "webhookSecret",
      label: "Webhook Secret (optionnel)",
      placeholder: "mon-secret-webhook",
      sensitive: true,
      hint: "Secret pour valider les requêtes entrantes",
    },
  ],
  other: [
    {
      key: "config",
      label: "Configuration JSON",
      placeholder: '{"key": "value"}',
      multiline: true,
      hint: "Configuration personnalisée au format JSON",
    },
  ],
};

type Props = {
  gatewayId: string;
  channelType: string;
  hasConfig: boolean;
};

export function GatewayConfigEditor({ gatewayId, channelType, hasConfig }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const fields = CHANNEL_FIELDS[channelType] ?? CHANNEL_FIELDS.other;
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, ""])),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Si c'est juste un champ info (whatsapp)
  const isInfoOnly = fields.length === 1 && fields[0].key === "_info";

  function updateField(key: string, val: string) {
    setValues((prev) => ({ ...prev, [key]: val }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);

    const config: Record<string, string> = {};
    for (const f of fields) {
      if (f.key !== "_info" && values[f.key]?.trim()) {
        config[f.key] = values[f.key].trim();
      }
    }

    const res = await fetch(`/api/gateways/${gatewayId}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    setSaving(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Erreur lors de la sauvegarde.");
      return;
    }

    setSaved(true);
    startTransition(() => router.refresh());
  }

  if (isInfoOnly) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <p className="text-sm text-amber-300">{fields[0].hint}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasConfig && (
        <div className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-lg px-3 py-2">
          Une configuration est déjà enregistrée. Remplissez les champs ci-dessous pour la remplacer.
        </div>
      )}

      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-xs text-gray-400 mb-1.5">
            {field.label}
          </label>
          {field.hint && (
            <p className="text-xs text-gray-600 mb-1.5">{field.hint}</p>
          )}
          {field.multiline ? (
            <textarea
              value={values[field.key] ?? ""}
              onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder}
              rows={4}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono"
            />
          ) : (
            <input
              type={field.sensitive ? "password" : "text"}
              value={values[field.key] ?? ""}
              onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors font-mono"
            />
          )}
        </div>
      ))}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && <p className="text-sm text-emerald-400">Configuration sauvegardée.</p>}

      <button
        onClick={save}
        disabled={saving || isPending}
        className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {saving ? "Sauvegarde…" : "Sauvegarder la configuration"}
      </button>
    </div>
  );
}
