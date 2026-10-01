import { useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { Button } from "../../components/Button.tsx";
import { Field } from "../../components/Field.tsx";
import { login } from "../../lib/session.ts";

/** One code: admin password, truck code or CC code. */
export const LoginPage = () => {
  const search = new URLSearchParams(useSearch());
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(search.get("link") === "unknown" ? "Unknown crew link" : null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!code.trim()) {
      setError("Enter a code");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await login(code).catch(() => ({ ok: false as const, error: "No connection" }));
    if (res.ok) {
      const next = search.get("next") ?? (window.location.pathname.startsWith("/plan") ? window.location.pathname : null);
      const back = next && /^\/plan(\/[a-z/]*)?$/.test(next) ? next : null;
      window.location.assign(res.role === "admin" ? (back ?? "/admin") : "/");
      return;
    }
    setBusy(false);
    setError(res.error);
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface-2 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <form onSubmit={submit} noValidate className="w-full max-w-sm space-y-5 rounded-3xl bg-surface p-6 shadow-xl ring-1 ring-line">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-extrabold tracking-tight">
          <span aria-hidden="true" className="h-4 w-4 rounded-sm bg-brand" />
          LR Buddy
        </h1>
        <Field
          label="Code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          error={error}
          className="[&_input]:text-center [&_input]:text-xl [&_input]:tracking-widest"
        />
        <Button type="submit" size="lg" block busy={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
};
