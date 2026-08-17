import { NextResponse } from "next/server";
import { COOKIE_NAME, makeSessionToken } from "@/lib/session";

export async function POST(request: Request) {
  const { code } = await request.json();
  const expected = process.env.ACCESS_CODE;

  if (!expected || code !== expected) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, makeSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
