import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { fetchCarDetail } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { SignalBadge } from "@/components/car-card";
import { PriceHistoryChart } from "@/components/price-history-chart";
import { MileageRepricer } from "@/components/mileage-repricer";
import { SoldForSaleTabs } from "@/components/sold-forsale-tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function CarDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const car = await fetchCarDetail(id);
  if (!car) notFound();

  const title = `${car.year} ${car.make} ${car.model}`;
  const hasSpecs = car.hp != null || car.zeroSixty != null || car.msrp != null;
  // salesCount from the valuation row counts every auction appearance, reserve-not-met
  // included. The header should state completed transactions.
  const soldCount = car.sales.filter((s) => s.status !== "reserve_not_met").length;
  const hasForecast = car.projections && [car.projections.forecast1y, car.projections.forecast3y, car.projections.forecast5y].some((v) => v != null);

  return (
    <>
      <SiteHeader />
      {/* w-full is load-bearing here — without it, this <main> (a flex item under body's
          flex-col) shrink-to-fits its own content instead of stretching to max-w-6xl, so the
          page's width silently varied per car depending on how wide that car's content
          happened to be. Same bug, same fix, as the Explore grid earlier. */}
      <main className="w-full max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row gap-6 mb-6">
          <div className="sm:w-72 aspect-[16/10] shrink-0 rounded-lg overflow-hidden bg-muted relative">
            {car.imageUrl ? (
              <Image src={car.imageUrl} alt={title} fill sizes="288px" className="object-cover" unoptimized />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">No photo</div>
            )}
          </div>
          <div className="flex flex-col gap-3 flex-1">
            <div>
              <Link href="/" className="text-sm text-muted-foreground hover:underline">← Back to Explore</Link>
              <h1 className="text-2xl font-semibold tracking-tight mt-1">{title}</h1>
              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                {car.bodyType && <span>{car.bodyType}</span>}
                {car.generation && <span>· {car.generation}</span>}
                <span>· {soldCount} sale{soldCount === 1 ? "" : "s"}{car.listingsCount > 0 && ` · ${car.listingsCount} listed`}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SignalBadge signal={car.signal} />
              {car.buyHoldSell?.label && <Badge variant="secondary">{car.buyHoldSell.label}</Badge>}
            </div>
            <div className="mt-auto flex items-end justify-between border-t pt-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Current est. value</div>
                <div className="text-3xl font-semibold tabular-nums">
                  {car.currentValue ? `$${car.currentValue.toLocaleString()}` : "—"}
                </div>
                {car.annualReturn != null && (
                  <div className="text-sm text-muted-foreground tabular-nums">
                    {car.annualReturn >= 0 ? "+" : ""}{(car.annualReturn * 100).toFixed(1)}%/yr
                  </div>
                )}
              </div>
              {car.confidence != null && (
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Confidence</div>
                  <div className="text-lg font-medium tabular-nums">{Math.round(car.confidence * 100)}%</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {car.buyHoldSell?.copy && (
          <p className="text-sm text-muted-foreground border rounded-lg px-4 py-3 bg-muted/30 mb-6">{car.buyHoldSell.copy}</p>
        )}

        {car.relatedYears.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-6">
            <span className="text-xs uppercase tracking-wide text-muted-foreground self-center mr-1">Related</span>
            {car.relatedYears.map((r) => (
              <Link key={r.id} href={`/cars/${r.id}`}>
                <Badge variant="outline" className="cursor-pointer hover:bg-accent">{r.year}</Badge>
              </Link>
            ))}
          </div>
        )}

        {/* Two columns from here down: left = the long-form content you scroll through
            (chart, sales/listings, seasonality, repricer), right = the at-a-glance stats,
            sticky so they stay visible while the left column scrolls. */}
        <div className="grid lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Price History</CardTitle>
                <CardDescription>Every verified sale, plotted over time.</CardDescription>
              </CardHeader>
              <CardContent>
                <PriceHistoryChart sales={car.sales} />
              </CardContent>
            </Card>

            <Card className="py-0 overflow-hidden">
              <SoldForSaleTabs sales={car.sales} listings={car.listings} />
            </Card>

            {(car.bestMonths?.length || car.worstMonths?.length) ? (
              <Card>
                <CardHeader>
                  <CardTitle>Best Time to Buy &amp; Sell</CardTitle>
                  <CardDescription>Seasonal pattern from this car&apos;s own sales history.</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-8">
                  {!!car.bestMonths?.length && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Cheapest to buy</div>
                      <div className="text-sm font-medium">{car.bestMonths.map((m) => MONTHS[m]).join(", ")}</div>
                    </div>
                  )}
                  {!!car.worstMonths?.length && (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Priciest to sell</div>
                      <div className="text-sm font-medium">{car.worstMonths.map((m) => MONTHS[m]).join(", ")}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : null}

            {car.currentValue != null && (
              <Card>
                <CardHeader>
                  <CardTitle>What&apos;s it worth at your miles?</CardTitle>
                  <CardDescription>Re-prices the current value using the same mileage curve the engine applies.</CardDescription>
                </CardHeader>
                <CardContent>
                  <MileageRepricer carId={car.id} defaultValue={50000} />
                </CardContent>
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-6 lg:sticky lg:top-6">
            {hasForecast && (
              <Card>
                <CardHeader>
                  <CardTitle>Forecast</CardTitle>
                  <CardDescription>Projected from the current trend — a guide, not a guarantee.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  {[
                    { label: "1 year", value: car.projections!.forecast1y, bear: null, bull: null },
                    { label: "3 years", value: car.projections!.forecast3y, bear: car.projections!.bear3y, bull: car.projections!.bull3y },
                    { label: "5 years", value: car.projections!.forecast5y, bear: car.projections!.bear5y, bull: car.projections!.bull5y },
                  ].filter((f) => f.value != null).map((f) => (
                    <div key={f.label}>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</div>
                      <div className="text-lg font-semibold tabular-nums">${f.value!.toLocaleString()}</div>
                      {f.bear != null && f.bull != null && (
                        <div className="text-xs text-muted-foreground tabular-nums">${f.bear.toLocaleString()} – ${f.bull.toLocaleString()}</div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Collectibility &amp; Liquidity</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {car.collectibility?.score != null && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Collectibility score</div>
                    <div className="text-lg font-semibold">{car.collectibility.score}/10</div>
                    {car.collectibility.reasons.length > 0 && (
                      <ul className="text-xs text-muted-foreground list-disc list-inside mt-1">
                        {car.collectibility.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Liquidity</div>
                  <div className="text-sm font-medium">{car.liquidity.verdict ?? "—"}</div>
                  {car.liquidity.copy && <p className="text-xs text-muted-foreground mt-0.5">{car.liquidity.copy}</p>}
                </div>
              </CardContent>
            </Card>

            {hasSpecs && (
              <Card>
                <CardHeader><CardTitle>Specifications</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  {car.hp != null && <Spec label="Horsepower" value={`${car.hp} hp`} />}
                  {car.zeroSixty != null && <Spec label="0–60 mph" value={`${car.zeroSixty}s`} />}
                  {car.msrp != null && <Spec label="MSRP (new)" value={`$${car.msrp.toLocaleString()}`} />}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
