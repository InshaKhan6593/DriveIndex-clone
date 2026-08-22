"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Archive, CarFront, Plus, RefreshCw, Search, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  archiveGarageVehicle,
  createGarageVehicle,
  fetchGarage,
  refreshGarage,
  searchGarageCars,
  updateGarageVehicle,
  type GarageResponse,
  type GarageVehicle,
} from "@/lib/api";

const money = (value: number | null | undefined) => value == null ? "—" : `$${Math.round(value).toLocaleString()}`;
const pct = (value: number | null | undefined) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const signedMoney = (value: number | null | undefined) => value == null ? "—" : `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;

export default function GaragePage() {
  const [data, setData] = useState<GarageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      setData(await fetchGarage());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load your garage");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchGarage()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load your garage"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      setData(await refreshGarage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to refresh valuations");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleAdd(input: Record<string, unknown>) {
    await createGarageVehicle(input);
    await load();
  }

  async function handleArchive(id: string) {
    await archiveGarageVehicle(id);
    await load();
  }

  async function handleUpdate(id: string, input: Record<string, unknown>) {
    await updateGarageVehicle(id, input);
    await load();
  }

  const owned = data?.vehicles.filter((vehicle) => vehicle.status === "owned") ?? [];
  const sold = data?.vehicles.filter((vehicle) => vehicle.status === "sold") ?? [];

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-9">
        <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <WalletCards className="size-4" /> Personal portfolio
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">My Garage</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Track what you own against the same mileage-adjusted market values used across the index.
            </p>
          </div>
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing || loading}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh values"}
          </Button>
        </div>

        {error && <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
        {loading ? <GarageSkeleton /> : data ? (
          <>
            <Summary data={data} />
            <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-w-0 space-y-6">
                <AddVehicle onAdd={handleAdd} />
                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Owned cars</h2>
                      <p className="text-sm text-muted-foreground">{owned.length} vehicle{owned.length === 1 ? "" : "s"} tracked</p>
                    </div>
                  </div>
                  {owned.length === 0 ? (
                    <EmptyGarage />
                  ) : (
                    <div className="grid gap-4 xl:grid-cols-2">
                      {owned.map((vehicle) => (
                        <VehicleCard key={vehicle.id} vehicle={vehicle} onArchive={handleArchive} onUpdate={handleUpdate} />
                      ))}
                    </div>
                  )}
                </section>

                {sold.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-lg font-semibold">Sold history</h2>
                    <div className="grid gap-4 xl:grid-cols-2">
                      {sold.map((vehicle) => (
                        <VehicleCard key={vehicle.id} vehicle={vehicle} onArchive={handleArchive} onUpdate={handleUpdate} />
                      ))}
                    </div>
                  </section>
                )}
              </div>
              <Allocation data={data} />
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}

function Summary({ data }: { data: GarageResponse }) {
  const { summary } = data;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Garage value" value={money(summary.totalValue)} note={`${summary.pricedCount} priced of ${summary.ownedCount} owned`} />
      <Metric label="Unrealized P&L" value={signedMoney(summary.unrealizedGain)} note={pct(summary.unrealizedReturn)} tone={summary.unrealizedGain} />
      <Metric label="Today" value={signedMoney(summary.dayChange)} note={pct(summary.dayChangePct)} tone={summary.dayChange} />
      <Metric label="Cost basis" value={money(summary.totalCost)} note={summary.unpricedCount ? `${summary.unpricedCount} without a market value` : "Purchase price + fees"} />
    </div>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone?: number | null }) {
  return (
    <Card size="sm">
      <CardContent className="pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone != null && tone < 0 ? "text-destructive" : ""}`}>{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{note}</div>
      </CardContent>
    </Card>
  );
}

