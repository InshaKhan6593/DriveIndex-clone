import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import type { CarSummary } from "@/lib/api";

const SIGNAL_LABEL: Record<string, string> = {
  appreciating: "Appreciating",
  stable: "Stable",
  bottomed: "Bottomed",
  approaching: "Approaching",
  depreciating: "Depreciating",
  insufficient: "Insufficient data",
};

// Mapped onto shadcn's own badge variants rather than custom colors — their default palette
// is neutral + one semantic color (destructive/red), so that's reserved for the one state
// that's actually a warning sign (depreciating). Appreciating gets the solid/primary
// treatment as the "notable" positive state; everything transitional or neutral stays
// low-contrast (secondary/outline) so the real signal doesn't get lost in colored noise.
const SIGNAL_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  appreciating: "default",
  bottomed: "secondary",
  stable: "outline",
  approaching: "secondary",
  depreciating: "destructive",
  insufficient: "outline",
};

export function SignalBadge({ signal }: { signal: string | null }) {
  if (!signal) return null;
  return (
    <Badge variant={SIGNAL_VARIANT[signal] ?? "outline"}>
      {SIGNAL_LABEL[signal] ?? signal}
    </Badge>
  );
}

export function CarCard({ car }: { car: CarSummary }) {
  return (
    <Link href={`/cars/${car.id}`} className="group block text-foreground hover:text-foreground">
      <div className="overflow-hidden rounded-lg border bg-card text-card-foreground transition-shadow hover:text-card-foreground hover:shadow-md">
        <div className="aspect-[16/10] bg-muted relative overflow-hidden">
          {car.imageUrl ? (
            <Image
              src={car.imageUrl}
              alt={`${car.year} ${car.make} ${car.model}`}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
              className="object-cover transition-transform group-hover:scale-[1.03]"
              unoptimized
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
              No photo
            </div>
          )}
        </div>

        <div className="p-2.5 flex flex-col gap-1">
          {/* min-h reserves 2 lines regardless of actual length, so a short title ("911 GT3")
              and a long one ("Aventador SVJ Roadster") produce the same card height. */}
          <div className="min-h-[2.5rem] line-clamp-2 text-sm font-medium leading-snug text-card-foreground">
            {car.year} {car.make} {car.model}
          </div>
          <div className="text-[11px] text-muted-foreground tabular-nums">
            {car.salesCount} sale{car.salesCount === 1 ? "" : "s"}
            {car.listingsCount > 0 && ` · ${car.listingsCount} listed`}
          </div>

          {/* min-h-5 matches Badge's own height, so a card with no signal/listing badge
              doesn't collapse shorter than one that has them. */}
          <div className="flex items-center justify-between min-h-5">
            <div className="flex items-center gap-1">
              <SignalBadge signal={car.signal} />
              {car.listingsCount > 0 && <Badge variant="secondary">For sale</Badge>}
            </div>
          </div>

          <div className="flex items-end justify-between">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Est. value</span>
            <span className="text-sm font-semibold tabular-nums text-card-foreground">
              {car.currentValue ? `$${car.currentValue.toLocaleString()}` : "—"}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
