import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { TextArea } from "../../components/Field.tsx";
import { errorText, useGreenInvalidate, useNow } from "../../components/green/hooks.ts";
import { SendIcon, useFlash } from "../../components/green/ui.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { ago, clock } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const MAX = 500;

export const BroadcastPage = () => {
  const now = useNow();
  const history = trpc.green.broadcasts.useQuery();
  const crews = trpc.green.crews.useQuery();
  const trucks = trpc.green.trucks.useQuery();
  const refresh = useGreenInvalidate();
  const send = trpc.green.broadcast.useMutation({ onSettled: refresh });
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [flash, showFlash] = useFlash();

  const crewCount = crews.data?.length ?? 0;
  const truckCount = trucks.data?.length ?? 0;
  const audience = crews.data && trucks.data ? `${crewCount === 1 ? "1 crew" : `${crewCount} crews`}, ${truckCount === 1 ? "1 truck" : `${truckCount} trucks`}` : null;
  const trimmed = body.trim();

  const submit = (): void => {
    if (!trimmed) return;
    setErr(null);
    send.mutate(
      { body: trimmed },
      {
        onSuccess: () => {
          setBody("");
          showFlash("Sent");
        },
        onError: (e) => setErr(errorText(e)),
      },
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4 nav:px-6 nav:py-6">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Broadcast</h1>
      <form
        className="space-y-3 rounded-2xl bg-surface-2 p-4 ring-1 ring-line"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextArea label="Message" value={body} onChange={(e) => setBody(e.target.value)} maxLength={MAX} rows={4} error={err} className="[&_textarea]:bg-surface" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted">
            {audience && <span className="font-semibold text-ink">{audience}</span>}
            <span className="ml-2 tabular-nums">
              {body.length}/{MAX}
            </span>
          </div>
          <Button type="submit" size="lg" busy={send.isPending} disabled={!trimmed}>
            <SendIcon />
            Send
          </Button>
        </div>
      </form>
      <div className="mt-2 flex min-h-10 justify-center">{flash}</div>

      <section aria-labelledby="history-h" className="mt-4">
        <h2 id="history-h" className="mb-3 text-lg font-bold">
          History
        </h2>
        {history.isLoading ? (
          <SkeletonList rows={2} className="h-20" />
        ) : (history.data ?? []).length === 0 ? (
          <EmptyState title="No broadcasts yet" />
        ) : (
          <ol className="space-y-3">
            {(history.data ?? []).map((b) => (
              <li key={b.id} className="rounded-2xl bg-surface p-4 ring-1 ring-line">
                <p className="text-base break-words whitespace-pre-wrap">{b.body}</p>
                <p className="mt-2 text-sm text-muted">
                  {[b.sentBy, clock(b.at), ago(b.at, now)].filter(Boolean).join(", ")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
};
