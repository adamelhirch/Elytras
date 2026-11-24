export type ChannelSetupFieldDefinition = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "path" | "number" | "checkbox" | "select" | "textarea";
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | boolean | number;
  options?: Array<{ value: string; label: string }>;
};

export type ChannelRouteKindDefinition = {
  id: string;
  label: string;
  description: string;
  example?: string;
};

export type ChannelRouteConfigDefinition = {
  enabled: boolean;
  targetLabel: string;
  summary: string;
  placeholder: string;
  hint: string;
  destinationKinds: ChannelRouteKindDefinition[];
};

export type ChannelSetupTemplateDefinition = {
  id: string;
  label: string;
  summary: string;
  docsUrl: string;
  installPath?: string;
  accountScope: "scoped" | "top-level-only" | "accounts-only";
  setupMode: "config" | "native-ui";
  loginMode: "none" | "cli-login";
  supportsLogout: boolean;
  supportsRemove: boolean;
  steps: string[];
  fields: ChannelSetupFieldDefinition[];
  routeConfig: ChannelRouteConfigDefinition;
  tags: string[];
};

function docsUrl(path: string) {
  return `https://docs.openclaw.ai${path}`;
}

function routeKind(
  id: string,
  label: string,
  description: string,
  example?: string,
): ChannelRouteKindDefinition {
  return { id, label, description, ...(example ? { example } : {}) };
}

function routeConfig(
  targetLabel: string,
  summary: string,
  placeholder: string,
  hint: string,
  destinationKinds: ChannelRouteKindDefinition[],
): ChannelRouteConfigDefinition {
  return {
    enabled: true,
    targetLabel,
    summary,
    placeholder,
    hint,
    destinationKinds,
  };
}

const DISABLED_ROUTE_CONFIG: ChannelRouteConfigDefinition = {
  enabled: false,
  targetLabel: "Destination",
  summary: "Ce channel est une surface runtime/systeme; il n’expose pas de destination operateur.",
  placeholder: "",
  hint: "Aucune route de sortie n’est attendue pour ce channel.",
  destinationKinds: [],
};

