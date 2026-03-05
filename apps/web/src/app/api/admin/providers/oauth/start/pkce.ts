import { randomBytes, createHash } from "node:crypto";

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
