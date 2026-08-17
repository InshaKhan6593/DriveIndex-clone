"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function LoginForm({ className, ...props }: React.ComponentProps<"div">) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Invalid access code");
        setLoading(false);
        return;
      }
      router.push(searchParams.get("from") || "/");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>
            Drive<span className="text-muted-foreground">Index</span>
          </CardTitle>
          <CardDescription>Enter your access code to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="code">Access code</FieldLabel>
                <Input
                  id="code"
                  autoFocus
                  autoComplete="off"
                  placeholder="••••-••••"
                  className="font-mono tracking-wider"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
              </Field>
              <Field>
                <Button type="submit" disabled={loading || !code}>
                  {loading ? "Checking…" : "Enter"}
                </Button>
                <FieldDescription className="text-center">
                  Don&apos;t have a code? Contact your admin.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
