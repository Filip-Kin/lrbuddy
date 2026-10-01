import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConfirmationResult } from "firebase/auth";
import { useSearch } from "wouter";
import { Button } from "../../components/Button.tsx";
import { Field } from "../../components/Field.tsx";
import { firebaseOptions, googleEnabled } from "../../lib/firebaseConfig.ts";
import { login, signInWithIdToken } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

// #region helpers
/** E.164 from what was typed: `+` and digits as given, 10 digits as a US number. Null when it cannot be one. */
export const toE164 = (v: string): string | null => {
  const digits = v.replace(/\D/g, "");
  if (v.trim().startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
};

const FIREBASE_ERRORS: Record<string, string> = {
  "auth/invalid-phone-number": "Check the mobile number",
  "auth/missing-phone-number": "Enter a mobile number",
  "auth/too-many-requests": "Too many tries, wait a few minutes",
  "auth/quota-exceeded": "Text messages are paused, try again later",
  "auth/invalid-verification-code": "Wrong code",
  "auth/code-expired": "Code expired, send a new one",
  "auth/network-request-failed": "No connection",
  "auth/popup-blocked": "Pop-up blocked, allow pop-ups and retry",
  "auth/captcha-check-failed": "Check failed, try again",
};

const firebaseError = (code: string | null): string => (code ? FIREBASE_ERRORS[code] : undefined) ?? "Sign-in failed, try again";

/** Portal paths an admin sign-in returns to (`/login?next=/plan/...`). */
const portalNext = (search: URLSearchParams): string | null => {
  const next = search.get("next") ?? (window.location.pathname.startsWith("/plan") ? window.location.pathname : null);
  return next && /^\/plan(\/[a-z/]*)?$/.test(next) ? next : null;
};
// #endregion

const Brand = () => (
  <h1 className="flex items-center justify-center gap-2 text-2xl font-extrabold tracking-tight">
    <span aria-hidden="true" className="h-4 w-4 rounded-sm bg-brand" />
    LR Buddy
  </h1>
);

/**
 * SPEC 18 sign-in: Name and Mobile number, Continue sends a text with a
 * six-digit code; Google below a divider; "Staff password" reveals the old
 * password and code login. A Firebase user already signed in on this phone
 * goes straight through. Without Firebase (no config here or on the server)
 * only the staff password shows.
 */
export const LoginPage = () => {
  const search = new URLSearchParams(useSearch());
  const authConfig = trpc.shared.authConfig.useQuery(undefined, { staleTime: Infinity });
  const link = trpc.access.link.useQuery(undefined, { staleTime: Infinity });
  const firebaseOn = firebaseOptions !== null && authConfig.data?.firebase === true;
  const decided = authConfig.data !== undefined || authConfig.isError;

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<ConfirmationResult | null>(null);
  const [error, setError] = useState<string | null>(search.get("link") === "unknown" ? "Unknown QR code" : null);
  const [busy, setBusy] = useState<"send" | "confirm" | "google" | "password" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [staffError, setStaffError] = useState<string | null>(null);
  const recaptchaRef = useRef<HTMLDivElement>(null);

  const finish = async (idToken: string, typedName?: string): Promise<void> => {
    const res = await signInWithIdToken(idToken, typedName).catch(() => ({ ok: false as const, status: 0, error: "No connection" }));
    if (res.ok) {
      window.location.assign("/");
      return;
    }
    setBusy(null);
    setError(res.status === 429 ? "Too many tries" : res.status === 0 ? "No connection" : "Sign-in failed, try again");
  };

  // A Firebase sign-in kept on this phone: no form, straight to the role.
  useEffect(() => {
    if (!firebaseOn) return;
    let live = true;
    setRestoring(true);
    void (async () => {
      const fb = await import("../../lib/firebase.ts");
      const token = await fb.currentIdToken().catch(() => null);
      if (!live) return;
      if (!token) {
        setRestoring(false);
        return;
      }
      const res = await signInWithIdToken(token).catch(() => null);
      if (res?.ok) {
        window.location.assign("/");
        return;
      }
      await fb.firebaseSignOut();
      if (live) setRestoring(false);
    })();
    return () => {
      live = false;
    };
  }, [firebaseOn]);

  useEffect(() => {
    if (sent) document.querySelector<HTMLInputElement>("input[name=otp]")?.focus();
  }, [sent]);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sent) {
      await confirm();
      return;
    }
    if (!name.trim()) {
      setError("Enter a name");
      return;
    }
    const e164 = toE164(phone);
    if (!e164) {
      setError("Enter a mobile number with area code");
      return;
    }
    if (!recaptchaRef.current) return;
    setBusy("send");
    setError(null);
    try {
      const fb = await import("../../lib/firebase.ts");
      setSent(await fb.sendCode(e164, recaptchaRef.current));
    } catch (err) {
      const { errorCode } = await import("../../lib/firebase.ts");
      setError(firebaseError(errorCode(err)));
    }
    setBusy(null);
  };

  const confirm = async (): Promise<void> => {
    if (!sent) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the six-digit code");
      return;
    }
    setBusy("confirm");
    setError(null);
    try {
      const fb = await import("../../lib/firebase.ts");
      await finish(await fb.confirmCode(sent, code.trim()), name);
    } catch (err) {
      const { errorCode } = await import("../../lib/firebase.ts");
      setError(firebaseError(errorCode(err)));
      setBusy(null);
    }
  };

  const google = async (): Promise<void> => {
    setBusy("google");
    setError(null);
    try {
      const fb = await import("../../lib/firebase.ts");
      await finish(await fb.googleSignIn(), name || undefined);
    } catch (err) {
      const { errorCode } = await import("../../lib/firebase.ts");
      const c = errorCode(err);
      setError(c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request" ? null : firebaseError(c));
      setBusy(null);
    }
  };

  const staff = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password.trim()) {
      setStaffError("Enter the password");
      return;
    }
    setBusy("password");
    setStaffError(null);
    const res = await login(password).catch(() => ({ ok: false as const, error: "No connection" }));
    if (res.ok) {
      window.location.assign(res.role === "admin" ? (portalNext(search) ?? "/admin") : "/");
      return;
    }
    setBusy(null);
    setStaffError(res.error === "Unknown code" ? "Wrong password" : res.error);
  };

  const showStaff = staffOpen || (decided && !firebaseOn);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface-2 px-4 py-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-5 rounded-3xl bg-surface p-6 shadow-xl ring-1 ring-line">
        <Brand />
        {link.data && (
          <p className="flex justify-center">
            <span className="max-w-full truncate rounded-full px-3 py-1 text-sm font-semibold ring-2 ring-crew ring-inset">{link.data.label}</span>
          </p>
        )}

        {restoring ? (
          <p role="status" aria-live="polite" className="py-6 text-center text-base font-semibold text-muted">
            Signing in…
          </p>
        ) : (
          firebaseOn && (
            <>
              <form onSubmit={(e) => void send(e)} noValidate className="space-y-4" data-phone-signin>
                <Field
                  label="Name"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  maxLength={60}
                  disabled={sent !== null}
                />
                <Field
                  label="Mobile number"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={24}
                  disabled={sent !== null}
                />
                <div hidden={sent === null}>
                  <Field
                    label="Code from text"
                    name="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="[&_input]:text-center [&_input]:text-xl [&_input]:tracking-[0.4em]"
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm font-semibold text-ink before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
                    {error}
                  </p>
                )}
                {sent === null ? (
                  <Button type="submit" size="lg" block busy={busy === "send"} disabled={busy !== null && busy !== "send"}>
                    Continue
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Button type="submit" size="lg" block busy={busy === "confirm"}>
                      Sign in
                    </Button>
                    <Button
                      variant="ghost"
                      block
                      onClick={() => {
                        setSent(null);
                        setCode("");
                        setError(null);
                      }}
                    >
                      Change number
                    </Button>
                  </div>
                )}
                <div ref={recaptchaRef} />
              </form>

              {googleEnabled && (
                <>
                  <div className="flex items-center gap-3 text-sm font-semibold text-muted" aria-hidden="true">
                    <span className="h-px flex-1 bg-line" />
                    or
                    <span className="h-px flex-1 bg-line" />
                  </div>

                  <Button variant="secondary" size="lg" block busy={busy === "google"} disabled={busy !== null && busy !== "google"} onClick={() => void google()}>
                    <GoogleMark />
                    Google
                  </Button>
                </>
              )}
            </>
          )
        )}

        {!restoring && (
          <div className={firebaseOn ? "border-t border-line pt-3" : ""}>
            {showStaff ? (
              <form onSubmit={(e) => void staff(e)} noValidate className="space-y-3">
                <Field
                  label="Staff password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus={staffOpen}
                  error={staffError ?? (firebaseOn ? null : error)}
                />
                <Button type="submit" variant={firebaseOn ? "secondary" : "primary"} size="lg" block busy={busy === "password"}>
                  Sign in
                </Button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setStaffOpen(true)}
                className="mx-auto flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold text-muted underline underline-offset-4 hover:text-ink"
              >
                Staff password
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
