import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select, TextArea } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { Chips } from "../../components/Segmented.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { dayDate, phoneText, plural } from "../../components/admin/format.ts";
import { EditIcon, PhoneIcon, PinIcon, PlusIcon } from "../../components/admin/icons.tsx";
import { MapMode } from "../../components/admin/MapMode.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { ago, telHref } from "../../lib/format.ts";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { useOnewayLayer } from "../../lib/map/onewayLayer.ts";
import { AlleyLayer } from "../../components/alleys/AlleyLayer.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type DayData = RouterOutputs["admin"]["days"]["get"];
type Cc = DayData["ccs"][number];
type Truck = Cc["trucks"][number];
type Shirt = Cc["greenShirts"][number];

type MapModeState = { kind: "idle" } | { kind: "new" } | { kind: "move"; ccId: number; name: string };

// #region sheets
const CodeBlock = ({ label, code, onRegenerate, busy }: { label: string; code: string | null; onRegenerate: () => void; busy?: boolean }) => (
  <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-2">
    <div className="min-w-0">
      <div className="text-sm text-muted">{label}</div>
      <div className="font-mono text-2xl font-bold tracking-[0.2em]">{code ?? "None"}</div>
    </div>
    <Button variant="secondary" size="sm" busy={busy} onClick={onRegenerate}>
      New code
    </Button>
  </div>
);

