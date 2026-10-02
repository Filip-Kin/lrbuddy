import { useEffect, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { phoneText } from "../../components/admin/format.ts";
import { errorText } from "../../lib/errors.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Person = RouterOutputs["people"]["list"]["people"][number];

const nameOf = (p: Person): string => p.name ?? (p.phone ? phoneText(p.phone) : (p.email ?? "No name"));

/**
 * `/admin/people` (SPEC 26): every user who has signed in, searchable by name,
 * phone or email, with Make admin and Remove admin. The last admin shows no
 * Remove admin.
 */
export const PeoplePage = () => {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = trpc.people.list.useQuery({ q }, { placeholderData: (prev) => prev });
  const [pick, setPick] = useState<{ person: Person; to: "make" | "remove" } | null>(null);
  const done = {
    onSuccess: () => {
      setPick(null);
      void utils.people.list.invalidate();
      void utils.access.adminPending.invalidate();
    },
  };
  const make = trpc.people.makeAdmin.useMutation(done);
  const remove = trpc.people.removeAdmin.useMutation(done);
  const failed = make.error ?? remove.error;

  return (
    <Page title="People">
      <div className="space-y-4">
        <Field label="Search" type="search" name="people-search" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" maxLength={60} />
        {failed && (
          <p role="alert" className="rounded-xl bg-crew/15 px-4 py-3 text-sm font-semibold">
            {errorText(failed, "Not saved, try again")}
          </p>
        )}
        <Panel title="People" flush>
          {list.isLoading ? (
            <div className="m-4 h-32 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
          ) : list.isError || !list.data ? (
            <EmptyState title="People not loaded" action={<Button onClick={() => void list.refetch()}>Retry</Button>} />
          ) : list.data.people.length === 0 ? (
            <p className="px-4 py-6 text-center text-base text-muted">{q ? "No matches" : "No people"}</p>
          ) : (
            <ul className="divide-y divide-line" data-people-list>
              {list.data.people.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3" data-person>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{nameOf(p)}</span>
                      {p.admin && <StatusPill status="admin" />}
                    </div>
                    <div className="truncate text-sm text-muted">{[p.phone ? phoneText(p.phone) : null, p.email].filter(Boolean).join(", ") || "No phone"}</div>
                  </div>
                  {p.admin ? (
                    list.data.admins > 1 && (
                      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setPick({ person: p, to: "remove" })}>
                        Remove admin
                      </Button>
                    )
                  ) : (
                    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setPick({ person: p, to: "make" })}>
                      Make admin
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <ConfirmSheet
        open={pick !== null}
        title={pick?.to === "remove" ? "Remove admin" : "Make admin"}
        body={pick ? nameOf(pick.person) : undefined}
        action={pick?.to === "remove" ? "Remove admin" : "Make admin"}
        busy={make.isPending || remove.isPending}
        onConfirm={() => {
          if (!pick) return;
          if (pick.to === "remove") remove.mutate({ userId: pick.person.id });
          else make.mutate({ userId: pick.person.id });
        }}
        onClose={() => setPick(null)}
      />
    </Page>
  );
};
