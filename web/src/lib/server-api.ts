import { cookies } from "next/headers";
import { COOKIE_NAME } from "@/lib/session";

const API_URL = process.env.API_URL || "http://localhost:3002";

export async function proxyToApi(path: string, request: Request, body?: string) {
  const cookieStore = await cookies();
  const session = cookieStore.get(COOKIE_NAME)?.value;
  if (!session) return Response.json({ error: "authentication required" }, { status: 401 });

  const headers = new Headers();
  headers.set("x-driveindex-session", session);
  if (body != null) headers.set("content-type", "application/json");

  const response = await fetch(`${API_URL}${path}`, {
    method: request.method,
    headers,
    body: body ?? undefined,
    cache: "no-store",
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json" },
  });
}
