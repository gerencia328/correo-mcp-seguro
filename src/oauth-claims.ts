/** Validate the ID-token audience/issuer as well as its signature (checked by caller). */
export function validateAccessClaims(claims: Record<string, unknown>, clientId: string, tokenUrl: string, now = Math.floor(Date.now() / 1000)) {
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const issuer = new URL(tokenUrl).origin;
  if (!audience.includes(clientId) || claims.iss !== issuer ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 30)) ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.email !== "string" || !claims.email.includes("@")) {
    throw new Error("Invalid Access ID token claims");
  }
  return { sub: claims.sub, email: claims.email, name: typeof claims.name === "string" ? claims.name : claims.email };
}
