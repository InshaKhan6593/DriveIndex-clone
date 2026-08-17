"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SalesTable, ListingsTable } from "@/components/sales-table";
import type { Sale, Listing } from "@/lib/api";

// Renders only the active table directly, rather than relying on Base UI's Tabs.Panel
// mount/unmount lifecycle — that left both panels visible simultaneously in testing (Sold
// and For Sale content stacked on top of each other). TabsList/TabsTrigger still drive the
// visible tab UI; the content switch itself is a plain conditional on our own state.
export function SoldForSaleTabs({ sales, listings }: { sales: Sale[]; listings: Listing[] }) {
  const [active, setActive] = useState<"sold" | "forsale">("sold");
  // Count actual transactions only — a reserve-not-met row is still listed in the table (with
  // its bid, clearly labelled) but it is not a sale and must not inflate this number.
  const soldCount = sales.filter((s) => s.status !== "reserve_not_met").length;

  return (
    <div>
      <Tabs value={active} onValueChange={(v) => setActive(v as "sold" | "forsale")}>
        <TabsList variant="line" className="w-full justify-start border-b h-auto px-4 pt-1">
          <TabsTrigger value="sold" className="px-2 py-3">Sold ({soldCount})</TabsTrigger>
          <TabsTrigger value="forsale" className="px-2 py-3">For Sale ({listings.length})</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="px-4 pb-4 pt-4">
        {active === "sold" ? <SalesTable sales={sales} /> : <ListingsTable listings={listings} />}
      </div>
    </div>
  );
}
