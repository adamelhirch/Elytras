import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
/**
 * Seed script — crée l'utilisateur admin initial + l'agent par défaut Elytras.
 * Usage: DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node --import tsx packages/db/src/seed.ts
 */
import { db, users, agents } from "./index.js";

const email = process.env.ADMIN_EMAIL ?? "admin@elytras.local";
const password = process.env.ADMIN_PASSWORD ?? "changeme";

// --- Admin user ---
const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (existing.length === 0) {
  const passwordHash = await bcrypt.hash(password, 12);
  await db.insert(users).values({
    email,
    passwordHash,
    role: "admin",
    displayName: "Admin",
  });
  console.log(`✓ Admin créé : ${email}`);
} else {
  console.log(`Admin déjà existant : ${email}`);
}

// --- Agent par défaut : Elytras ---
const defaultAgentName = "Elytras";
const existingAgent = await db
  .select()
  .from(agents)
  .where(eq(agents.name, defaultAgentName))
  .limit(1);

if (existingAgent.length === 0) {
  await db.insert(agents).values({
    userId: null, // agent global
    name: defaultAgentName,
    description: "Assistant généraliste — votre homme à tout faire IA",
    model: "claude-sonnet-4-5-20250929",
    systemPromptMd: `# Elytras

Tu es Elytras, un assistant IA généraliste intelligent et polyvalent.

## Ton rôle
- Répondre à toutes les questions avec précision et clarté
- Aider à la rédaction, l'analyse, la recherche, et la résolution de problèmes
- Utiliser les skills disponibles quand c'est pertinent
- Adapter ton ton au contexte (professionnel, décontracté, technique)

## Instructions
- Réponds dans la langue de l'utilisateur
- Sois concis sauf si on te demande d'être détaillé
- Si tu ne sais pas, dis-le clairement plutôt que d'inventer
`,
  });
  console.log(`✓ Agent par défaut créé : ${defaultAgentName}`);
} else {
  console.log(`Agent par défaut déjà existant : ${defaultAgentName}`);
}

process.exit(0);
