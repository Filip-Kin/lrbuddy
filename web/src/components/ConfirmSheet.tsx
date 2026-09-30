import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * Confirmation for an action that cannot be undone: the title names it, the
 * red-ringed button carries it, the other button backs out.
 */
export const ConfirmSheet = ({
  open,
  title,
  body,
  action,
  dismiss = "Cancel",
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  action: string;
  /** Label of the button that backs out; "Keep" when the action itself is a cancel. */
  dismiss?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) => (
  <Sheet
    open={open}
    onClose={onClose}
    title={title}
    footer={
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" onClick={onClose}>
          {dismiss}
        </Button>
        <Button variant="danger" size="lg" busy={busy} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    }
  >
    {body ? <div className="pb-2 text-base text-muted">{body}</div> : <div className="h-1" />}
  </Sheet>
);
