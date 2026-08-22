import { proxyToApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return proxyToApi("/api/garage/refresh", request, "{}");
}
