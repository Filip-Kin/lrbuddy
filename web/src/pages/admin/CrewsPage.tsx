import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select, TextArea } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { Chips } from "../../components/Segmented.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { dayDate, phoneText, plural } from "../../components/admin/format.ts";
import { CopyIcon, EditIcon, PhoneIcon, PlusIcon, UploadIcon } from "../../components/admin/icons.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { ago, dateTime, smsHref, telHref } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { useDayParam } from "./useDayParam.ts";

type Crew = RouterOutputs["admin"]["crews"]["list"][number];
type Cc = RouterOutputs["admin"]["ccs"]["list"][number];
type Company = RouterOutputs["admin"]["companies"]["list"][number];

const CSV_COLUMNS = "day, cc, company, lead_name, lead_phone, headcount";

// #region copy link
const useCopy = () => {
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (id: number, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(id);
  };
  return { copied, copy };
};
// #endregion

// #region sheets
const CrewSheet = ({
  crew,
  dayId,
  ccs,
  companies,
  open,
  onClose,
  notify,
}: {
  crew: Crew | null;
  dayId: number;
  ccs: readonly Cc[];
  companies: readonly Company[];
  open: boolean;
  onClose: () => void;
  notify: (n: NoticeValue) => void;
}) => {
  const utils = trpc.useUtils();
  const dayCcs = ccs.filter((c) => c.dayId === dayId);
  const [ccId, setCcId] = useState<number>(0);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [lead, setLead] = useState("");
  const [phone, setPhone] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [notes, setNotes] = useState("");
  const [confirm, setConfirm] = useState<"delete" | "token" | null>(null);
  useEffect(() => {
    if (!open) return;
    setCcId(crew?.ccId ?? dayCcs[0]?.id ?? 0);
    setCompanyId(crew?.companyId ?? null);
    setLead(crew?.leadName ?? "");
    setPhone(crew?.leadPhone ?? "");
    setHeadcount(crew?.headcount != null ? String(crew.headcount) : "");
    setNotes(crew?.notes ?? "");
    setConfirm(null);
    // dayCcs is derived from props on every render; the crew and open state are the inputs.
  }, [open, crew]);

  const refresh = (): void => {
    void utils.admin.crews.list.invalidate();
    void utils.admin.companies.list.invalidate();
    void utils.admin.days.invalidate();
    void utils.admin.overview.invalidate();
  };
  const create = trpc.admin.crews.create.useMutation({
    onSuccess: (c) => {
      refresh();
      notify({ tone: "ok", text: `Crew ${c.number} added` });
      onClose();
    },
  });
  const update = trpc.admin.crews.update.useMutation({
    onSuccess: (c) => {
      refresh();
      notify({ tone: "ok", text: `Crew ${c.number} saved` });
      onClose();
    },
  });
  const del = trpc.admin.crews.delete.useMutation({
    onSuccess: () => {
      refresh();
      notify({ tone: "ok", text: `${crew?.name ?? "Crew"} removed` });
      onClose();
    },
  });
  const token = trpc.admin.crews.regenerateToken.useMutation({
    onSuccess: () => {
      refresh();
      notify({ tone: "ok", text: `${crew?.name ?? "Crew"} has a new join link` });
      setConfirm(null);
    },
  });
  const head = headcount.trim() === "" ? null : Number(headcount);
  const headOk = head === null || (Number.isInteger(head) && head >= 0 && head <= 500);
  const valid = ccId > 0 && headOk;
  const submit = (): void => {
    if (!valid) return;
    const body = { ccId, companyId, leadName: lead.trim() || null, leadPhone: phone.trim() || null, headcount: head, notes: notes.trim() || null };
    if (crew) update.mutate({ id: crew.id, ...body });
    else create.mutate(body);
  };
  const err = create.error ?? update.error ?? del.error ?? token.error;

  return (
    <>
      <Sheet
        open={open && confirm === null}
        onClose={onClose}
        title={crew ? `${crew.name}${crew.companyName ? `, ${crew.companyName}` : ""}` : "New crew"}
        footer={
          <div className="flex gap-2">
            {crew && (
              <Button variant="danger" size="lg" onClick={() => setConfirm("delete")}>
                Remove
              </Button>
            )}
            <Button size="lg" className="flex-1" disabled={!valid} busy={create.isPending || update.isPending} onClick={submit}>
              {crew ? "Save" : "Add crew"}
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
          {dayCcs.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-4 py-3 font-semibold">No command centers on this day</p>
          ) : (
            <Select label="Command center" value={ccId} onChange={(e) => setCcId(Number(e.target.value))}>
              {dayCcs.map((c) => (
                <option key={c.id} value={c.id}>
                  CC {c.name}
                </option>
              ))}
            </Select>
          )}
          <Select label="Company" value={companyId ?? ""} onChange={(e) => setCompanyId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">None</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Field label="Red shirt" value={lead} onChange={(e) => setLead(e.target.value)} maxLength={80} autoComplete="off" />
          <Field label="Red shirt phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" />
          <Field
            label="Headcount"
            type="number"
            inputMode="numeric"
            min={0}
            max={500}
            value={headcount}
            onChange={(e) => setHeadcount(e.target.value)}
            error={headOk ? null : "Whole number, 0 to 500"}
          />
          <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
          {crew && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-4 py-2">
              <span className="min-w-0">
                <span className="block text-sm text-muted">Join link</span>
                <span className="block truncate font-mono text-sm">{crew.joinUrl}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={() => setConfirm("token")}>
                New link
              </Button>
            </div>
          )}
          {err && <p role="alert" className="text-sm font-semibold">{errorText(err)}</p>}
        </form>
      </Sheet>
      <ConfirmSheet
        open={open && confirm === "delete"}
        title={`Remove ${crew?.name ?? "crew"}`}
        body="Also removes its requests"
        action="Remove"
        busy={del.isPending}
        onConfirm={() => crew && del.mutate({ id: crew.id })}
        onClose={() => setConfirm(null)}
      />
      <ConfirmSheet
        open={open && confirm === "token"}
        title={`New join link for ${crew?.name ?? "crew"}`}
        body="Printed QR stops working. Reprint this crew's sheet."
        action="New link"
        busy={token.isPending}
        onConfirm={() => crew && token.mutate({ id: crew.id })}
        onClose={() => setConfirm(null)}
      />
    </>
  );
};

