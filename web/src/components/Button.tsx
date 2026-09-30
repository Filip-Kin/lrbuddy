import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "wouter";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:brightness-95 active:brightness-90",
  secondary: "bg-surface-2 text-ink ring-1 ring-inset ring-line hover:brightness-95 active:brightness-90",
  // Palette red fails contrast as a fill with text on it; the danger button carries it as a ring.
  danger: "bg-surface text-ink ring-2 ring-inset ring-crew hover:bg-surface-2",
  ghost: "bg-transparent text-ink hover:bg-surface-2",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-10 px-3 text-sm rounded-lg",
  md: "min-h-11 px-4 text-base rounded-xl",
  lg: "min-h-14 px-6 text-lg rounded-2xl",
};

export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string =>
  [
    "inline-flex items-center justify-center gap-2 font-semibold select-none transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
    "disabled:opacity-50 disabled:pointer-events-none",
    VARIANT[variant],
    SIZE[size],
    extra,
  ].join(" ");

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  busy?: boolean;
}

export const Button = ({ variant = "primary", size = "md", block, busy, className = "", type = "button", disabled, children, ...rest }: ButtonProps) => (
  <button
    type={type}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={buttonClass(variant, size, `${block ? "w-full" : ""} ${className}`)}
    {...rest}
  >
    {children}
  </button>
);

/** A link styled as a button; internal hrefs route client side. */
export const ButtonLink = ({
  href,
  variant = "primary",
  size = "md",
  block,
  className = "",
  external,
  children,
  "aria-label": ariaLabel,
}: {
  href: string;
  "aria-label"?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
  external?: boolean;
  children: ReactNode;
}) => {
  const cls = buttonClass(variant, size, `${block ? "w-full" : ""} ${className}`);
  if (external || /^(https?:|tel:|sms:|mailto:)/.test(href)) {
    return (
      <a href={href} className={cls} aria-label={ariaLabel} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} aria-label={ariaLabel}>
      {children}
    </Link>
  );
};
