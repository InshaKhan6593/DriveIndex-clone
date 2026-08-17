"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAKES, BODY_TYPES, YEAR_BUCKETS, PRICE_BANDS, SORTS } from "@/lib/api";

export function FilterBar({ total }: { total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  const price = searchParams.get("price");
  const forSaleNow = searchParams.get("forSaleNow") === "true";

  // Base UI's Select.Value resolves its label from this map, not by reading the popup's
  // SelectItem children — the popup is portaled and unmounted until opened, so without this
  // the trigger falls back to showing the raw value ("all") instead of its label ("All makes").
  const makeItems = { all: "All makes", ...Object.fromEntries(MAKES.map((m) => [m, m])) };
  const bodyItems = { all: "All bodies", ...Object.fromEntries(BODY_TYPES.map((b) => [b, b])) };
  const yearItems = { all: "All years", ...Object.fromEntries(YEAR_BUCKETS.map((y) => [y.value, y.label])) };
  const sortItems = Object.fromEntries(SORTS.map((s) => [s.value, `Sort: ${s.label}`]));

  return (
    <div className="flex flex-col gap-3 border-b pb-5 mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select items={makeItems} value={searchParams.get("make") ?? "all"} onValueChange={(v) => setParam("make", v === "all" ? null : v)}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="All makes" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All makes</SelectItem>
            {MAKES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select items={bodyItems} value={searchParams.get("bodyType") ?? "all"} onValueChange={(v) => setParam("bodyType", v === "all" ? null : v)}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All bodies" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bodies</SelectItem>
            {BODY_TYPES.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select items={yearItems} value={searchParams.get("year") ?? "all"} onValueChange={(v) => setParam("year", v === "all" ? null : v)}>
          <SelectTrigger className="w-[130px]"><SelectValue placeholder="All years" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All years</SelectItem>
            {YEAR_BUCKETS.map((y) => <SelectItem key={y.value} value={y.value}>{y.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select items={sortItems} value={searchParams.get("sort") ?? "popular"} onValueChange={(v) => setParam("sort", v)}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => <SelectItem key={s.value} value={s.value}>Sort: {s.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Input
          placeholder="Search make or model…"
          defaultValue={searchParams.get("q") ?? ""}
          className="w-[200px] ml-auto"
          onKeyDown={(e) => {
            if (e.key === "Enter") setParam("q", (e.target as HTMLInputElement).value || null);
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Price</span>
        <Button size="sm" variant={!price ? "default" : "outline"} onClick={() => setParam("price", null)}>
          Any
        </Button>
        {PRICE_BANDS.map((p) => (
          <Button key={p.value} size="sm" variant={price === p.value ? "default" : "outline"} onClick={() => setParam("price", p.value)}>
            {p.label}
          </Button>
        ))}
        <div className="w-px h-5 bg-border mx-1" />
        <Button
          size="sm"
          variant={forSaleNow ? "default" : "outline"}
          onClick={() => setParam("forSaleNow", forSaleNow ? null : "true")}
        >
          For sale now
        </Button>

        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {total.toLocaleString()} models
        </span>
      </div>
    </div>
  );
}