const importSummary = (r: { added: number; updated: number }): string =>
  r.updated > 0 ? `${plural(r.added, "crew")} added, ${r.updated} updated` : `${plural(r.added, "crew")} added`;

const ImportSheet = ({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const importCsv = trpc.admin.crews.importCsv.useMutation({
    onSuccess: (r) => {
      void utils.admin.crews.list.invalidate();
      void utils.admin.companies.list.invalidate();
      void utils.admin.days.invalidate();
      void utils.admin.overview.invalidate();
      if (r.errors.length === 0) {
        notify({ tone: "ok", text: importSummary(r) });
        setCsv("");
        setFileName(null);
        onClose();
      }
    },
  });
  useEffect(() => {
    if (open) importCsv.reset();
    // Reset once per opening; the mutation object changes identity every render.
  }, [open]);
  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;
  const result = importCsv.data;
  // The same text imported once already; a second tap would only repeat it.
  const done = importCsv.isSuccess && importCsv.variables?.csv === csv;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import crews"
      footer={
        <Button block size="lg" disabled={rows < 1 || done} busy={importCsv.isPending} onClick={() => importCsv.mutate({ csv })}>
          {done ? "Imported" : rows > 0 ? `Import ${plural(rows, "row")}` : "Import"}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-sm text-muted">Columns</div>
          <code className="block font-mono text-sm break-words">{CSV_COLUMNS}</code>
        </div>
        <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-surface font-semibold ring-2 ring-dashed ring-line ring-inset hover:bg-surface-2">
          <UploadIcon />
          {fileName ?? "Choose CSV file"}
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              void f.text().then(setCsv);
            }}
          />
        </label>
        <TextArea label="CSV" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} spellCheck={false} />
        {result && (
          <div role="status" className="space-y-2 rounded-xl bg-surface-2 px-4 py-3">
            <p className="font-semibold">
              {importSummary(result)}, {plural(result.errors.length, "row")} skipped
            </p>
            {result.errors.length > 0 && (
              <ul className="max-h-40 list-inside list-disc overflow-y-auto text-sm">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {importCsv.error && <p role="alert" className="text-sm font-semibold">{errorText(importCsv.error)}</p>}
      </div>
    </Sheet>
  );
};
// #endregion

const lastSeen = (at: number | null): string => (at === null ? "Never" : ago(at));

export const CrewsPage = () => {
  const { days, day, setDay, loading, noEvent } = useDayParam();
  const crews = trpc.admin.crews.list.useQuery({ dayId: day?.id ?? 0 }, { enabled: day !== null });
  const ccs = trpc.admin.ccs.list.useQuery(undefined, { enabled: !noEvent });
  const companies = trpc.admin.companies.list.useQuery(undefined, { enabled: !noEvent });
  const [ccFilter, setCcFilter] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Crew | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const { copied, copy } = useCopy();

  useEffect(() => setCcFilter("all"), [day?.id]);

  const dayCcs = (ccs.data ?? []).filter((c) => c.dayId === day?.id);
  const all = crews.data ?? [];
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(
      (c) =>
        (ccFilter === "all" || c.ccId === ccFilter) &&
        (!q || [c.name, c.companyName, c.leadName, c.leadPhone, c.ccName].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [all, ccFilter, search]);
  const people = shown.reduce((n, c) => n + (c.headcount ?? 0), 0);

  const actions = (
    <>
      <Button variant="secondary" onClick={() => setImporting(true)} disabled={!day}>
        <UploadIcon />
        Import CSV
      </Button>
      <Button onClick={() => setEditing("new")} disabled={!day || dayCcs.length === 0}>
        <PlusIcon />
        Add crew
      </Button>
    </>
  );

  if (loading) {
    return (
      <Page title="Crews" wide>
        <SkeletonList rows={5} className="h-14" />
      </Page>
    );
  }
  if (noEvent || !day) {
    return (
      <Page title="Crews" wide>
        <Panel>
          <EmptyState title={noEvent ? "No active event" : "No days"} />
        </Panel>
      </Page>
    );
  }

  return (
    <Page title="Crews" wide actions={actions}>
      <div className="space-y-4">
        <Chips
          label="Day"
          value={day.id}
          options={days.map((d) => ({ value: d.id, label: d.label, badge: d.crewCount }))}
          onChange={setDay}
        />
        <Notice value={notice} onClear={clear} />
        <div className="flex flex-wrap items-end gap-2">
          {dayCcs.length > 1 && (
            <Chips
              label="Command center"
              value={ccFilter}
              options={[{ value: "all" as const, label: "All CCs" }, ...dayCcs.map((c) => ({ value: c.id, label: `CC ${c.name}` }))]}
              onChange={setCcFilter}
            />
          )}
          <Field className="min-w-0 flex-1 basis-56" label="Search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        </div>
        <Panel
          flush
          title={`${day.label}, ${dayDate(day.date)}${all.length > 0 ? `: ${plural(shown.length, "crew")}${people > 0 ? `, ${plural(people, "person", "people")}` : ""}` : ""}`}
        >
          {crews.isLoading ? (
            <div className="p-4"><SkeletonList rows={5} className="h-14" /></div>
          ) : all.length === 0 ? (
            <EmptyState
              title={dayCcs.length === 0 ? "No command centers on this day" : "No crews on this day"}
              action={
                dayCcs.length === 0 ? undefined : (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setEditing("new")}>
                      <PlusIcon />
                      Add crew
                    </Button>
                    <Button variant="secondary" onClick={() => setImporting(true)}>
                      Import CSV
                    </Button>
                  </div>
                )
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState title="No matching crews" action={<Button variant="secondary" onClick={() => { setSearch(""); setCcFilter("all"); }}>Clear filters</Button>} />
          ) : (
            <>
              <ul className="divide-y divide-line nav:hidden">
                {shown.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-4 py-3">
                    <button type="button" onClick={() => setEditing(c)} className="min-h-11 min-w-0 flex-1 text-left">
                      <span className="block font-semibold">
                        {c.name}
                        {c.companyName && <span className="font-normal">, {c.companyName}</span>}
                      </span>
                      <span className="block text-sm text-muted">
                        {[`CC ${c.ccName}`, c.leadName, c.headcount != null ? plural(c.headcount, "person", "people") : null, `seen ${lastSeen(c.lastSeenAt).toLowerCase()}`].filter(Boolean).join(", ")}
                      </span>
                    </button>
                    {c.leadPhone && (
                      <a href={telHref(c.leadPhone)} aria-label={`Call ${c.leadName ?? c.name}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-2 ring-1 ring-inset ring-line">
                        <PhoneIcon />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void copy(c.id, c.joinUrl)}
                      aria-label={`Copy join link for ${c.name}`}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-2 ring-1 ring-inset ring-line"
                    >
                      {copied === c.id ? <span className="text-xs font-bold">Copied</span> : <CopyIcon />}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto nav:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-2 text-muted">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Crew</th>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">CC</th>
                      <th className="px-3 py-2 font-semibold">Red shirt</th>
                      <th className="px-3 py-2 font-semibold">Phone</th>
                      <th className="px-3 py-2 text-right font-semibold">People</th>
                      <th className="px-3 py-2 font-semibold">Last seen</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {shown.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-2/60">
                        <td className="px-4 py-2 font-semibold whitespace-nowrap">{c.name}</td>
                        <td className="px-3 py-2">{c.companyName ?? <span className="text-muted">None</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{c.ccName}</td>
                        <td className="px-3 py-2">{c.leadName ?? <span className="text-muted">None</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {c.leadPhone ? (
                            <span className="flex items-center gap-1">
                              <a className="underline decoration-line underline-offset-2" href={telHref(c.leadPhone)}>
                                {phoneText(c.leadPhone)}
                              </a>
                              <a href={smsHref(c.leadPhone)} className="rounded px-1.5 text-xs font-semibold text-muted hover:bg-surface-2">
                                Text
                              </a>
                            </span>
                          ) : (
                            <span className="text-muted">None</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.headcount ?? ""}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted" title={c.lastSeenAt ? dateTime(c.lastSeenAt) : undefined}>
                          {c.lastSeenAt ? dateTime(c.lastSeenAt) : "Never"}
                        </td>
                        <td className="px-4 py-1.5">
                          <span className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => void copy(c.id, c.joinUrl)} aria-label={`Copy join link for ${c.name}`}>
                              <CopyIcon />
                              {copied === c.id ? "Copied" : "Link"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                              <EditIcon />
                              Edit
                            </Button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </div>
      <CrewSheet
        crew={editing === "new" ? null : editing}
        dayId={day.id}
        ccs={ccs.data ?? []}
        companies={companies.data ?? []}
        open={editing !== null}
        onClose={() => setEditing(null)}
        notify={setNotice}
      />
      <ImportSheet open={importing} onClose={() => setImporting(false)} notify={setNotice} />
    </Page>
  );
};
