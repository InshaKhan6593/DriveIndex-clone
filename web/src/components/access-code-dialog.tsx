"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AccessCodeDialog({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function openDialog() {
    setError(null);
    setOpen(true);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || "Invalid access code");
        setLoading(false);
        return;
      }

      setOpen(false);
      router.push("/cars");
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={openDialog}>
        {children}
      </button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setLoading(false);
        }}
      >
        <DialogContent className="max-w-xl border-border bg-popover text-popover-foreground shadow-2xl shadow-black/20 dark:shadow-black/50">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight text-foreground">
              Enter your access code
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Unlock Exotic Vest insights and collector-car values.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-3">
              <label htmlFor="exotic-vest-access-code" className="text-sm font-medium text-foreground/80">
                Access code
              </label>
              <Input
                id="exotic-vest-access-code"
                type="text"
                maxLength={18}
                autoFocus
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-label="Access code"
                placeholder="Enter access code"
                className="h-10 border-[#c99e5b] bg-background px-4 text-foreground placeholder:text-muted-foreground focus-visible:border-[#e1bd78] focus-visible:ring-0"
                required
              />
              {error && (
                  <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={loading || !code}
              className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {loading ? "Checking…" : "Unlock dashboard"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
