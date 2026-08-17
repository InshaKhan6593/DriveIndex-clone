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
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight text-lg">
          Drive<span className="text-muted-foreground">Index</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm">
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
