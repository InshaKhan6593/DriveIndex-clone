import { proxyToApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const q = query.get("q") || "";
  const path = `/api/search?q=${encodeURIComponent(q)}`;
  return proxyToApi(path, request);
}