function Allocation({ data }: { data: GarageResponse }) {
  const max = Math.max(...data.allocation.map((item) => item.value), 1);
  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle>Portfolio mix</CardTitle>
        <CardDescription>Market value by segment.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.allocation.length === 0 ? <p className="text-sm text-muted-foreground">Add a car to see your allocation.</p> : data.allocation.map((item) => (
          <div key={item.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{money(item.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.max(4, (item.value / max) * 100)}%` }} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{item.count} car{item.count === 1 ? "" : "s"}</div>
          </div>
        ))}
        <p className="border-t pt-4 text-xs leading-5 text-muted-foreground">
          Values update from the latest market snapshot. Your mileage is applied when you provide it; otherwise the model average is used.
        </p>
      </CardContent>
    </Card>
  );
}

function AddVehicle({ onAdd }: { onAdd: (input: Record<string, unknown>) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; year: number; make: string; model: string; current_value: number | null; sales_count: number }[]>([]);
  const [selected, setSelected] = useState<{ id: string; year: number; make: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setMessage(null);
    const response = await searchGarageCars(query.trim());
    setResults(response.results);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      await onAdd({
        carId: selected.id,
        nickname: form.get("nickname") || undefined,
        purchasePrice: form.get("purchasePrice") || undefined,
        purchaseDate: form.get("purchaseDate") || undefined,
        currentMileage: form.get("currentMileage") || undefined,
        fees: form.get("fees") || undefined,
      });
      setSelected(null);
      setQuery("");
      setResults([]);
      event.currentTarget.reset();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to add vehicle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plus className="size-4" /> Add a car</CardTitle>
        <CardDescription>Choose the indexed model first, then add your purchase details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={search} className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search 2019 Porsche 911 GT3" className="pl-8" />
          </div>
          <Button type="submit" variant="outline">Search</Button>
        </form>

        {!selected && results.length > 0 && (
          <div className="divide-y rounded-lg border">
            {results.map((result) => (
              <button key={result.id} type="button" onClick={() => setSelected(result)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted">
                <span className="min-w-0 truncate">{result.year} {result.make} {result.model}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{money(result.current_value)}</span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <form onSubmit={submit} className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm font-medium">{selected.year} {selected.make} {selected.model}</div>
              <button type="button" onClick={() => setSelected(null)} className="text-xs text-muted-foreground hover:text-foreground">Change</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="nickname" label="Nickname" placeholder="Blue GT3" />
              <Field name="purchasePrice" label="Purchase price" type="number" placeholder="250000" />
              <Field name="purchaseDate" label="Purchase date" type="date" />
              <Field name="currentMileage" label="Current mileage" type="number" placeholder="32000" />
              <Field name="fees" label="Fees / improvements" type="number" placeholder="0" />
            </div>
            {message && <p className="text-sm text-destructive">{message}</p>}
            <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add to garage"}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ name, label, type = "text", placeholder, defaultValue }: { name: string; label: string; type?: string; placeholder?: string; defaultValue?: string | number }) {
  return <label className="space-y-1 text-xs text-muted-foreground"><span className="block">{label}</span><Input name={name} type={type} defaultValue={defaultValue} placeholder={placeholder} /></label>;
}

function VehicleCard({ vehicle, onArchive, onUpdate }: { vehicle: GarageVehicle; onArchive: (id: string) => Promise<void>; onUpdate: (id: string, input: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = `${vehicle.car.year} ${vehicle.car.make} ${vehicle.car.model}`;
  const positive = (vehicle.gainLoss ?? 0) >= 0;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await onUpdate(vehicle.id, {
        nickname: form.get("nickname") || null,
        purchasePrice: form.get("purchasePrice") || null,
        purchaseDate: form.get("purchaseDate") || null,
        currentMileage: form.get("currentMileage") || null,
        fees: form.get("fees") || 0,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex gap-3 border-b p-4">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
          {vehicle.car.imageUrl ? <Image src={vehicle.car.imageUrl} alt="" fill sizes="80px" className="object-cover" unoptimized /> : <div className="flex h-full items-center justify-center"><CarFront className="size-7 text-muted-foreground/50" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link href={`/cars/${vehicle.carId}`} className="block truncate text-base font-semibold hover:underline">{title}</Link>
              {vehicle.nickname && <div className="truncate text-sm text-muted-foreground">{vehicle.nickname}</div>}
            </div>
            {vehicle.status === "sold" && <Badge variant="outline">Sold</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {vehicle.valuation.signal && <Badge variant="secondary">{vehicle.valuation.signal}</Badge>}
            <span>{vehicle.currentMileage != null ? `${vehicle.currentMileage.toLocaleString()} mi` : "Mileage not set"}</span>
          </div>
        </div>
      </div>
      <CardContent className="space-y-4 pt-4">
        <div className="grid grid-cols-2 gap-4">
          <div><div className="text-xs uppercase tracking-wide text-muted-foreground">Market value</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(vehicle.marketValue)}</div></div>
          <div><div className="text-xs uppercase tracking-wide text-muted-foreground">Your P&amp;L</div><div className={`mt-1 text-xl font-semibold tabular-nums ${!positive ? "text-destructive" : ""}`}>{signedMoney(vehicle.gainLoss)}</div><div className="text-xs text-muted-foreground">{pct(vehicle.returnPct)}</div></div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            {vehicle.history.length > 1 ? <Sparkline points={vehicle.history.map((point) => point.marketValue)} /> : <div className="text-xs text-muted-foreground">Daily history will appear after the next snapshot.</div>}
          </div>
          <div className={`flex shrink-0 items-center gap-1 text-xs tabular-nums ${vehicle.dayChange != null && vehicle.dayChange < 0 ? "text-destructive" : "text-muted-foreground"}`}>
            {vehicle.dayChange != null && vehicle.dayChange >= 0 ? <TrendingUp className="size-3" /> : vehicle.dayChange != null ? <TrendingDown className="size-3" /> : null}
            {signedMoney(vehicle.dayChange)} today
          </div>
        </div>

        {editing ? (
          <form onSubmit={save} className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="nickname" label="Nickname" defaultValue={vehicle.nickname || ""} placeholder="Blue GT3" />
              <Field name="purchasePrice" label="Purchase price" type="number" defaultValue={vehicle.purchasePrice ?? ""} placeholder="250000" />
              <Field name="purchaseDate" label="Purchase date" type="date" defaultValue={vehicle.purchaseDate || ""} />
              <Field name="currentMileage" label="Current mileage" type="number" defaultValue={vehicle.currentMileage ?? ""} placeholder="32000" />
              <Field name="fees" label="Fees / improvements" type="number" defaultValue={vehicle.fees} placeholder="0" />
            </div>
            <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button><Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit details</Button>
            {vehicle.status === "owned" && <Button size="sm" variant="ghost" onClick={() => void onArchive(vehicle.id)}><Archive /> Archive</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Sparkline({ points }: { points: (number | null)[] }) {
  const values = points.filter((value): value is number => value != null);
  if (values.length < 2) return <div className="text-xs text-muted-foreground">Not enough history yet.</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const coords = values.map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / range) * 24}`).join(" ");
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-9 w-full text-foreground/60" aria-label="Garage value history"><polyline points={coords} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function EmptyGarage() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <div className="rounded-full bg-muted p-3"><CarFront className="size-6 text-muted-foreground" /></div>
        <div><div className="font-medium">Your garage is empty</div><p className="mt-1 text-sm text-muted-foreground">Search the index above to start tracking a car.</p></div>
      </CardContent>
    </Card>
  );
}

function GarageSkeleton() {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div>;
}
