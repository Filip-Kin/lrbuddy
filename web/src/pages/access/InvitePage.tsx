import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { Chips, Segmented } from "../../components/Segmented.tsx";
import { StatusPill, type PillStatus } from "../../components/StatusPill.tsx";
import { Switch } from "../../components/Switch.tsx";
import { dayDate } from "../../components/admin/format.ts";
import { errorText } from "../../lib/errors.ts";
import { dateTime, TIME_ZONE } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Options = RouterOutputs["invites"]["options"];
type Created = RouterOutputs["invites"]["create"];
type Row = RouterOutputs["invites"]["list"][number];
type InviteRole = "crew" | "driver" | "green" | "admin";
type Expiry = "day" | "1d" | "7d";

const ROLES: ReadonlyArray<{ value: InviteRole; label: string }> = [
  { value: "crew", label: "Red shirt" },
  { value: "driver", label: "Driver" },
  { value: "green", label: "Green shirt" },
  { value: "admin", label: "Admin" },
];

const EXPIRY_LABEL: Record<Expiry, string> = { day: "End of day", "1d": "1 day", "7d": "7 days" };

const STATE_PILL: Record<Row["state"], PillStatus> = { active: "invite_active", used: "used", expired: "expired", revoked: "revoked" };

const todayInDetroit = (): string => new Date().toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });

// #region copy and share
const copyText = async (text: string): Promise<void> => {
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
};

/** The new link: QR, the link itself, Copy and Share (Web Share API, else a copy). */
const Result = ({ invite }: { invite: Created }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (): Promise<void> => {
    await copyText(invite.link);
    setCopied(true);
  };
  const share = async (): Promise<void> => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "LR Buddy", text: invite.label, url: invite.link });
        return;
      } catch (err) {
        // Closing the share sheet is not a failure; anything else falls back to a copy.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    await copy();
  };
  return (
    <Panel title={invite.label}>
      <div className="grid gap-4 nav:grid-cols-[14rem_1fr] nav:items-start" data-invite-result>
        <div
          role="img"
          aria-label={`QR code for ${invite.label}`}
          className="mx-auto aspect-square w-56 rounded-xl bg-white p-2 [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: invite.qrSvg }}
        />
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-sm break-all select-all ring-1 ring-inset ring-line" data-invite-link>
            {invite.link}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" onClick={() => void copy()}>
              <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <Button size="lg" onClick={() => void share()}>
              Share
            </Button>
          </div>
          <div className="text-sm text-muted">
            {[invite.name, invite.maxUses === 1 ? "Single use" : null, `Until ${dateTime(invite.expiresAt)}`].filter(Boolean).join(", ")}
          </div>
        </div>
      </div>
    </Panel>
  );
};
// #endregion

// #region form
const InviteForm = ({ options, onCreated }: { options: Options; onCreated: (c: Created) => void }) => {
  const utils = trpc.useUtils();
  const [role, setRole] = useState<InviteRole>("crew");
  const [dayId, setDayId] = useState<number | null>(options.defaultDayId);
  const [ccId, setCcId] = useState<number | null>(null);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [truckId, setTruckId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [singleUse, setSingleUse] = useState(false);
  const [expiry, setExpiry] = useState<Expiry | null>(null);
  const create = trpc.invites.create.useMutation({
    onSuccess: (c) => {
      void utils.invites.list.invalidate();
      setName("");
      onCreated(c);
    },
  });

  const roles = options.admin ? ROLES : ROLES.filter((r) => r.value !== "admin");
  const day = options.days.find((d) => d.id === dayId) ?? null;
  const ccs = day?.ccs ?? [];
  const cc = ccs.find((c) => c.id === ccId) ?? null;
  useEffect(() => {
    if (ccs.length === 1 && ccId !== ccs[0]!.id) setCcId(ccs[0]!.id);
  }, [ccs, ccId]);

  const dayOver = day !== null && day.date < todayInDetroit();
  const expiries = useMemo((): Expiry[] => (role === "admin" || dayOver ? ["1d", "7d"] : ["day", "1d", "7d"]), [role, dayOver]);
  const fallback: Expiry = role === "admin" ? "7d" : dayOver ? "1d" : "day";
  const shownExpiry = expiry !== null && expiries.includes(expiry) ? expiry : fallback;

  const scoped = role !== "admin";
  const ready = !scoped || (cc !== null && (role === "green" || (role === "crew" ? crewId !== null : truckId !== null)));

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        create.mutate({
          role,
          ccId: scoped ? cc?.id : null,
          crewId: role === "crew" ? crewId : null,
          truckId: role === "driver" ? truckId : null,
          name: name.trim() || null,
          singleUse,
          expiry: shownExpiry,
        });
      }}
    >
      <div className="space-y-1.5">
        <div className="text-sm font-semibold">Role</div>
        <Segmented label="Role" value={role} options={roles} onChange={setRole} size="lg" pairs={roles.length === 4} />
      </div>

      {scoped && (
        <>
          {options.days.length === 0 ? (
            <p className="text-base text-muted">No command centers</p>
          ) : options.days.length === 1 && day ? (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Day</div>
              <div className="text-base">
                {day.label}, {dayDate(day.date)}
              </div>
            </div>
          ) : (
            <Select
              label="Day"
              value={dayId ?? ""}
              onChange={(e) => {
                setDayId(Number(e.target.value));
                setCcId(null);
                setCrewId(null);
                setTruckId(null);
              }}
            >
              {options.days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}, {dayDate(d.date)}
                </option>
              ))}
            </Select>
          )}

          {ccs.length === 1 && cc ? (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Command center</div>
              <div className="text-base">CC {cc.name}</div>
            </div>
          ) : (
            ccs.length > 1 && (
              <div className="space-y-1.5">
                <div className="text-sm font-semibold">Command center</div>
                <Chips
                  label="Command center"
                  value={ccId}
                  options={ccs.map((c) => ({ value: c.id, label: `CC ${c.name}` }))}
                  onChange={(v) => {
                    setCcId(v);
                    setCrewId(null);
                    setTruckId(null);
                  }}
                />
              </div>
            )
          )}

          {role === "crew" && cc && (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Crew</div>
              {cc.crews.length === 0 ? (
                <p className="text-base text-muted">No crews</p>
              ) : (
                <Chips label="Crew" value={crewId} options={cc.crews.map((c) => ({ value: c.id, label: c.name }))} onChange={setCrewId} />
              )}
            </div>
          )}

          {role === "driver" && cc && (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Truck</div>
              {cc.trucks.length === 0 ? (
                <p className="text-base text-muted">No trucks</p>
              ) : (
                <Chips label="Truck" value={truckId} options={cc.trucks.map((t) => ({ value: t.id, label: t.name }))} onChange={setTruckId} />
              )}
            </div>
          )}
        </>
      )}

      <Field label="Name" name="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />

      <div className="space-y-1.5">
        <div className="text-sm font-semibold">Expires</div>
        <Segmented label="Expires" value={shownExpiry} options={expiries.map((v) => ({ value: v, label: EXPIRY_LABEL[v] }))} onChange={setExpiry} />
      </div>

      <Switch label="Single use" checked={singleUse} onChange={setSingleUse} />

      {create.error && (
        <p role="alert" className="text-sm font-semibold before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
          {errorText(create.error, "Not created, try again")}
        </p>
      )}
      <Button type="submit" size="lg" block disabled={!ready} busy={create.isPending}>
        Create
      </Button>
    </form>
  );
};
// #endregion

