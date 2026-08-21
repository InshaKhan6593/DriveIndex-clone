"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Sale, Listing } from "@/lib/api";

// Popular cars carry hundreds of sales (measured: a Mercedes 560SL detail page rendered 321
// rows), which made the detail page absurdly long to scroll. Collapsed by default to this
// many rows — newest first is the part a reader actually wants — with a shadcn Button to
// expand stepwise.
const INITIAL_ROWS = 10;
const STEP = 25;

function useRowLimit(total: number) {
  const [limit, setLimit] = useState(INITIAL_ROWS);
  return {
    limit: Math.min(limit, total),
    hidden: Math.max(0, total - Math.min(limit, total)),
    showMore: (n: number) => setLimit((l) => Math.min(l + n, total)),
    reset: () => setLimit(INITIAL_ROWS),
  };
}

function ShowMoreControls({ hidden, onMore, onAll }: { hidden: number; onMore: () => void; onAll: () => void }) {
  return (
    <div className="flex items-center justify-center gap-2 py-3">
      <Button variant="outline" size="sm" onClick={onMore}>
        Show {Math.min(STEP, hidden)} more
      </Button>
      {hidden > STEP && (
        <Button variant="ghost" size="sm" onClick={onAll}>
          Show all {hidden}
        </Button>
      )}
    </div>
  );
}

export function SalesTable({ sales }: { sales: Sale[] }) {
  const { limit, hidden, showMore } = useRowLimit(sales.length);
  if (sales.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No verified sales on file.</p>;
  }
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Mileage</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sales.slice(0, limit).map((s, i) => {
          // A reserve-not-met row is a high bid, not a transaction — it must never read as a
          // sold price. Shown (a bid ceiling is real market information) but labelled and
          // de-emphasised, and excluded from the tab's "Sold" count.
          const notSold = s.status === "reserve_not_met";
          return (
            <TableRow key={i} className={notSold ? "text-muted-foreground" : undefined}>
              <TableCell className="tabular-nums">{new Date(s.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">{s.mileage != null ? `${s.mileage.toLocaleString()} mi` : "—"}</TableCell>
              <TableCell className="capitalize text-muted-foreground">
                {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{s.source}</a> : (s.source ?? "—")}
              </TableCell>
              <TableCell>
                {notSold ? (
                  <Badge variant="outline" className="font-normal">Reserve not met</Badge>
                ) : s.status === "sold_after" ? (
                  <Badge variant="secondary" className="font-normal">Sold after</Badge>
                ) : (
                  <span className="text-muted-foreground text-xs">Sold</span>
                )}
              </TableCell>
              <TableCell className={`text-right tabular-nums ${notSold ? "font-normal" : "font-medium"}`}>
                {s.price != null ? `${notSold ? "bid " : ""}$${s.price.toLocaleString()}` : "—"}
              </TableCell>
            </TableRow>
          );
          })}
        </TableBody>
      </Table>
      {hidden > 0 && (
        <ShowMoreControls
          hidden={hidden}
          onMore={() => showMore(STEP)}
          onAll={() => showMore(hidden)}
        />
      )}
    </div>
  );
}

export function ListingsTable({ listings }: { listings: Listing[] }) {
  const { limit, hidden, showMore } = useRowLimit(listings.length);
  if (listings.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Nothing currently for sale that we&apos;ve found.</p>;
  }
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>First seen</TableHead>
            <TableHead>Mileage</TableHead>
            <TableHead>Type / status</TableHead>
            <TableHead className="text-right">Price / bid</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {listings.slice(0, limit).map((l, i) => (
          <TableRow key={i}>
            <TableCell className="tabular-nums">{l.firstSeen ? new Date(l.firstSeen).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "—"}</TableCell>
            <TableCell className="capitalize text-muted-foreground">
              <div>{l.url ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{l.source}</a> : (l.source ?? "—")}</div>
              {l.url && <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-xs normal-case text-primary hover:underline">View listing ↗</a>}
              <div className="text-xs normal-case">{l.listingType} · {l.listingStatus.replaceAll("_", " ")}</div>
              {l.endsAt && <div className="text-xs normal-case">Ends {new Date(l.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {l.price != null ? `${l.priceType === "current_bid" ? "Bid " : l.priceType === "estimate" ? "Est. " : ""}$${l.price.toLocaleString()}` : "—"}
              {l.estimateLow != null && l.estimateHigh != null && <div className="text-xs font-normal text-muted-foreground">${l.estimateLow.toLocaleString()}–${l.estimateHigh.toLocaleString()}</div>}
            </TableCell>
          </TableRow>
          ))}
        </TableBody>
      </Table>
      {hidden > 0 && (
        <ShowMoreControls
          hidden={hidden}
          onMore={() => showMore(STEP)}
          onAll={() => showMore(hidden)}
        />
      )}
    </div>
  );
}
