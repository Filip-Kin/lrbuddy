import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { plural } from "../../components/admin/format.ts";
import { EditIcon, PlusIcon } from "../../components/admin/icons.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Company = RouterOutputs["admin"]["companies"]["list"][number];

/** The short crew names fall back to: the first word of the name (SPEC 19). */
const firstWord = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const RenameSheet = ({ company, onClose, notify }: { company: Company | null; onClose: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (company) {
      setName(company.name);
      setShort(company.short ?? "");
    }
    setConfirmDelete(false);
  }, [company]);
  const rename = trpc.admin.companies.update.useMutation({
    onSuccess: (c) => {
      void utils.admin.companies.list.invalidate();
      void utils.admin.crews.list.invalidate();
      void utils.plan.invalidate();
      notify({ tone: "ok", text: `${c.name} saved` });
      onClose();
    },
  });
  const del = trpc.admin.companies.delete.useMutation({
    onSuccess: () => {
      void utils.admin.companies.list.invalidate();
      void utils.admin.crews.list.invalidate();
      notify({ tone: "ok", text: `${company?.name ?? "Company"} removed` });
      onClose();
    },
  });
  const changed = !!company && (name.trim() !== company.name || short.trim() !== (company.short ?? ""));
  const submit = (): void => {
    if (company && name.trim() && changed) rename.mutate({ id: company.id, name: name.trim(), short: short.trim() || null });
  };
  return (
    <>
      <Sheet
        open={company !== null && !confirmDelete}
        onClose={onClose}
        title={company?.name ?? "Company"}
        footer={
          <div className="flex gap-2">
            <Button variant="danger" size="lg" onClick={() => setConfirmDelete(true)}>
              Remove
            </Button>
            <Button size="lg" className="flex-1" busy={rename.isPending} disabled={!name.trim() || !changed} onClick={submit}>
              Save
            </Button>
          </div>
        }
      >
        <form
          className="space-y-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" />
          <Field
            label="Short name"
            hint={`Crew names, ${short.trim() || firstWord(name) || "GM"} 1`}
            value={short}
            onChange={(e) => setShort(e.target.value)}
            placeholder={firstWord(name)}
            maxLength={16}
            autoComplete="off"
          />
          {rename.error && <p role="alert" className="text-sm font-semibold">{errorText(rename.error)}</p>}
        </form>
      </Sheet>
      <ConfirmSheet
        open={company !== null && confirmDelete}
        title={`Remove ${company?.name ?? "company"}`}
        body={company && company.crewCount > 0 ? `${plural(company.crewCount, "crew")} left with no company` : undefined}
        action="Remove"
        busy={del.isPending}
        onConfirm={() => company && del.mutate({ id: company.id })}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
};

export const CompaniesPage = () => {
  const list = trpc.admin.companies.list.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Company | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const create = trpc.admin.companies.create.useMutation({
    onSuccess: (c) => {
      void utils.admin.companies.list.invalidate();
      setName("");
      setNotice({ tone: "ok", text: `${c.name} added` });
    },
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });
  const rows = list.data ?? [];
  const noEvent = list.error?.data?.code === "PRECONDITION_FAILED";
  const submit = (): void => {
    if (name.trim()) create.mutate({ name: name.trim() });
  };

  return (
    <Page title="Companies">
      <div className="space-y-4">
        {!noEvent && (
          <Panel>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Field className="min-w-0 flex-1" label="New company" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" />
              <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
                <PlusIcon />
                Add
              </Button>
            </form>
          </Panel>
        )}
        <Notice value={notice} onClear={clear} />
        <Panel flush title={rows.length > 0 ? plural(rows.length, "company", "companies") : undefined}>
          {list.isLoading ? (
            <div className="p-4"><SkeletonList rows={4} className="h-14" /></div>
          ) : noEvent ? (
            <EmptyState title="No active event" />
          ) : rows.length === 0 ? (
            <EmptyState title="No companies yet" />
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setEditing(c)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-semibold">{c.name}</span>
                        {c.short && <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-bold ring-1 ring-line">{c.short}</span>}
                      </span>
                      <span className="block text-sm text-muted">
                        {c.crewCount === 0 ? "No crews" : `${plural(c.crewCount, "crew")}${c.headcount > 0 ? `, ${plural(c.headcount, "person", "people")}` : ""}`}
                      </span>
                    </span>
                    <span className="text-muted">
                      <EditIcon />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <RenameSheet company={editing} onClose={() => setEditing(null)} notify={setNotice} />
    </Page>
  );
};
