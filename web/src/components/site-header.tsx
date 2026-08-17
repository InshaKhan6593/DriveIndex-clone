import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight text-lg">
          Drive<span className="text-muted-foreground">Index</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <Link href="/" className="text-foreground">Explore</Link>
        </nav>
      </div>
    </header>
  );
}
