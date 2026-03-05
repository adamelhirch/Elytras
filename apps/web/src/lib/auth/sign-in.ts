import { db, users } from "@elytras/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { SessionPayload } from "./session";

export async function signIn(
  email: string,
  password: string,
): Promise<SessionPayload | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user || !user.active) {return null;}

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {return null;}

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  };
}