const DaySheet = ({ day, open, onClose }: { day: DayData["day"]; open: boolean; onClose: () => void }) => {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState(day.label);
  const [date, setDate] = useState(day.date);
  useEffect(() => {
    if (open) {
      setLabel(day.label);
      setDate(day.date);
    }
  }, [open, day]);
  const save = trpc.admin.days.update.useMutation({
    onSuccess: () => {
      void utils.admin.invalidate();
      onClose();
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Edit ${day.label}`}
      footer={
        <Button block size="lg" busy={save.isPending} disabled={!label.trim() || !date} onClick={() => save.mutate({ id: day.id, label: label.trim(), date })}>
          Save
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
        <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {save.error && <p role="alert" className="text-sm font-semibold">{errorText(save.error)}</p>}
      </div>
    </Sheet>
  );
};

/** New CC at a tapped point, or edit an existing one. */
const CcSheet = ({
  dayId,
  cc,
  at,
  open,
  onClose,
  onSaved,
}: {
  dayId: number;
  cc: Cc | null;
  at: { lat: number; lng: number } | null;
  open: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [letter, setLetter] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lookup = trpc.admin.ccs.addressAt.useQuery(at ?? { lat: 0, lng: 0 }, { enabled: open && !cc && at !== null, staleTime: Infinity, retry: false });

  useEffect(() => {
    if (!open) return;
    setName(cc?.name ?? "");
    setAddress(cc?.address ?? "");
    setLetter(cc?.letter ?? "");
    setNotes(cc?.notes ?? "");
  }, [open, cc]);
  useEffect(() => {
    if (!cc && lookup.data?.address) setAddress((a) => a || lookup.data?.address || "");
  }, [lookup.data, cc]);

  const done = (text: string): void => {
    void utils.admin.days.get.invalidate();
    void utils.admin.ccs.list.invalidate();
    void utils.admin.overview.invalidate();
    onSaved(text);
    onClose();
  };
  const create = trpc.admin.ccs.create.useMutation({ onSuccess: (c) => done(`CC ${c.name} added`) });
  const update = trpc.admin.ccs.update.useMutation({ onSuccess: (c) => done(`CC ${c.name} saved`) });
  const del = trpc.admin.ccs.delete.useMutation({
    onSuccess: () => {
      setConfirmDelete(false);
      done(`CC ${cc?.name ?? ""} removed`);
    },
  });
  const busy = create.isPending || update.isPending;
  const err = create.error ?? update.error ?? del.error;

  const submit = (): void => {
    if (!name.trim()) return;
    const l = letter.trim().toUpperCase() || null;
    if (cc) update.mutate({ id: cc.id, name: name.trim(), address: address.trim() || null, letter: l, notes: notes.trim() || null });
    else if (at) create.mutate({ dayId, name: name.trim(), lat: at.lat, lng: at.lng, address: address.trim() || null, letter: l, notes: notes.trim() || null });
  };

  return (
    <>
      <Sheet
        open={open && !confirmDelete}
        onClose={onClose}
        title={cc ? `CC ${cc.name}` : "New command center"}
        footer={
          <div className="flex gap-2">
            {cc && (
              <Button variant="danger" size="lg" onClick={() => setConfirmDelete(true)}>
                Remove
              </Button>
            )}
            <Button size="lg" className="flex-1" busy={busy} disabled={!name.trim()} onClick={submit}>
              {cc ? "Save" : "Add command center"}
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
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
          <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" />
          <Field
            label="Letter"
            className="w-28"
            value={letter}
            onChange={(e) => setLetter(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(-1).toUpperCase())}
            maxLength={1}
            autoComplete="off"
            autoCapitalize="characters"
          />
          <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
          {err && <p role="alert" className="text-sm font-semibold">{errorText(err)}</p>}
        </form>
      </Sheet>
      <ConfirmSheet
        open={open && confirmDelete}
        title={`Remove CC ${cc?.name ?? ""}`}
        body={cc ? `Also removes ${plural(cc.crewCount, "crew")} and ${plural(cc.trucks.length, "truck")}` : undefined}
        action="Remove"
        busy={del.isPending}
        onConfirm={() => cc && del.mutate({ id: cc.id })}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
};

const ShirtSheet = ({ ccId, shirt, open, onClose }: { ccId: number; shirt: Shirt | null; open: boolean; onClose: () => void }) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(shirt?.name ?? "");
    setPhone(shirt?.phone ?? "");
    setRole(shirt?.roleLabel ?? "");
  }, [open, shirt]);
  const done = { onSuccess: () => { void utils.admin.days.get.invalidate(); onClose(); } };
  const create = trpc.admin.greenShirts.create.useMutation(done);
  const update = trpc.admin.greenShirts.update.useMutation(done);
  const del = trpc.admin.greenShirts.delete.useMutation(done);
  const submit = (): void => {
    if (!name.trim()) return;
    const body = { name: name.trim(), phone: phone.trim() || null, roleLabel: role.trim() || null };
    if (shirt) update.mutate({ id: shirt.id, ...body });
    else create.mutate({ ccId, ...body });
  };
  const err = create.error ?? update.error ?? del.error;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={shirt ? shirt.name : "New green shirt"}
      footer={
        <div className="flex gap-2">
          {shirt && (
            <Button variant="danger" size="lg" busy={del.isPending} onClick={() => del.mutate({ id: shirt.id })}>
              Remove
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!name.trim()} busy={create.isPending || update.isPending} onClick={submit}>
            {shirt ? "Save" : "Add green shirt"}
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
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        <Field label="Phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" />
        <Field label="Role" value={role} onChange={(e) => setRole(e.target.value)} maxLength={40} autoComplete="off" />
        {err && <p role="alert" className="text-sm font-semibold">{errorText(err)}</p>}
      </form>
    </Sheet>
  );
};

const TruckSheet = ({
  cc,
  ccs,
  truck,
  open,
  onClose,
  onNewCode,
}: {
  cc: Cc;
  ccs: readonly Cc[];
  truck: Truck | null;
  open: boolean;
  onClose: () => void;
  onNewCode: (t: Truck) => void;
}) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("");
  const [phone, setPhone] = useState("");
  const [ccId, setCcId] = useState(cc.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(truck?.name ?? `Truck ${ccs.reduce((n, c) => n + c.trucks.length, 0) + 1}`);
    setDriver(truck?.driverName ?? "");
    setPhone(truck?.driverPhone ?? "");
    setCcId(truck?.ccId ?? cc.id);
  }, [open, truck, cc.id, ccs]);
  const finish = (): void => {
    void utils.admin.days.get.invalidate();
    setConfirmDelete(false);
    onClose();
  };
  const create = trpc.admin.trucks.create.useMutation({ onSuccess: finish });
  const update = trpc.admin.trucks.update.useMutation({ onSuccess: finish });
  const del = trpc.admin.trucks.delete.useMutation({ onSuccess: finish });
  const submit = (): void => {
    if (!name.trim()) return;
    const body = { name: name.trim(), driverName: driver.trim() || null, driverPhone: phone.trim() || null };
    if (truck) update.mutate({ id: truck.id, ccId, ...body });
    else create.mutate({ ccId, ...body });
  };
  const err = create.error ?? update.error ?? del.error;
  return (
    <>
      <Sheet
        open={open && !confirmDelete}
        onClose={onClose}
        title={truck ? truck.name : "New truck"}
        footer={
          <div className="flex gap-2">
            {truck && (
              <Button variant="danger" size="lg" onClick={() => setConfirmDelete(true)}>
                Remove
              </Button>
            )}
            <Button size="lg" className="flex-1" disabled={!name.trim()} busy={create.isPending || update.isPending} onClick={submit}>
              {truck ? "Save" : "Add truck"}
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
          {truck && <CodeBlock label="Driver code" code={truck.code} onRegenerate={() => onNewCode(truck)} />}
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" />
          <Field label="Driver" value={driver} onChange={(e) => setDriver(e.target.value)} maxLength={80} autoComplete="off" />
          <Field label="Driver phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" />
          {ccs.length > 1 && (
            <Select label="Command center" value={ccId} onChange={(e) => setCcId(Number(e.target.value))}>
              {ccs.map((c) => (
                <option key={c.id} value={c.id}>
                  CC {c.name}
                </option>
              ))}
            </Select>
          )}
          {err && <p role="alert" className="text-sm font-semibold">{errorText(err)}</p>}
        </form>
      </Sheet>
      <ConfirmSheet
        open={open && confirmDelete}
        title={`Remove ${truck?.name ?? "truck"}`}
        body="Its stops go back to Open"
        action="Remove"
        busy={del.isPending}
        onConfirm={() => truck && del.mutate({ id: truck.id })}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
};

/** Stock capacity per tracked item. Only changed rows are saved. */
const CapacitySheet = ({ truck, open, onClose }: { truck: Truck | null; open: boolean; onClose: () => void }) => {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setCap = trpc.admin.trucks.setCapacity.useMutation();
  useEffect(() => {
    if (!open || !truck) return;
    setValues(Object.fromEntries(truck.stock.map((s) => [s.typeId, String(s.capacity)])));
    setError(null);
  }, [open, truck]);
  if (!truck) return null;
  const changed = truck.stock.filter((s) => {
    const v = values[s.typeId];
    return v !== undefined && v.trim() !== "" && Number(v) !== s.capacity;
  });
  const invalid = truck.stock.some((s) => {
    const v = Number(values[s.typeId]);
    return !Number.isInteger(v) || v < 0 || v > 1000;
  });
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const s of changed) await setCap.mutateAsync({ truckId: truck.id, typeId: s.typeId, capacity: Number(values[s.typeId]) });
      void utils.admin.days.get.invalidate();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`${truck.name} capacity`}
      footer={
        <Button block size="lg" busy={busy} disabled={changed.length === 0 || invalid} onClick={() => void save()}>
          {changed.length > 1 ? `Save ${changed.length} items` : "Save"}
        </Button>
      }
    >
      <div className="pb-2">
        {truck.stock.length === 0 ? (
          <EmptyState title="No tracked items" />
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="text-sm text-muted">
                <th className="py-2 font-semibold">Item</th>
                <th className="py-2 text-right font-semibold">On truck</th>
                <th className="w-28 py-2 pl-3 text-right font-semibold">Capacity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {truck.stock.map((s) => (
                <tr key={s.typeId}>
                  <td className="py-2 font-semibold">{s.label}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{s.qty}</td>
                  <td className="py-2 pl-3">
                    <input
                      aria-label={`${s.label} capacity`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1000}
                      value={values[s.typeId] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [s.typeId]: e.target.value }))}
                      className="block min-h-11 w-full rounded-xl border-0 bg-surface-2 px-3 text-right text-base tabular-nums ring-1 ring-inset ring-line focus:ring-2 focus:ring-ink focus:outline-none"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <p role="alert" className="mt-3 text-sm font-semibold">{error}</p>}
      </div>
    </Sheet>
  );
};
// #endregion

// #region cc card
const TruckRow = ({ truck, onEdit, onCapacity }: { truck: Truck; onEdit: () => void; onCapacity: () => void }) => {
  const low = truck.stock.filter((s) => s.low).length;
  const seen = truck.lastSeenAt;
  const details = [truck.driverName, truck.driverPhone ? phoneText(truck.driverPhone) : null, seen ? `seen ${ago(seen)}` : null].filter(Boolean).join(", ");
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand text-on-brand ring-2 ring-on-brand" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M3 6h11v9H3zM14 9h4l3 3v3h-7z" />
            <circle cx="7" cy="17" r="2" fill="currentColor" />
            <circle cx="17" cy="17" r="2" fill="currentColor" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{truck.name}</span>
            <StatusPill status={truck.status} />
            {low > 0 && <StatusPill status="low" />}
          </span>
          <span className="block text-sm text-muted">{details || "No driver"}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-h-10 items-center rounded-lg bg-surface-2 px-3 font-mono text-lg font-bold tracking-[0.15em] ring-1 ring-inset ring-line">
          <span className="sr-only">Code </span>
          {truck.code}
        </span>
        <Button variant="secondary" size="sm" onClick={onCapacity}>
          Capacity
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${truck.name}`}>
          <EditIcon />
          Edit
        </Button>
      </div>
      {truck.stock.some((s) => s.capacity > 0) && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${truck.name} stock`}>
          {truck.stock
            .filter((s) => s.capacity > 0)
            .map((s) => (
              <li key={s.typeId} className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${s.low ? "bg-warn/15" : "bg-surface-2 text-muted"}`}>
                {s.label} {s.qty}/{s.capacity}
              </li>
            ))}
        </ul>
      )}
    </li>
  );
};

