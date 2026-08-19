import Link from "next/link";
import Image from "next/image";
import { fetchDeals } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const { total, rejectedAsUnverifiable, deals } = await fetchDeals();

  return (
    <>
      <SiteHeader />
      <main className="w-full max-w-6xl mx-auto px-6 py-8 flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deal Radar</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Live asking prices below what the car&apos;s own verified sales say it&apos;s worth.
          </p>
        </div>

        <div className="flex flex-wrap gap-6 border rounded-lg px-5 py-4 bg-muted/30">
          <div>
            <div className="text-2xl font-semibold tabular-nums">{total}</div>
            <div className="text-xs text-muted-foreground">verified deals</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-muted-foreground">{rejectedAsUnverifiable}</div>
            <div className="text-xs text-muted-foreground">rejected as unverifiable</div>
          </div>
          <p className="text-xs text-muted-foreground max-w-md self-center">
            An ask below everything the model has ever actually sold for is almost always a
            project car or a different spec, not a discount. Those are excluded rather than
            listed as bargains.
          </p>
        </div>

        {deals.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
            No verified deals right now.
          </CardContent></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Priced under market</CardTitle>
              <CardDescription>Sorted by discount against our computed value.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 flex flex-col">
              {deals.map((d) => (
                <div key={d.listing_id} className="flex items-center gap-4 py-3 border-b last:border-b-0">
                  <div className="w-20 h-14 rounded bg-muted relative overflow-hidden shrink-0">
                    {d.image_url && <Image src={d.image_url} alt="" fill sizes="80px" className="object-cover" unoptimized />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <Link href={`/cars/${d.car_id}`} className="text-sm font-medium hover:underline">
                      {d.year} {d.make} {d.model}
                    </Link>
                    <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      {d.mileage != null ? `${d.mileage.toLocaleString()} mi · ` : ""}
                      {d.sales_count} verified sales
                      {d.confidence != null && ` · ${Math.round(d.confidence * 100)}% confidence`}
                    </div>
                    <div className="mt-1">
                      <Badge variant="outline" className="capitalize font-normal text-[10px]">{d.source}</Badge>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-base font-semibold tabular-nums">${d.price.toLocaleString()}</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums line-through">
                      ${d.current_value.toLocaleString()}
                    </div>
                  </div>

                  <div className="w-20 text-right shrink-0">
                    <Badge className="tabular-nums">−{(d.discount * 100).toFixed(0)}%</Badge>
                  </div>

                  {d.url && (
                    <Button nativeButton={false} variant="outline" size="sm" render={<a href={d.url} target="_blank" rel="noopener noreferrer" />}>
                      View
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
