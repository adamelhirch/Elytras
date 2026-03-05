import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://elytras:elytras@localhost:5432/elytras";

// Client de connexion postgres
const client = postgres(connectionString);

export const db = drizzle(client, { schema });

export type Db = typeof db;
