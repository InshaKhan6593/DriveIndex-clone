import { fetchCars } from "@/lib/api";
import { FilterBar } from "@/components/filter-bar";
import { CarCard } from "@/components/car-card";
import { SiteHeader } from "@/components/site-header";

export default async function ExplorePage({
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
          <p className="text-muted-foreground text-sm py-16 text-center">
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
          <div className="flex items-center justify-center gap-2 mt-10 text-sm">
            <PageLink page={page - 1} disabled={page <= 1} label="← Prev" searchParams={sp} />
            <span className="text-muted-foreground tabular-nums">
              Page {page} of {totalPages.toLocaleString()}
            </span>
            <PageLink page={page + 1} disabled={page >= totalPages} label="Next →" searchParams={sp} />
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
    Object.entries(searchParams).filter(([, v]) => v !== undefined) as [string, string][]
  );
  params.set("page", String(page));
  return (
    <a href={`/?${params.toString()}`} className="px-3 py-1.5 border rounded-md hover:bg-accent">
      {label}
    </a>
  );
}