const CHANNEL_ROUTE_CONFIGS: Record<string, ChannelRouteConfigDefinition> = {
  bluebubbles: routeConfig(
    "Handle ou chat cible",
    "BlueBubbles peut router vers un handle Messages unique ou un chat/thread connu.",
    "telephone, email Apple ID ou chat guid",
    "Utilise le handle ou l’identifiant de chat que le pont BlueBubbles connait deja.",
    [
      routeKind("handle", "Handle direct", "Numero ou email Apple ID d’un contact.", "+33612345678"),
      routeKind("chat", "Chat / thread", "Identifiant d’un chat iMessage existant.", "chat-guid"),
    ],
  ),
  discord: routeConfig(
    "Salon, DM ou thread Discord",
    "Discord accepte des routes explicites vers un salon, un thread ou un utilisateur.",
    "channel:1234567890, user:1234567890 ou thread:1234567890",
    "Utilise les identifiants Discord reels si tu veux piloter finement la cible de livraison.",
    [
      routeKind("channel", "Salon serveur", "Salon texte d’un serveur Discord.", "channel:1234567890"),
      routeKind("dm", "DM utilisateur", "Message direct a un utilisateur Discord.", "user:1234567890"),
      routeKind("thread", "Thread", "Thread existant rattache a un salon Discord.", "thread:1234567890"),
    ],
  ),
  feishu: routeConfig(
    "Conversation Feishu / Lark",
    "Feishu/Lark route soit vers un utilisateur, soit vers un chat de groupe.",
    "user:open_id ou chat:chat_id",
    "Renseigne l’identifiant retourne par Feishu/Lark pour l’utilisateur ou le chat vise.",
    [
      routeKind("user", "Utilisateur", "Open ID ou user ID direct.", "user:open_id"),
      routeKind("chat", "Groupe / chat", "Chat ID d’un groupe Feishu/Lark.", "chat:chat_id"),
    ],
  ),
  googlechat: routeConfig(
    "Space, DM ou thread Google Chat",
    "Google Chat route vers un espace, une conversation directe ou un thread d’espace.",
    "spaces/AAA..., users/123456 ou spaces/AAA.../threads/BBB...",
    "Utilise les IDs Google Chat fournis par l’espace ou le webhook d’origine.",
    [
      routeKind("space", "Space", "Espace Google Chat partage.", "spaces/AAAABbbb"),
      routeKind("dm", "DM utilisateur", "Conversation directe ou user target Google Chat.", "users/123456789"),
      routeKind("thread", "Thread", "Thread existant a l’interieur d’un space.", "spaces/AAAABbbb/threads/BBBBcccc"),
    ],
  ),
  imessage: routeConfig(
    "Handle ou chat iMessage",
    "iMessage route soit vers un handle unique, soit vers un chat existant.",
    "telephone, email Apple ID ou chat guid",
    "Utilise le handle iMessage/SMS ou l’identifiant du chat cible selon ton usage.",
    [
      routeKind("handle", "Handle direct", "Numero ou email associe au contact.", "+33612345678"),
      routeKind("chat", "Chat", "Chat GUID ou identifiant de conversation existante.", "chat-guid"),
    ],
  ),
  irc: routeConfig(
    "Canal ou nick IRC",
    "IRC route naturellement soit vers un channel, soit vers un utilisateur en prive.",
    "#openclaw ou nickserv-user",
    "Utilise un nom de canal commence par # ou un nick exact pour un message prive.",
    [
      routeKind("channel", "Canal", "Channel IRC public ou prive.", "#openclaw"),
      routeKind("user", "Nick direct", "Nick cible pour un message prive.", "opsbot"),
    ],
  ),
  line: routeConfig(
    "User, group ou room LINE",
    "LINE Messaging API route vers un utilisateur, un groupe ou une room.",
    "user-id, group-id ou room-id",
    "Utilise l’identifiant LINE renvoye par l’evenement source ou le back-office LINE.",
    [
      routeKind("user", "Utilisateur", "User ID direct LINE.", "user-id"),
      routeKind("group", "Groupe", "Group ID LINE.", "group-id"),
      routeKind("room", "Room", "Room ID LINE.", "room-id"),
    ],
  ),
  matrix: routeConfig(
    "Room ou user Matrix",
    "Matrix route soit vers une room, soit vers un utilisateur si le bridge le supporte.",
    "!room:matrix.org ou @user:matrix.org",
    "Utilise les identifiants Matrix natifs pour eviter toute ambiguite de routage.",
    [
      routeKind("room", "Room", "Room ID ou alias Matrix.", "!room:matrix.org"),
      routeKind("user", "Utilisateur", "User ID Matrix direct.", "@bot:matrix.org"),
    ],
  ),
  mattermost: routeConfig(
    "Canal ou utilisateur Mattermost",
    "Mattermost peut router vers un channel ou une conversation directe.",
    "channel-id ou user-id",
    "Renseigne l’identifiant Mattermost natif de la cible de livraison.",
    [
      routeKind("channel", "Canal", "Canal public ou prive Mattermost.", "channel-id"),
      routeKind("user", "Message direct", "Utilisateur cible en DM.", "user-id"),
    ],
  ),
  msteams: routeConfig(
    "Conversation Teams",
    "Microsoft Teams route vers une conversation de chat, un canal ou un thread de meeting.",
    "conversation-id ou user:conversation-id",
    "Utilise l’identifiant de conversation fourni par Bot Framework / Teams.",
    [
      routeKind("chat", "Chat", "Conversation 1:1 ou groupe Teams.", "conversation-id"),
      routeKind("channel", "Canal", "Conversation de canal Teams.", "channel-conversation-id"),
      routeKind("meeting", "Thread de meeting", "Conversation de reunion Teams.", "meeting-thread-id"),
    ],
  ),
  "nextcloud-talk": routeConfig(
    "Conversation Nextcloud Talk",
    "Nextcloud Talk route vers une room de discussion ou un utilisateur specifique.",
    "room-token ou user-id",
    "Utilise le token de room ou l’identifiant utilisateur connu par Talk.",
    [
      routeKind("room", "Room", "Salle / conversation Nextcloud Talk.", "room-token"),
      routeKind("user", "Utilisateur", "Utilisateur Nextcloud cible.", "user-id"),
    ],
  ),
  nostr: routeConfig(
    "Profil Nostr cible",
    "Nostr est surtout oriente message direct vers une cle publique/profile.",
    "npub1... ou hex pubkey",
    "Utilise la cle publique ou l’identifiant de profil cible connu par tes relays.",
    [routeKind("profile", "Profil / pubkey", "Cle publique ou npub cible.", "npub1...")],
  ),
  signal: routeConfig(
    "Contact ou groupe Signal",
    "Signal route vers un numero E.164 ou un groupe/recipient deja connu par signal-cli.",
    "+33123456789 ou group-id",
    "Renseigne le numero ou l’identifiant de groupe resolu cote signal-cli / daemon.",
    [
      routeKind("contact", "Contact", "Numero Signal au format international.", "+33123456789"),
      routeKind("group", "Groupe", "Identifiant de groupe Signal.", "group-id"),
    ],
  ),
  slack: routeConfig(
    "Conversation Slack",
    "Slack route vers un canal, une conversation DM ou un MPIM.",
    "C1234567890, D1234567890 ou G1234567890",
    "Les IDs de conversation Slack sont plus robustes que les noms de channels.",
    [
      routeKind("channel", "Canal", "Canal public ou prive Slack.", "C1234567890"),
      routeKind("dm", "DM", "Conversation directe Slack.", "D1234567890"),
      routeKind("mpim", "Groupe prive", "Conversation multi-personnes Slack.", "G1234567890"),
    ],
  ),
  "synology-chat": routeConfig(
    "Conversation Synology Chat",
    "Synology Chat route vers un salon ou un utilisateur selon le webhook configure.",
    "room-id ou user-id",
    "Utilise l’identifiant natif expose par Synology Chat pour la cible de sortie.",
    [
      routeKind("room", "Salon", "Canal / room Synology Chat.", "room-id"),
      routeKind("user", "Utilisateur", "DM ou utilisateur cible.", "user-id"),
    ],
  ),
  telegram: routeConfig(
    "User, group, channel ou topic Telegram",
    "Telegram accepte les users, groupes, channels et topics via une cible explicite.",
    "123456789, -1001234567890 ou telegram:group:-1001234567890:topic:77",
    "Utilise le chat id ou la syntaxe cible explicite pour un groupe/topic Telegram.",
    [
      routeKind("user", "Utilisateur / DM", "Utilisateur Telegram direct.", "123456789"),
      routeKind("group", "Groupe / channel", "Groupe ou channel Telegram.", "-1001234567890"),
      routeKind("topic", "Topic", "Topic d’un supergroupe Telegram.", "telegram:group:-1001234567890:topic:77"),
    ],
  ),
  tlon: routeConfig(
    "Ship ou canal Tlon",
    "Tlon / Urbit route soit vers un ship en DM, soit vers un canal de groupe.",
    "~zod ou chat/~ship/general",
    "Utilise le ship cible ou le chemin complet du group channel Tlon.",
    [
      routeKind("dm", "Ship direct", "DM vers un ship Tlon/Urbit.", "~zod"),
      routeKind("channel", "Canal de groupe", "Chemin complet d’un group channel.", "chat/~ship/general"),
    ],
  ),
  twitch: routeConfig(
    "Canal Twitch",
    "Twitch chat route principalement vers un channel/public chat rejoint par le bot.",
    "#channel-name",
    "Utilise le channel Twitch rejoint par le bot pour l’envoi des messages.",
    [routeKind("channel", "Canal Twitch", "Chat public d’une chaine Twitch.", "#channel-name")],
  ),
  "voice-call": routeConfig(
    "Numero ou destination voix",
    "Le plugin Voice Call route vers une destination telephonique ou voix connue du provider.",
    "+15550005678",
    "Utilise un numero E.164 ou la destination attendue par ton provider telephonie.",
    [
      routeKind("phone", "Numero de telephone", "Numero E.164 cible.", "+15550005678"),
      routeKind("sip", "Destination SIP / provider", "Identifiant SIP ou destination provider.", "sip:user@example.com"),
    ],
  ),
  webchat: DISABLED_ROUTE_CONFIG,
  whatsapp: routeConfig(
    "Contact ou groupe WhatsApp",
    "WhatsApp route vers un contact direct ou un groupe en utilisant le JID attendu.",
    "+33123456789, 33612345678@s.whatsapp.net ou 123456789@g.us",
    "Utilise un numero direct ou le JID groupe si tu veux cibler explicitement la livraison.",
    [
      routeKind("contact", "Contact", "Numero ou JID direct WhatsApp.", "33612345678@s.whatsapp.net"),
      routeKind("group", "Groupe", "JID d’un groupe WhatsApp.", "123456789@g.us"),
    ],
  ),
  zalo: routeConfig(
    "Conversation Zalo",
    "Zalo route vers un utilisateur ou une conversation de groupe connue du bot.",
    "user-id ou group-id",
    "Renseigne l’identifiant natif Zalo de la conversation cible.",
    [
      routeKind("user", "Utilisateur", "Utilisateur Zalo direct.", "user-id"),
      routeKind("group", "Groupe", "Conversation de groupe Zalo.", "group-id"),
    ],
  ),
  zalouser: routeConfig(
    "Contact ou groupe Zalo Personal",
    "Zalo Personal route vers un contact ou un groupe deja resolu par le compte connecte.",
    "user-id ou group-id",
    "Utilise l’identifiant resolu cote compte personnel Zalo.",
    [
      routeKind("contact", "Contact", "Contact personnel cible.", "user-id"),
      routeKind("group", "Groupe", "Conversation de groupe Zalo.", "group-id"),
    ],
  ),
};