// #region list
const usesText = (r: Row): string => (r.maxUses !== null ? `${r.uses} of ${r.maxUses} uses` : `${r.uses} ${r.uses === 1 ? "use" : "uses"}`);

const InviteList = () => {
  const utils = trpc.useUtils();
  const list = trpc.invites.list.useQuery(undefined, { refetchInterval: 30_000 });
  const [revoking, setRevoking] = useState<Row | null>(null);
  const revoke = trpc.invites.revoke.useMutation({
    onSuccess: () => {
      setRevoking(null);
      void utils.invites.list.invalidate();
    },
  });
  return (
    <Panel title="Invites" flush>
      {list.isLoading ? (
        <div className="m-4 h-24 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
      ) : list.isError || !list.data ? (
        <EmptyState title="Invites not loaded" action={<Button onClick={() => void list.refetch()}>Retry</Button>} />
      ) : list.data.length === 0 ? (
        <p className="px-4 py-6 text-center text-base text-muted">No invites</p>
      ) : (
        <ul className="divide-y divide-line" data-invite-list>
          {list.data.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3" data-invite-row>
              <div className="min-w-0">
                <div className="truncate font-semibold">{r.label}</div>
                <div className="text-sm text-muted">
                  {[r.name, r.createdBy ? `By ${r.createdBy}` : null, usesText(r), r.state === "active" ? `Until ${dateTime(r.expiresAt)}` : null].filter(Boolean).join(", ")}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <StatusPill status={STATE_PILL[r.state]} />
                {r.state === "active" && (
                  <Button variant="secondary" size="sm" onClick={() => setRevoking(r)}>
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmSheet
        open={revoking !== null}
        title="Revoke invite"
        body={revoking?.label}
        action="Revoke"
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ id: revoking.id })}
        onClose={() => setRevoking(null)}
      />
    </Panel>
  );
};
// #endregion

/**
 * The Invite screen (SPEC 26): admins at `/admin/invite` (any role and scope),
 * green shirts at `/invite` (their own CC and day). A new link shows with its
 * QR, Copy and Share; the list below has every invite with Revoke.
 */
export const InvitePage = () => {
  const options = trpc.invites.options.useQuery();
  const [created, setCreated] = useState<Created | null>(null);
  return (
    <Page title="Invite" wide>
      <div className="grid grid-cols-1 gap-4 nav:grid-cols-2 nav:items-start">
        <div className="space-y-4">
          {created && <Result invite={created} />}
          <Panel title="New invite">
            {options.isLoading ? (
              <div className="h-60 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
            ) : options.isError || !options.data ? (
              <EmptyState title="Invite not loaded" action={<Button onClick={() => void options.refetch()}>Retry</Button>} />
            ) : (
              <InviteForm
                options={options.data}
                onCreated={(c) => {
                  setCreated(c);
                  window.requestAnimationFrame(() => document.querySelector("[data-invite-result]")?.scrollIntoView({ block: "nearest" }));
                }}
              />
            )}
          </Panel>
        </div>
        <InviteList />
      </div>
    </Page>
  );
};
