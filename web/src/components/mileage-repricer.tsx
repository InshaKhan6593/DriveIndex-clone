"use client";

import { useEffect, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchReprice } from "@/lib/api";

export function MileageRepricer({ carId, defaultValue }: { carId: string; defaultValue: number | null }) {
  const [miles, setMiles] = useState(defaultValue ?? 50000);
  const [value, setValue] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function reprice(next: number) {
    setMiles(next);
    startTransition(async () => {
      setValue(await fetchReprice(carId, next));
    });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reprice(miles), []);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="miles" className="text-xs text-muted-foreground">Enter mileage to re-price</Label>
      <div className="flex items-center gap-3">
        <Input
          id="miles"
          type="number"
          min={0}
          step={1000}
          value={miles}
          onChange={(e) => reprice(Number(e.target.value) || 0)}
          className="w-32"
        />
        <span className="text-sm text-muted-foreground">miles</span>
        <span className="ml-auto text-lg font-semibold tabular-nums">
          {pending ? "…" : value != null ? `$${value.toLocaleString()}` : "—"}
        </span>
      </div>
    </div>
  );
}
