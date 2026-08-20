import { SiteHeader } from "@/components/site-header";

export default function CarsLoading() {
  return (
    <>
      <SiteHeader />
      <main
        className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-8"
        aria-busy="true"
        aria-label="Loading car listings"
      >
        <div className="mb-5 h-9 w-48 animate-pulse rounded-md bg-muted" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 15 }, (_, index) => (
            <div key={index} className="overflow-hidden rounded-xl border bg-card">
              <div className="aspect-[4/3] animate-pulse bg-muted" />
              <div className="space-y-2 p-3">
                <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-5 w-2/5 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
