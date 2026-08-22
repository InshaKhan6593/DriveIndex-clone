import { proxyToApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToApi(`/api/garage/${encodeURIComponent(id)}`, request, await request.text());
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToApi(`/api/garage/${encodeURIComponent(id)}`, request);
}
