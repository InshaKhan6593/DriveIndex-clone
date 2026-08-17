import { Suspense } from "react";
import Link from "next/link";
import Image from "next/image";
import { fetchCompare, type CompareCar } from "@/lib/api";
import { SiteHeader } from "@/components/site-header";
import { SignalBadge } from "@/components/car-card";
import { ComparePicker, RemoveButton } from "@/components/compare-picker";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const money = (v: number | null) => (v == null ? "—" : `$${v.toLocaleString()}`);
const pct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

// Rows are declared once and rendered per car, so a new metric is one entry here rather than
// four parallel edits — and every column is guaranteed to show the same fields in the same order.
const ROWS: { label: string; render: (c: CompareCar) => React.ReactNode }[] = [
  { label: "Current value", render: (c) => <span className="text-base font-semibold">{money(c.current_value)}</span> },
  { label: "Signal", render: (c) => <SignalBadge signal={c.signal} /> },
  { label: "Confidence", render: (c) => (c.confidence == null ? "—" : `${Math.round(c.confidence * 100)}%`) },
  { label: "Annual return", render: (c) => pct(c.annual_return) },
  { label: "Verdict", render: (c) => c.buy_hold_sell ?? "—" },
  { label: "Forecast 1y", render: (c) => money(c.forecast_1y) },
  { label: "Forecast 3y", render: (c) => money(c.forecast_3y) },
  { label: "Forecast 5y", render: (c) => money(c.forecast_5y) },
  { label: "Collectibility", render: (c) => (c.collectibility_score == null ? "—" : `${c.collectibility_score}/10`) },
  { label: "Liquidity", render: (c) => c.liquidity_verdict ?? "—" },
  { label: "Verified sales", render: (c) => c.sales_count.toLocaleString() },
  { label: "Listed now", render: (c) => (c.listings_count > 0 ? c.listings_count : "—") },
  { label: "Avg mileage", render: (c) => (c.avg_mileage ? `${c.avg_mileage.toLocaleString()} mi` : "—") },
  { label: "Segment", render: (c) => c.segment ?? "—" },
  { label: "Cheapest months", render: (c) => (c.best_months?.length ? c.best_months.map((m) => MONTHS[m]).join(", ") : "—") },
];

async function CompareBody({ ids }: { ids: string[] }) {
  const { cars } = await fetchCompare(ids);

  if (cars.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Search above to add up to four cars and put them side by side.
        </CardContent>
      </Card>
    );
  }

  // Winners are computed per row where "better" is unambiguous. Deliberately NOT done for
  // things like collectibility or liquidity, where higher isn't straightforwardly better.
  const bestValueIdx = cars.reduce((best, c, i) =>
    (c.annual_return ?? -Infinity) > (cars[best].annual_return ?? -Infinity) ? i : best, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse min-w-[640px]">
        <thead>
          <tr>
            <th className="w-40 text-left align-bottom pb-3" />
            {cars.map((c) => (
              <th key={c.id} className="text-left align-bottom pb-3 px-3 min-w-[180px]">
                <div className="w-full aspect-[16/10] rounded-lg bg-muted relative overflow-hidden mb-2">
                  {c.image_url && <Image src={c.image_url} alt="" fill sizes="200px" className="object-cover" unoptimized />}
                </div>
                <Link href={`/cars/${c.id}`} className="text-sm font-medium leading-snug hover:underline block">
                  {c.year} {c.make} {c.model}
                </Link>
                <RemoveButton id={c.id} selected={ids} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-t">
              <td className="py-2.5 pr-3 text-xs uppercase tracking-wide text-muted-foreground align-middle">
                {row.label}
              </td>
              {cars.map((c, i) => (
                <td
                  key={c.id}
                  className={`py-2.5 px-3 text-sm tabular-nums align-middle ${
                    row.label === "Annual return" && i === bestValueIdx && cars.length > 1 ? "font-semibold" : ""
                  }`}
                >
                  {row.render(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);

  return (
    <>
      <SiteHeader />
      <main className="w-full max-w-6xl mx-auto px-6 py-8 flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compare</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Put up to four cars side by side — same fields, same order, every time.
          </p>
        </div>

        <Suspense><ComparePicker selected={ids} /></Suspense>
        <Suspense key={ids.join(",")}><CompareBody ids={ids} /></Suspense>
      </main>
    </>
  );
}
