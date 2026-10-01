import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorMessage, reloadOnceForChunk, reportError } from "../lib/clientErrors.ts";
import { Button } from "./Button.tsx";

interface Props {
  children: ReactNode;
  /** Panel title. */
  label?: string;
  /** Inside a map or a strip: fills its box instead of the screen. */
  inset?: boolean;
  /** A change (the route) clears the error and renders the children again. */
  resetKey?: string;
}

interface State {
  error: unknown;
  key: string | undefined;
}

const back = (): void => {
  if (window.history.length > 1) window.history.back();
  else window.location.assign("/");
};

/** What a crashed screen shows instead of nothing: the error, Reload and Back. */
export const ErrorPanel = ({ label, message, inset }: { label: string; message: string; inset?: boolean }) => (
  <div className={`grid place-items-center p-4 text-ink ${inset ? "absolute inset-0 z-[1100] bg-surface" : "min-h-full bg-surface py-10"}`} role="alert" data-error-panel>
    <div className="w-full max-w-md rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <h2 className="text-lg font-bold">{label}</h2>
      <p className="mt-2 max-h-32 overflow-y-auto font-mono text-sm break-words text-muted" data-error-message>
        {message}
      </p>
      <div className="mt-4 flex gap-2">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <Button variant="secondary" onClick={back}>
          Back
        </Button>
      </div>
    </div>
  </div>
);

/** Catches a render crash below it, reports it to `/client-error` and shows the error panel. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("Unknown error") };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null } : null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (reloadOnceForChunk(error)) return;
    reportError(error, info.componentStack ?? null);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <ErrorPanel label={this.props.label ?? "Screen failed"} message={errorMessage(this.state.error)} inset={this.props.inset} />;
  }
}
