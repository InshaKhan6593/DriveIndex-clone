// Access-code auth: one shared code, no accounts table. A successful code check sets a
// signed cookie so it can't be forged by just setting `di_session=anything` in devtools —
// signed with a server-only secret, not a JWT library, since there's exactly one claim
// ("session is valid") and no need for the complexity that comes with real tokens.
import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "di_session";
const SECRET = process.env.SESSION_SECRET || process.env.ACCESS_CODE || "dev-only-secret";

function sign(value: string) {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export function makeSessionToken() {
  const payload = "ok";
  return `${payload}.${sign(payload)}`;
}

export function isValidSessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { COOKIE_NAME };
