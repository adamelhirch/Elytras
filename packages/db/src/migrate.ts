import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, "../migrations");

const connectionString =
  process.env.DATABASE_URL ?? "postgres://elytras:elytras@localhost:5432/elytras";

// Connexion dédiée aux migrations (max 1 connexion)
const migrationClient = postgres(connectionString, { max: 1 });
const db = drizzle(migrationClient);

console.log("Running migrations from:", migrationsFolder);
await migrate(db, { migrationsFolder });
console.log("Migrations complete.");

await migrationClient.end();
