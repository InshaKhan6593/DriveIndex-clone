import { fetchCars } from "@/lib/api";
import { FilterBar } from "@/components/filter-bar";
import { CarCard } from "@/components/car-card";
import { SiteHeader } from "@/components/site-header";

export default async function CarsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const sp = await searchParams;
  const page = Number(sp.page) || 1;
  const data = await fetchCars({
    make: sp.make,
    bodyType: sp.bodyType,
    year: sp.year,
    price: sp.price,
    sort: sp.sort,
    forSaleNow: sp.forSaleNow,
    q: sp.q,
    page: String(page),
    limit: "24",
  });

  const totalPages = Math.ceil(data.total / data.limit);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
        <FilterBar total={data.total} />

        {data.cars.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No cars match those filters.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
            {data.cars.map((car) => (
              <CarCard key={car.id} car={car} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-10 flex items-center justify-center gap-2 text-sm">
            <PageLink page={page - 1} disabled={page <= 1} label="← Prev" searchParams={sp} />
            <span className="tabular-nums text-muted-foreground">
              Page {page} of {totalPages.toLocaleString()}
            </span>
            <PageLink
              page={page + 1}
              disabled={page >= totalPages}
              label="Next →"
              searchParams={sp}
            />
          </div>
        )}
      </main>
    </>
  );
}

function PageLink({
  page,
  disabled,
  label,
  searchParams,
}: {
  page: number;
  disabled: boolean;
  label: string;
  searchParams: { [key: string]: string | undefined };
}) {
  if (disabled) {
    return <span className="px-3 py-1.5 text-muted-foreground/40">{label}</span>;
  }

  const params = new URLSearchParams(
    Object.entries(searchParams).filter(([, value]) => value !== undefined) as [string, string][]
  );
  params.set("page", String(page));

  return (
    <a href={`/cars?${params.toString()}`} className="rounded-md border px-3 py-1.5 hover:bg-accent">
      {label}
    </a>
  );
}
