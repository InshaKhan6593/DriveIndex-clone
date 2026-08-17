import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { Sale, Listing } from "@/lib/api";

export function SalesTable({ sales }: { sales: Sale[] }) {
  if (sales.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No verified sales on file.</p>;
  }
  return (
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
        {sales.map((s, i) => {
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
  );
}

export function ListingsTable({ listings }: { listings: Listing[] }) {
  if (listings.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Nothing currently for sale that we've found.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>First seen</TableHead>
          <TableHead>Mileage</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Asking price</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {listings.map((l, i) => (
          <TableRow key={i}>
            <TableCell className="tabular-nums">{l.firstSeen ? new Date(l.firstSeen).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{l.mileage != null ? `${l.mileage.toLocaleString()} mi` : "—"}</TableCell>
            <TableCell className="capitalize text-muted-foreground">
              {l.url ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{l.source}</a> : (l.source ?? "—")}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">{l.price != null ? `$${l.price.toLocaleString()}` : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
