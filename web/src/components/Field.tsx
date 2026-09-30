import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/** 16 px text or more, or iOS zooms the page on focus. */
const CONTROL =
  "block w-full min-h-11 rounded-xl border-0 bg-surface-2 px-3 py-2.5 text-base text-ink ring-1 ring-inset ring-line placeholder:text-muted focus:ring-2 focus:ring-ink focus:outline-none";

interface Wrap {
  label: string;
  /** One short line under the label, only for what the label cannot carry. */
  hint?: string;
  error?: string | null;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

const FieldWrap = ({ label, hint, error, className = "", children }: Wrap) => {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {children(id, describedBy)}
      {error && (
        <p id={errId} role="alert" className="text-sm font-semibold text-ink before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
          {error}
        </p>
      )}
    </div>
  );
};

type Common = { label: string; hint?: string; error?: string | null; className?: string };

export const Field = ({ label, hint, error, className, ...input }: Common & InputHTMLAttributes<HTMLInputElement>) => (
  <FieldWrap label={label} hint={hint} error={error} className={className}>
    {(id, d) => <input id={id} aria-describedby={d} aria-invalid={error ? true : undefined} className={CONTROL} {...input} />}
  </FieldWrap>
);

export const TextArea = ({ label, hint, error, className, ...input }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <FieldWrap label={label} hint={hint} error={error} className={className}>
    {(id, d) => <textarea id={id} aria-describedby={d} aria-invalid={error ? true : undefined} rows={3} className={CONTROL} {...input} />}
  </FieldWrap>
);

export const Select = ({ label, hint, error, className, children, ...input }: Common & SelectHTMLAttributes<HTMLSelectElement>) => (
  <FieldWrap label={label} hint={hint} error={error} className={className}>
    {(id, d) => (
      <select id={id} aria-describedby={d} className={CONTROL} {...input}>
        {children}
      </select>
    )}
  </FieldWrap>
);
