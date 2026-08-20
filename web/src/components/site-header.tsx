import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  { href: "/cars", label: "Explore" },
  { href: "/trending", label: "Trending" },
  { href: "/deals", label: "Deals" },
  { href: "/compare", label: "Compare" },
];

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:h-16 sm:px-6">
        <Link href="/" className="shrink-0 text-lg font-semibold tracking-tight">
          Exotic <span className="text-[#c99e5b]">Vest</span>
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <nav className="no-scrollbar flex min-w-0 items-center gap-4 overflow-x-auto whitespace-nowrap text-xs sm:gap-5 sm:text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline">
                {n.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
