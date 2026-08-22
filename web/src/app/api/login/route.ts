import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { COOKIE_NAME, USER_COOKIE_NAME, makeSessionToken } from "@/lib/session";

export async function POST(request: Request) {
  const { code } = await request.json();
  const expected = process.env.ACCESS_CODE;

  if (!expected || code !== expected) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 401 });
  }

  const cookieStore = await cookies();
  const existingUserId = cookieStore.get(USER_COOKIE_NAME)?.value;
  const userId = /^[0-9a-f-]{36}$/i.test(existingUserId || "") ? existingUserId! : randomUUID();

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, makeSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
  res.cookies.set(USER_COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
