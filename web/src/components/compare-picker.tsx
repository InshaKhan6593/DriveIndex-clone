"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchCars } from "@/lib/api";

type Result = { id: string; year: number; make: string; model: string; current_value: number | null; sales_count: number };

export function ComparePicker({ selected }: { selected: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchCars(q);
      if (!cancelled) setResults(r.results);
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  function setIds(ids: string[]) {
    const params = new URLSearchParams(searchParams.toString());
    if (ids.length) params.set("ids", ids.join(","));
    else params.delete("ids");
    router.push(`/compare?${params.toString()}`);
  }

  function add(id: string) {
    if (selected.includes(id) || selected.length >= 4) return;
    setIds([...selected, id]);
    setQ(""); setResults([]); setOpen(false);
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <Input
          placeholder={selected.length >= 4 ? "Maximum of 4 cars — remove one to add another" : "Search a car to add…"}
          value={q}
          disabled={selected.length >= 4}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          className="max-w-md"
        />
        {selected.length > 0 && (
          <Button variant="outline" onClick={() => setIds([])}>Clear all</Button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-w-md rounded-lg border bg-popover shadow-md overflow-hidden">
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => add(r.id)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between gap-3"
            >
              <span className="truncate">{r.year} {r.make} {r.model}</span>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {r.current_value ? `$${r.current_value.toLocaleString()}` : "—"} · {r.sales_count} sales
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RemoveButton({ id, selected }: { id: string; selected: string[] }) {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs text-muted-foreground"
      onClick={() => {
        const next = selected.filter((s) => s !== id);
        router.push(next.length ? `/compare?ids=${next.join(",")}` : "/compare");
      }}
    >
      Remove
    </Button>
  );
}
