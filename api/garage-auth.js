"use strict";

const crypto = require("crypto");

// Must match web/src/lib/session.ts. Set SESSION_SECRET on both Vercel projects in production;
// ACCESS_CODE remains a safe local fallback for the current single-code login.
const SECRET = process.env.SESSION_SECRET || process.env.ACCESS_CODE || "dev-only-secret";

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function userIdFromSessionToken(token) {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!payload.startsWith("v1:")) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const userId = payload.slice(3);
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

function userIdFromRequest(req) {
  return userIdFromSessionToken(req.get("x-driveindex-session"));
}

function requireUser(req, res) {
  const userId = userIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: "garage authentication required" });
    return null;
  }
  return userId;
}

module.exports = { userIdFromSessionToken, userIdFromRequest, requireUser };
