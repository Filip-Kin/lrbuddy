import type { ReactNode } from "react";
import { Button } from "../Button.tsx";
import { Sheet } from "../Sheet.tsx";

/** Destructive confirmation: the title names the loss, the button names the action. */
export const Confirm = ({
  open,
  title,
  body,
  action,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  action: string;
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
          Cancel
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