const CcCard = ({
  cc,
  ccs,
  onEdit,
  onMove,
  selected,
  notify,
}: {
  cc: Cc;
  ccs: readonly Cc[];
  onEdit: () => void;
  onMove: () => void;
  selected: boolean;
  notify: (n: NoticeValue) => void;
}) => {
  const utils = trpc.useUtils();
  const [shirt, setShirt] = useState<Shirt | null | "new">(null);
  const [truck, setTruck] = useState<Truck | null | "new">(null);
  const [capacity, setCapacity] = useState<Truck | null>(null);
  const [codeFor, setCodeFor] = useState<{ kind: "green" } | { kind: "truck"; truck: Truck } | null>(null);
  const greenCode = trpc.admin.greenCodes.regenerate.useMutation({
    onSuccess: (r) => {
      void utils.admin.days.get.invalidate();
      setCodeFor(null);
      notify({ tone: "ok", text: `CC ${cc.name} green code ${r.code}` });
    },
  });
  const oneway = trpc.admin.ccs.loadOneway.useMutation({
    onSuccess: (r) =>
      notify(r.error ? { tone: "error", text: `CC ${cc.name} one-way streets unavailable. Try again later.` } : { tone: "ok", text: `CC ${cc.name}, ${plural(r.ways, "one-way street")}, ${plural(r.alleys, "alley", "alleys")}` }),
    onError: (e) => notify({ tone: "error", text: errorText(e) }),
  });
  const truckCode = trpc.admin.trucks.regenerateCode.useMutation({
    onSuccess: (t) => {
      void utils.admin.days.get.invalidate();
      setCodeFor(null);
      setTruck(null);
      notify({ tone: "ok", text: `${t.name} code ${t.code}` });
    },
  });
  return (
    <Panel
      className={selected ? "ring-2 ring-brand" : ""}
      title={
        <span className="flex items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand text-base font-extrabold text-on-brand ring-2 ring-on-brand" aria-hidden="true">
            {cc.letter ?? (
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path fill="currentColor" d="M5 3h2v18H5zM7 4h11l-2 4 2 4H7z" />
              </svg>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate">CC {cc.name}</span>
            <span className="block truncate text-sm font-normal text-muted">{cc.address || "No address"}</span>
          </span>
        </span>
      }
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onMove}>
            <PinIcon />
            Move
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <EditIcon />
            Edit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {cc.notes && <p className="text-sm whitespace-pre-line text-muted">{cc.notes}</p>}
        <CodeBlock label="Green code" code={cc.greenCode} onRegenerate={() => setCodeFor({ kind: "green" })} />
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Green shirts</h3>
            <Button variant="ghost" size="sm" onClick={() => setShirt("new")}>
              <PlusIcon />
              Add
            </Button>
          </div>
          {cc.greenShirts.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">No green shirts</p>
          ) : (
            <ul className="divide-y divide-line">
              {cc.greenShirts.map((g) => (
                <li key={g.id} className="flex items-center gap-2 py-2">
                  <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full bg-brand-green" />
                  <button type="button" onClick={() => setShirt(g)} className="min-h-10 min-w-0 flex-1 text-left">
                    <span className="block truncate font-semibold">{g.name}</span>
                    <span className="block truncate text-sm text-muted">{[g.roleLabel, g.phone ? phoneText(g.phone) : null].filter(Boolean).join(", ") || "No phone"}</span>
                  </button>
                  {g.phone && (
                    <a href={telHref(g.phone)} aria-label={`Call ${g.name}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 ring-1 ring-inset ring-line">
                      <PhoneIcon />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="font-semibold">Trucks</h3>
            <Button variant="ghost" size="sm" onClick={() => setTruck("new")}>
              <PlusIcon />
              Add
            </Button>
          </div>
          {cc.trucks.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">No trucks</p>
          ) : (
            <ul className="divide-y divide-line">
              {cc.trucks.map((t) => (
                <TruckRow key={t.id} truck={t} onEdit={() => setTruck(t)} onCapacity={() => setCapacity(t)} />
              ))}
            </ul>
          )}
        </div>
        <Link href={`/admin/crews?day=${cc.dayId}`} className="flex min-h-10 items-center justify-between rounded-xl bg-surface-2 px-4 text-sm font-semibold hover:brightness-95">
          <span>Crews</span>
          <span className="tabular-nums text-muted">{cc.crewCount}</span>
        </Link>
        <Button variant="secondary" size="sm" block busy={oneway.isPending} data-oneway-load onClick={() => oneway.mutate({ id: cc.id })}>
          Load one-way streets
        </Button>
      </div>
      <ShirtSheet ccId={cc.id} shirt={shirt === "new" ? null : shirt} open={shirt !== null} onClose={() => setShirt(null)} />
      <TruckSheet
        cc={cc}
        ccs={ccs}
        truck={truck === "new" ? null : truck}
        open={truck !== null && codeFor === null}
        onClose={() => setTruck(null)}
        onNewCode={(t) => setCodeFor({ kind: "truck", truck: t })}
      />
      <CapacitySheet truck={capacity} open={capacity !== null} onClose={() => setCapacity(null)} />
      <ConfirmSheet
        open={codeFor !== null}
        title={codeFor?.kind === "truck" ? `New code for ${codeFor.truck.name}` : `New green code for CC ${cc.name}`}
        body="Old code stops working"
        action="New code"
        busy={greenCode.isPending || truckCode.isPending}
        onConfirm={() => {
          if (codeFor?.kind === "truck") truckCode.mutate({ id: codeFor.truck.id });
          else greenCode.mutate({ ccId: cc.id });
        }}
        onClose={() => setCodeFor(null)}
      />
    </Panel>
  );
};
// #endregion

export const DayPage = ({ id }: { id: number }) => {
  const [, navigate] = useLocation();
  const q = trpc.admin.days.get.useQuery({ id }, { enabled: Number.isInteger(id) && id > 0 });
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<MapModeState>({ kind: "idle" });
  const [newAt, setNewAt] = useState<{ lat: number; lng: number } | null>(null);
  const [editCc, setEditCc] = useState<Cc | null>(null);
  const [editDay, setEditDay] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [map, setMap] = useState<LeafletMap | null>(null);
  useOnewayLayer(map);
  const clearNotice = useCallback(() => setNotice(null), []);

  const move = trpc.admin.ccs.update.useMutation({
    onSuccess: (c) => {
      void utils.admin.days.get.invalidate();
      setNotice({ tone: "ok", text: `CC ${c.name} moved` });
    },
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });
  const copy = trpc.admin.days.copyFromPrevious.useMutation({
    onSuccess: (r) => {
      void utils.admin.invalidate();
      setNotice({ tone: "ok", text: `${plural(r.ccs, "CC")} and ${plural(r.trucks, "truck")} copied` });
    },
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });

  const data = q.data;
  const ccs = data?.ccs ?? [];

  const lotsQ = trpc.admin.lots.list.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const lotMarkers = useMemo<MapMarker[]>(() => {
    const ids = new Set(ccs.map((c) => c.id));
    return (lotsQ.data ?? [])
      .filter((l) => l.ccId !== null && ids.has(l.ccId))
      .map((l) => ({ id: `lot-${l.id}`, kind: "lot", lat: l.lat, lng: l.lng, status: l.status, geometry: l.geometry, mine: false, noFit: true }));
  }, [lotsQ.data, ccs]);

  const ccMarkers = useMemo<MapMarker[]>(
    () =>
      ccs.map((c) => ({
        id: `cc-${c.id}`,
        kind: "cc",
        lat: c.lat,
        lng: c.lng,
        name: `CC ${c.name}`,
        letter: c.letter,
        onClick: mode.kind === "idle" ? () => {
          setSelected(c.id);
          document.getElementById(`cc-card-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        } : undefined,
        onDragEnd: mode.kind === "idle" ? (lat: number, lng: number) => move.mutate({ id: c.id, lat, lng }) : undefined,
      })),
    [ccs, mode.kind],
  );
  const markers = useMemo(() => [...lotMarkers, ...ccMarkers], [lotMarkers, ccMarkers]);

  const onMapClick = (lat: number, lng: number): void => {
    if (mode.kind === "new") {
      setNewAt({ lat, lng });
      setMode({ kind: "idle" });
    } else if (mode.kind === "move") {
      move.mutate({ id: mode.ccId, lat, lng });
      setMode({ kind: "idle" });
    }
  };

  if (q.isLoading) {
    return (
      <Page title="Day" wide>
        <SkeletonList rows={4} className="h-14" />
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Day">
        <EmptyState title="Day not found" action={<Button onClick={() => navigate("/admin")}>Event</Button>} />
      </Page>
    );
  }

  const { day, previous } = data;
  const canCopy = ccs.length === 0 && previous !== null && previous.ccCount > 0;

  return (
    <Page
      wide
      title={`${day.label}, ${dayDate(day.date)}`}
      actions={
        <Button variant="secondary" onClick={() => setEditDay(true)}>
          <EditIcon />
          Edit day
        </Button>
      }
    >
      <div className="space-y-4">
        {data.days.length > 1 && (
          <Chips label="Day" value={day.id} options={data.days.map((d) => ({ value: d.id, label: d.label }))} onChange={(v) => navigate(`/admin/days/${v}`)} />
        )}
        <Notice value={notice} onClear={clearNotice} />
        <Panel
          flush
          title="Command centers"
          actions={
            ccs.length > 0 ? (
              <Button size="sm" onClick={() => setMode({ kind: "new" })} disabled={mode.kind !== "idle"}>
                <PlusIcon />
                Add CC
              </Button>
            ) : undefined
          }
        >
          <div className="relative h-72 nav:h-[26rem]">
            <MapView markers={markers} onMapClick={mode.kind === "idle" ? undefined : onMapClick} fitKey={`${day.id}:${ccs.length}`} label="Command centers map" className="absolute inset-0" onReady={setMap} />
            <AlleyLayer map={map} />
            {mode.kind !== "idle" && (
              <MapMode label={mode.kind === "new" ? "New CC position" : `New position, CC ${mode.name}`} onCancel={() => setMode({ kind: "idle" })} />
            )}
          </div>
        </Panel>
        {ccs.length === 0 ? (
          <Panel>
            <EmptyState
              title="No command centers"
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setMode({ kind: "new" })}>
                    <PlusIcon />
                    Add CC
                  </Button>
                  {canCopy && previous && (
                    <Button variant="secondary" busy={copy.isPending} onClick={() => copy.mutate({ id: day.id })}>
                      Copy from {previous.label}
                    </Button>
                  )}
                </div>
              }
            />
          </Panel>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
            {ccs.map((c) => (
              <div key={c.id} id={`cc-card-${c.id}`} className="scroll-mt-20">
                <CcCard
                  cc={c}
                  ccs={ccs}
                  selected={selected === c.id}
                  onEdit={() => setEditCc(c)}
                  onMove={() => {
                    setMode({ kind: "move", ccId: c.id, name: c.name });
                    window.scrollTo({ top: 0, behavior: "smooth" });
                    document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  notify={setNotice}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <DaySheet day={day} open={editDay} onClose={() => setEditDay(false)} />
      <CcSheet
        dayId={day.id}
        cc={editCc}
        at={newAt}
        open={editCc !== null || newAt !== null}
        onClose={() => {
          setEditCc(null);
          setNewAt(null);
        }}
        onSaved={(text) => setNotice({ tone: "ok", text })}
      />
    </Page>
  );
};
