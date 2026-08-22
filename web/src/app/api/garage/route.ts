import { proxyToApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const search = new URL(request.url).search;
  return proxyToApi(`/api/garage${search}`, request);
}

export async function POST(request: Request) {
  return proxyToApi("/api/garage", request, await request.text());
}