const CHANNEL_SETUP_TEMPLATE_BASES = [
  {
    id: "bluebubbles",
    label: "BlueBubbles",
    summary: "BlueBubbles Server sur macOS avec webhook vers OpenClaw.",
    docsUrl: docsUrl("/channels/bluebubbles"),
    installPath: "extensions/bluebubbles",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si le channel n’est pas encore charge.",
      "Renseigne l’URL du serveur BlueBubbles et le mot de passe du serveur.",
      "Optionnel: personnalise le webhook path si tu ne veux pas utiliser la route par defaut.",
      "Sauvegarde puis configure l’URL webhook dans BlueBubbles Server.",
    ],
    fields: [
      { key: "httpUrl", label: "Server URL", type: "url", required: true, placeholder: "https://bluebubbles.local:1234" },
      { key: "password", label: "Server password", type: "password", required: true },
      { key: "webhookPath", label: "Webhook path", type: "text", placeholder: "/bluebubbles/webhook" },
    ],
    tags: ["plugin", "imessage", "webhook"],
  },
  {
    id: "discord",
    label: "Discord",
    summary: "Discord Bot API + Gateway, supports servers, channels, and DMs.",
    docsUrl: docsUrl("/channels/discord"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Cree un bot dans le portail Discord Developer.",
      "Copie le bot token dans le dashboard.",
      "Sauvegarde puis invite le bot sur ton serveur Discord.",
    ],
    fields: [
      { key: "token", label: "Bot token", type: "password", required: true },
      {
        key: "dmPolicy",
        label: "DM policy",
        type: "select",
        defaultValue: "pairing",
        options: [
          { value: "pairing", label: "Pairing" },
          { value: "allowlist", label: "Allowlist" },
          { value: "open", label: "Open" },
          { value: "disabled", label: "Disabled" },
        ],
      },
      {
        key: "allowFrom",
        label: "Allowed user IDs",
        type: "textarea",
        description: "IDs Discord autorises a parler a ce bot. Separateurs acceptes: virgules ou retours ligne.",
        placeholder: "123456789012345678",
      },
    ],
    tags: ["bundled", "bot-token", "dm", "servers"],
  },
  {
    id: "feishu",
    label: "Feishu",
    summary: "Bot Feishu/Lark via WebSocket ou webhook.",
    docsUrl: docsUrl("/channels/feishu"),
    installPath: "extensions/feishu",
    accountScope: "top-level-only",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne l’App ID, l’App Secret et le domaine Feishu ou Lark.",
      "Choisis le mode WebSocket ou webhook.",
      "En mode webhook, saisis verification token, encrypt key et webhook path.",
    ],
    fields: [
      { key: "appId", label: "App ID", type: "text", required: true },
      { key: "appSecret", label: "App Secret", type: "password", required: true },
      {
        key: "domain",
        label: "Domain",
        type: "select",
        defaultValue: "feishu",
        options: [
          { value: "feishu", label: "Feishu (China)" },
          { value: "lark", label: "Lark (International)" },
        ],
      },
      {
        key: "connectionMode",
        label: "Connection mode",
        type: "select",
        defaultValue: "websocket",
        options: [
          { value: "websocket", label: "WebSocket" },
          { value: "webhook", label: "Webhook" },
        ],
      },
      { key: "verificationToken", label: "Verification token", type: "password" },
      { key: "encryptKey", label: "Encrypt key", type: "password" },
      { key: "webhookPath", label: "Webhook path", type: "text", placeholder: "/feishu/events" },
    ],
    tags: ["plugin", "websocket", "webhook"],
  },
  {
    id: "googlechat",
    label: "Google Chat",
    summary: "Google Chat app avec service account et webhook HTTP.",
    docsUrl: docsUrl("/channels/googlechat"),
    installPath: "extensions/googlechat",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Choisis JSON inline, fichier service account, ou env.",
      "Configure audience type + audience pour la verification webhook.",
      "Sauvegarde puis configure l’URL du Chat app dans Google Workspace.",
    ],
    fields: [
      { key: "token", label: "Service account JSON", type: "textarea", placeholder: "{\"type\":\"service_account\", ...}" },
      { key: "tokenFile", label: "Service account file", type: "path", placeholder: "/path/to/service-account.json" },
      { key: "useEnv", label: "Use env vars", type: "checkbox", defaultValue: false },
      {
        key: "audienceType",
        label: "Audience type",
        type: "select",
        defaultValue: "app-url",
        options: [
          { value: "app-url", label: "App URL" },
          { value: "project-number", label: "Project number" },
        ],
      },
      { key: "audience", label: "Audience", type: "text", placeholder: "https://your.host/googlechat" },
      { key: "webhookPath", label: "Webhook path", type: "text", placeholder: "/googlechat/webhook" },
      { key: "webhookUrl", label: "Webhook URL", type: "url" },
    ],
    tags: ["plugin", "service-account", "webhook"],
  },
  {
    id: "imessage",
    label: "iMessage (legacy)",
    summary: "Integration macOS legacy via imsg CLI.",
    docsUrl: docsUrl("/channels/imessage"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Renseigne le chemin du binaire imsg si necessaire.",
      "Optionnel: precise le chemin DB Messages, le service et la region.",
      "Sauvegarde puis verifie que le Mac hote a bien acces a Messages.",
    ],
    fields: [
      { key: "cliPath", label: "CLI path", type: "path", placeholder: "imsg" },
      { key: "dbPath", label: "DB path", type: "path", placeholder: "~/Library/Messages/chat.db" },
      {
        key: "service",
        label: "Service",
        type: "select",
        defaultValue: "auto",
        options: [
          { value: "auto", label: "auto" },
          { value: "imessage", label: "imessage" },
          { value: "sms", label: "sms" },
        ],
      },
      { key: "region", label: "Region", type: "text", placeholder: "US" },
      {
        key: "dmPolicy",
        label: "DM policy",
        type: "select",
        defaultValue: "pairing",
        options: [
          { value: "pairing", label: "Pairing" },
          { value: "allowlist", label: "Allowlist" },
          { value: "open", label: "Open" },
          { value: "disabled", label: "Disabled" },
        ],
      },
      {
        key: "allowFrom",
        label: "Allowed handles",
        type: "textarea",
        description: "Handles ou chat targets autorises a parler a ce bot. Separateurs acceptes: virgules ou retours ligne.",
        placeholder: "+33612345678",
      },
    ],
    tags: ["bundled", "macos", "legacy"],
  },
  {
    id: "irc",
    label: "IRC",
    summary: "IRC classique avec host, nick, TLS et channels.",
    docsUrl: docsUrl("/channels/irc"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Configure le serveur IRC, le nick, le port et le mode TLS.",
      "Optionnel: ajoute username, realname, password et channels a rejoindre.",
      "Sauvegarde puis laisse OpenClaw se connecter au serveur.",
    ],
    fields: [
      { key: "host", label: "Host", type: "text", required: true, placeholder: "irc.libera.chat" },
      { key: "port", label: "Port", type: "number", defaultValue: 6697 },
      { key: "tls", label: "TLS", type: "checkbox", defaultValue: true },
      { key: "nick", label: "Nick", type: "text", required: true, placeholder: "openclawbot" },
      { key: "username", label: "Username", type: "text" },
      { key: "realname", label: "Real name", type: "text" },
      { key: "password", label: "NickServ password", type: "password" },
      { key: "channels", label: "Channels", type: "textarea", placeholder: "#openclaw\n#ops" },
    ],
    tags: ["bundled", "server", "nickserv"],
  },
  {
    id: "line",
    label: "LINE",
    summary: "LINE Messaging API bot avec token d’acces et channel secret.",
    docsUrl: docsUrl("/channels/line"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Recupere le channel access token et le channel secret dans LINE Developers.",
      "Sauvegarde les credentials dans le dashboard.",
      "Configure ensuite le webhook URL vers ton gateway OpenClaw.",
    ],
    fields: [
      { key: "token", label: "Channel access token", type: "password", required: true },
      { key: "password", label: "Channel secret", type: "password", required: true },
    ],
    tags: ["bundled", "bot-token", "webhook"],
  },
  {
    id: "matrix",
    label: "Matrix",
    summary: "Homeserver Matrix avec user id et access token ou mot de passe.",
    docsUrl: docsUrl("/channels/matrix"),
    installPath: "extensions/matrix",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne homeserver, user id et soit access token, soit password.",
      "Optionnel: device name, initial sync limit et allow private network.",
    ],
    fields: [
      { key: "homeserver", label: "Homeserver", type: "url", required: true, placeholder: "https://matrix.org" },
      { key: "userId", label: "User ID", type: "text", required: true, placeholder: "@bot:matrix.org" },
      { key: "accessToken", label: "Access token", type: "password" },
      { key: "password", label: "Password", type: "password" },
      { key: "deviceName", label: "Device name", type: "text" },
      { key: "initialSyncLimit", label: "Initial sync limit", type: "number", defaultValue: 50 },
      { key: "allowPrivateNetwork", label: "Allow private network", type: "checkbox", defaultValue: false },
    ],
    tags: ["plugin", "homeserver", "token"],
  },
  {
    id: "mattermost",
    label: "Mattermost",
    summary: "Mattermost bot token + base URL.",
    docsUrl: docsUrl("/channels/mattermost"),
    installPath: "extensions/mattermost",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne l’URL de base Mattermost et le bot token.",
      "Sauvegarde puis laisse OpenClaw ouvrir le flux temps reel.",
    ],
    fields: [
      { key: "httpUrl", label: "Base URL", type: "url", required: true, placeholder: "https://mattermost.example.com" },
      { key: "botToken", label: "Bot token", type: "password", required: true },
    ],
    tags: ["plugin", "bot-token", "websocket"],
  },
  {
    id: "msteams",
    label: "Microsoft Teams",
    summary: "Bot Framework / Teams avec App ID, App Password et Tenant ID.",
    docsUrl: docsUrl("/channels/msteams"),
    installPath: "extensions/msteams",
    accountScope: "top-level-only",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne App ID, App Password et Tenant ID.",
      "Sauvegarde puis configure le messaging endpoint de ton bot Azure.",
    ],
    fields: [
      { key: "appId", label: "App ID", type: "text", required: true },
      { key: "appPassword", label: "App password", type: "password", required: true },
      { key: "tenantId", label: "Tenant ID", type: "text", required: true },
    ],
    tags: ["plugin", "azure", "bot-framework"],
  },
  {
    id: "nextcloud-talk",
    label: "Nextcloud Talk",
    summary: "Nextcloud Talk bot avec base URL et secret partage.",
    docsUrl: docsUrl("/channels/nextcloud-talk"),
    installPath: "extensions/nextcloud-talk",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne l’URL de base Nextcloud et le bot secret partage.",
      "Sauvegarde puis configure le bot/webhook cote Nextcloud.",
    ],
    fields: [
      { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://nextcloud.example.com" },
      { key: "secret", label: "Bot secret", type: "password", required: true },
    ],
    tags: ["plugin", "self-hosted", "webhook"],
  },
  {
    id: "nostr",
    label: "Nostr",
    summary: "DMs Nostr via cle privee et liste de relays.",
    docsUrl: docsUrl("/channels/nostr"),
    installPath: "extensions/nostr",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Colle la cle privee nsec/hex et la liste des relays.",
      "Sauvegarde puis laisse OpenClaw ouvrir les connexions aux relays.",
    ],
    fields: [
      { key: "privateKey", label: "Private key", type: "password", required: true, placeholder: "nsec..." },
      { key: "relayUrls", label: "Relay URLs", type: "textarea", placeholder: "wss://relay.damus.io\nwss://nos.lol" },
    ],
    tags: ["plugin", "relay", "dm"],
  },
  {
    id: "signal",
    label: "Signal",
    summary: "Signal via signal-cli ou daemon HTTP.",
    docsUrl: docsUrl("/channels/signal"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "cli-login",
    supportsLogout: true,
    supportsRemove: true,
    steps: [
      "Choisis une configuration signal-cli locale ou daemon HTTP.",
      "Renseigne le numero E.164 ou l’URL/host/port du daemon.",
      "Lance ensuite le login/pairing depuis le dashboard si necessaire.",
    ],
    fields: [
      { key: "signalNumber", label: "Signal number", type: "text", placeholder: "+33123456789" },
      { key: "cliPath", label: "CLI path", type: "path", placeholder: "signal-cli" },
      { key: "httpUrl", label: "HTTP URL", type: "url", placeholder: "http://127.0.0.1:8080" },
      { key: "httpHost", label: "HTTP host", type: "text", placeholder: "127.0.0.1" },
      { key: "httpPort", label: "HTTP port", type: "number", placeholder: "8080" },
    ],
    tags: ["bundled", "signal-cli", "pairing"],
  },
  {
    id: "slack",
    label: "Slack",
    summary: "Slack Socket Mode avec bot token et app token.",
    docsUrl: docsUrl("/channels/slack"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Cree une app Slack en Socket Mode.",
      "Renseigne le bot token xoxb et l’app token xapp.",
      "Sauvegarde puis installe l’app dans ton workspace.",
    ],
    fields: [
      { key: "botToken", label: "Bot token", type: "password", required: true, placeholder: "xoxb-..." },
      { key: "appToken", label: "App token", type: "password", required: true, placeholder: "xapp-..." },
    ],
    tags: ["bundled", "socket-mode", "workspace"],
  },
  {
    id: "synology-chat",
    label: "Synology Chat",
    summary: "Incoming webhook + outgoing webhook token.",
    docsUrl: docsUrl("/channels/synology-chat"),
    installPath: "extensions/synology-chat",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Recupere l’incoming webhook URL et le token de l’outgoing webhook.",
      "Renseigne aussi le webhook path si tu veux autre chose que la route par defaut.",
    ],
    fields: [
      { key: "url", label: "Incoming webhook URL", type: "url", required: true },
      { key: "token", label: "Outgoing webhook token", type: "password", required: true },
      { key: "webhookPath", label: "Outgoing webhook path", type: "text", placeholder: "/webhook/synology" },
    ],
    tags: ["plugin", "webhook", "self-hosted"],
  },
  {
    id: "telegram",
    label: "Telegram",
    summary: "Telegram Bot API via bot token ou token file.",
    docsUrl: docsUrl("/channels/telegram"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Cree un bot via @BotFather.",
      "Colle le token ou renseigne un fichier token.",
      "Sauvegarde puis commence a router des DMs ou groupes Telegram.",
    ],
    fields: [
      { key: "token", label: "Bot token", type: "password", placeholder: "123456:ABC..." },
      { key: "tokenFile", label: "Token file", type: "path" },
      { key: "useEnv", label: "Use env vars", type: "checkbox", defaultValue: false },
      {
        key: "dmPolicy",
        label: "DM policy",
        type: "select",
        defaultValue: "pairing",
        options: [
          { value: "pairing", label: "Pairing" },
          { value: "allowlist", label: "Allowlist" },
          { value: "open", label: "Open" },
          { value: "disabled", label: "Disabled" },
        ],
      },
      {
        key: "allowFrom",
        label: "Allowed Telegram user IDs",
        type: "textarea",
        description: "IDs Telegram autorises a parler a ce bot. Separateurs acceptes: virgules ou retours ligne.",
        placeholder: "5309671037",
      },
    ],
    tags: ["bundled", "bot-token", "groups"],
  },
  {
    id: "tlon",
    label: "Tlon",
    summary: "Tlon / Urbit avec ship, URL et login code.",
    docsUrl: docsUrl("/channels/tlon"),
    installPath: "extensions/tlon",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne le ship, l’URL et le code de login.",
      "Optionnel: definis les group channels, la DM allowlist et l’auto-discovery.",
    ],
    fields: [
      { key: "ship", label: "Ship", type: "text", required: true, placeholder: "~sampel-palnet" },
      { key: "url", label: "Ship URL", type: "url", required: true, placeholder: "https://your-ship-host" },
      { key: "code", label: "Login code", type: "password", required: true },
      { key: "groupChannels", label: "Group channels", type: "textarea", placeholder: "chat/~ship/general\nchat/~ship/support" },
      { key: "dmAllowlist", label: "DM allowlist", type: "textarea", placeholder: "~zod\n~nec" },
      { key: "autoDiscoverChannels", label: "Auto-discover channels", type: "checkbox", defaultValue: true },
    ],
    tags: ["plugin", "urbit", "groups"],
  },
  {
    id: "twitch",
    label: "Twitch",
    summary: "Twitch chat avec bot username, OAuth token et client ID.",
    docsUrl: docsUrl("/channels/twitch"),
    installPath: "extensions/twitch",
    accountScope: "accounts-only",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne le bot username, le token OAuth et le client ID.",
      "Optionnel: configure client secret et refresh token pour le refresh auto.",
      "Sauvegarde puis indique la channel Twitch a rejoindre.",
    ],
    fields: [
      { key: "username", label: "Bot username", type: "text", required: true },
      { key: "accessToken", label: "OAuth token", type: "password", required: true, placeholder: "oauth:..." },
      { key: "clientId", label: "Client ID", type: "text", required: true },
      { key: "channel", label: "Channel to join", type: "text", required: true },
      { key: "clientSecret", label: "Client secret", type: "password" },
      { key: "refreshToken", label: "Refresh token", type: "password" },
    ],
    tags: ["plugin", "oauth", "chat"],
  },
  {
    id: "voice-call",
    label: "Voice Call Plugin",
    summary: "Appels voix via Twilio, Telnyx, Plivo ou mock dans le gateway OpenClaw.",
    docsUrl: docsUrl("/plugins/voice-call"),
    installPath: "extensions/voice-call",
    accountScope: "top-level-only",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: false,
    steps: [
      "Installe le plugin puis redemarre le gateway OpenClaw.",
      "Choisis le provider telephonie: twilio, telnyx, plivo ou mock.",
      "Renseigne les numeros source/destination et l’exposition webhook publique.",
      "Sauvegarde la config plugin puis termine la configuration cote fournisseur telephonie.",
    ],
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        defaultValue: "mock",
        options: [
          { value: "mock", label: "mock" },
          { value: "plivo", label: "plivo" },
          { value: "telnyx", label: "telnyx" },
          { value: "twilio", label: "twilio" },
        ],
      },
      { key: "fromNumber", label: "From number", type: "text", placeholder: "+15550001234" },
      { key: "toNumber", label: "To number", type: "text", placeholder: "+15550005678" },
      {
        key: "publicUrl",
        label: "Public webhook URL",
        type: "url",
        placeholder: "https://voice.example.com/voice/webhook",
      },
      { key: "servePort", label: "Webhook port", type: "number", defaultValue: 3334 },
      { key: "servePath", label: "Webhook path", type: "text", defaultValue: "/voice/webhook" },
      { key: "twilioAccountSid", label: "Twilio account SID", type: "text" },
      { key: "twilioAuthToken", label: "Twilio auth token", type: "password" },
      { key: "telnyxApiKey", label: "Telnyx API key", type: "password" },
      { key: "telnyxConnectionId", label: "Telnyx connection ID", type: "text" },
      { key: "telnyxPublicKey", label: "Telnyx public key", type: "password" },
      { key: "plivoAuthId", label: "Plivo auth ID", type: "text" },
      { key: "plivoAuthToken", label: "Plivo auth token", type: "password" },
    ],
    tags: ["plugin", "voice", "telephony"],
  },
  {
    id: "webchat",
    label: "WebChat",
    summary: "Surface web native d’OpenClaw, exposee via le gateway Control UI.",
    docsUrl: docsUrl("/web/webchat"),
    accountScope: "top-level-only",
    setupMode: "native-ui",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: false,
    steps: [
      "Le WebChat est deja disponible via le Control UI natif OpenClaw.",
      "Utilise cette fiche pour verifier l’URL et l’etat du gateway.",
      "Aucune configuration supplementaire n’est necessaire cote dashboard.",
    ],
    fields: [],
    tags: ["native-ui", "gateway", "web"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    summary: "Baileys / WhatsApp Web avec auth dir et QR pairing.",
    docsUrl: docsUrl("/channels/whatsapp"),
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "cli-login",
    supportsLogout: true,
    supportsRemove: true,
    steps: [
      "Optionnel: definis un auth directory dedie.",
      "Sauvegarde la config puis lance le pairing QR depuis le dashboard.",
      "Scanne le QR avec le compte WhatsApp que tu veux connecter.",
    ],
    fields: [{ key: "authDir", label: "Auth dir", type: "path", placeholder: "~/.openclaw/whatsapp" }],
    tags: ["bundled", "qr", "pairing"],
  },
  {
    id: "zalo",
    label: "Zalo",
    summary: "Zalo Bot API avec token, polling ou webhook.",
    docsUrl: docsUrl("/channels/zalo"),
    installPath: "extensions/zalo",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "none",
    supportsLogout: false,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Renseigne le bot token ou active le mode env.",
      "Choisis polling ou webhook.",
      "En mode webhook, saisis URL, secret et path.",
    ],
    fields: [
      { key: "token", label: "Bot token", type: "password" },
      { key: "tokenFile", label: "Token file", type: "path" },
      { key: "useEnv", label: "Use env vars", type: "checkbox", defaultValue: false },
      {
        key: "updateMode",
        label: "Update mode",
        type: "select",
        defaultValue: "polling",
        options: [
          { value: "polling", label: "Polling" },
          { value: "webhook", label: "Webhook" },
        ],
      },
      { key: "webhookUrl", label: "Webhook URL", type: "url" },
      { key: "webhookSecret", label: "Webhook secret", type: "password" },
      { key: "webhookPath", label: "Webhook path", type: "text", placeholder: "/zalo-webhook" },
    ],
    tags: ["plugin", "bot-token", "webhook"],
  },
  {
    id: "zalouser",
    label: "Zalo Personal",
    summary: "Compte perso Zalo via login QR.",
    docsUrl: docsUrl("/channels/zalouser"),
    installPath: "extensions/zalouser",
    accountScope: "scoped",
    setupMode: "config",
    loginMode: "cli-login",
    supportsLogout: true,
    supportsRemove: true,
    steps: [
      "Installe le plugin si besoin.",
      "Cree la config de compte dans le dashboard.",
      "Lance ensuite le login QR depuis le dashboard pour connecter le compte personnel.",
    ],
    fields: [],
    tags: ["plugin", "qr", "pairing"],
  },
] satisfies Array<Omit<ChannelSetupTemplateDefinition, "routeConfig">>;

export const CHANNEL_SETUP_TEMPLATES: ChannelSetupTemplateDefinition[] = CHANNEL_SETUP_TEMPLATE_BASES
  .map((template) => ({
    ...template,
    routeConfig: CHANNEL_ROUTE_CONFIGS[template.id] || DISABLED_ROUTE_CONFIG,
  }))
  .toSorted((left, right) => left.label.localeCompare(right.label));

export function getChannelSetupTemplate(channelId: string) {
  return CHANNEL_SETUP_TEMPLATES.find((entry) => entry.id === channelId);
}
