import Link from "next/link";

const NAV = [
  { href: "/", label: "Explore" },
  { href: "/trending", label: "Trending" },
  { href: "/deals", label: "Deals" },
  { href: "/compare", label: "Compare" },
];

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:h-16 sm:px-6">
        <Link href="/" className="shrink-0 text-lg font-semibold tracking-tight">
          Drive<span className="text-muted-foreground">Index</span>
        </Link>
        <nav className="ml-auto flex min-w-0 items-center gap-4 overflow-x-auto whitespace-nowrap text-xs sm:gap-5 sm:text-sm">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-muted-foreground hover:text-foreground transition-colors">
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
