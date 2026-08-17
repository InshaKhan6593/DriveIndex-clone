import Link from "next/link";
import Image from "next/image";
import { fetchTrending, type TrendingCar } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const SIGNAL_LABEL: Record<string, string> = {
  appreciating: "Appreciating", stable: "Stable", bottomed: "Bottomed",
  approaching: "Approaching", depreciating: "Depreciating", insufficient: "Insufficient data",
};

function pct(v: number | null) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function CarRow({ car, rank }: { car: TrendingCar; rank: number }) {
  return (
    <Link href={`/cars/${car.id}`} className="flex items-center gap-3 py-2.5 border-b last:border-b-0 hover:bg-accent/40 -mx-2 px-2 rounded">
      <span className="w-5 text-xs text-muted-foreground tabular-nums shrink-0">{rank}</span>
      <div className="w-14 h-10 rounded bg-muted relative overflow-hidden shrink-0">
        {car.image_url && (
          <Image src={car.image_url} alt="" fill sizes="56px" className="object-cover" unoptimized />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{car.year} {car.make} {car.model}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {car.sales_count} sales · {car.current_value ? `$${car.current_value.toLocaleString()}` : "—"}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold tabular-nums">{pct(car.trend_score)}</div>
        <div className="text-[10px] text-muted-foreground tabular-nums">raw {pct(car.annual_return)}</div>
      </div>
    </Link>
  );
}

export default async function TrendingPage() {
  const data = await fetchTrending();
  const healthTotal = Object.entries(data.health)
    .filter(([k]) => k !== "insufficient")
    .reduce((a, [, v]) => a + v, 0);

  return (
    <>
      <SiteHeader />
      <main className="w-full max-w-6xl mx-auto px-6 py-8 flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            What&apos;s climbing and what&apos;s falling, ranked by an evidence-weighted trend rather
            than the raw rate — so a wild number from three sales can&apos;t top the board.
          </p>
        </div>

        {/* Market health */}
        <Card>
          <CardHeader>
            <CardTitle>Market health</CardTitle>
            <CardDescription>
              {healthTotal.toLocaleString()} cars with a directional call.
              {data.health.insufficient ? ` ${data.health.insufficient.toLocaleString()} more don't yet have enough verified sales to call.` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-6">
            {["appreciating", "stable", "bottomed", "approaching", "depreciating"].map((k) =>
              data.health[k] ? (
                <div key={k}>
                  <div className="text-2xl font-semibold tabular-nums">{data.health[k].toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">{SIGNAL_LABEL[k]}</div>
                </div>
              ) : null
            )}
          </CardContent>
        </Card>

        {/* Leaderboards */}
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <Card>
            <CardHeader>
              <CardTitle>Top appreciating</CardTitle>
              <CardDescription>Ranked by evidence-weighted trend; raw rate shown beneath.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {data.gainers.map((c, i) => <CarRow key={c.id} car={c} rank={i + 1} />)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Biggest declines</CardTitle>
              <CardDescription>Steepest falls — and future buy opportunities once they bottom.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {data.decliners.map((c, i) => <CarRow key={c.id} car={c} rank={i + 1} />)}
            </CardContent>
          </Card>
        </div>

        {/* Segment indexes */}
        <Card>
          <CardHeader>
            <CardTitle>Market indexes</CardTitle>
            <CardDescription>Average trend by segment — a basket, so no single sale moves it.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {data.segments.map((s) => (
              <div key={s.segment} className="border rounded-lg p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.segment}</div>
                <div className={`text-xl font-semibold tabular-nums ${s.avgReturn >= 0 ? "" : "text-muted-foreground"}`}>
                  {pct(s.avgReturn)}
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {s.count.toLocaleString()} cars · avg ${s.avgValue.toLocaleString()}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Bottomed */}
        {data.bottomed.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Bottomed</CardTitle>
              <CardDescription>Long-term decline, but recent sales have turned — historically where value appears.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 grid sm:grid-cols-2 gap-x-8">
              {data.bottomed.map((c, i) => <CarRow key={c.id} car={c} rank={i + 1} />)}
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          <Badge variant="outline" className="mr-2">method</Badge>
          Ranked by the conservative end of each car&apos;s trend interval, shrunk toward the market
          average in proportion to how much evidence supports it. A car rises as its sales
          accumulate rather than by clearing a fixed cutoff.
        </p>
      </main>
    </>
  );
}
