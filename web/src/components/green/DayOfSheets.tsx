import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { ConfirmSheet } from "../ConfirmSheet.tsx";
import { Field, Select } from "../Field.tsx";
import { ToggleChip } from "../Segmented.tsx";
import { Sheet } from "../Sheet.tsx";
import { trpc } from "../../lib/trpc.ts";
import type { DayOfArea, DayOfPlan } from "./dayOfLayer.ts";
import { errorText, useGreenInvalidate } from "./hooks.ts";
import { Fact } from "./ui.tsx";

const lots = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "lot" : "lots"}`;
const unfinished = (c: DayOfArea["counts"]): number => c.open + c.inProgress + c.notDone;
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`);

type Step = "menu" | "reassign" | "done" | "dnt" | "delete";

const DntTag = () => <span className="inline-flex rounded-full px-2.5 py-0.5 text-sm font-bold ring-2 ring-inset ring-warn">Do not touch</span>;

const Counts = ({ c }: { c: DayOfArea["counts"] }) => (
  <>
    <Fact label="Todo">{c.open + c.inProgress}</Fact>
    <Fact label="Done">{c.done}</Fact>
    {c.notDone > 0 && <Fact label="Not done">{c.notDone}</Fact>}
    {c.doNotTouch > 0 && <Fact label="Do not touch">{c.doNotTouch}</Fact>}
  </>
);

/** Done and Do not touch, then their confirm with the count. For the rectangle sheet. */
const useMark = (onDone: (msg: string) => void, onClose: () => void) => {
  const refresh = useGreenInvalidate();
  const [err, setErr] = useState<string | null>(null);
  const opts = {
    onSettled: refresh,
    onError: (x: unknown) => setErr(errorText(x)),
  };
  const area = trpc.green.markArea.useMutation(opts);
  const finish = (action: "done" | "doNotTouch", changed: number): void => {
    onDone(action === "done" ? `${lots(changed)} done` : `Do not touch, ${lots(changed)}`);
    onClose();
  };
  return {
    err,
    clearErr: () => setErr(null),
    busy: area.isPending,
    markArea: (areaId: number, action: "done" | "doNotTouch") => area.mutate({ areaId, action }, { onSuccess: (r) => finish(action, r.changed) }),
  };
};

const Actions = ({ open, onStep, reassign }: { open: number; onStep: (s: Step) => void; reassign: boolean }) => (
  <div className={`grid gap-2 ${reassign ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
    {reassign && (
      <Button variant="secondary" size="lg" onClick={() => onStep("reassign")}>
        Reassign
      </Button>
    )}
    <Button size="lg" disabled={open === 0} onClick={() => onStep("done")}>
      Done
    </Button>
    <Button variant="danger" size="lg" onClick={() => onStep("dnt")}>
      Do not touch
    </Button>
  </div>
);

const ErrorLine = ({ text }: { text: string | null }) =>
  text ? (
    <p role="alert" className="text-sm font-semibold text-ink before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
      {text}
    </p>
  ) : null;

// #region rectangle
export const AreaSheet = ({
  area,
  companies,
  onClose,
  onDone,
  onEditCorners,
}: {
  area: DayOfArea | null;
  companies: DayOfPlan["companies"];
  onClose: () => void;
  onDone: (msg: string) => void;
  /** Edit corners (SPEC 21): the map takes the rectangle's handles. */
  onEditCorners: (areaId: number) => void;
}) => {
  const remove = trpc.green.deleteArea.useMutation();
  const [step, setStep] = useState<Step>("menu");
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [crewIds, setCrewIds] = useState<ReadonlySet<number>>(() => new Set());
  const mark = useMark(onDone, onClose);
  const refresh = useGreenInvalidate();
  const reassign = trpc.green.reassignArea.useMutation({ onSettled: refresh });
  const [err, setErr] = useState<string | null>(null);
  const areaId = area?.id ?? null;

  useEffect(() => {
    setStep("menu");
    setErr(null);
    mark.clearErr();
    setCrewIds(new Set());
    // A new rectangle starts on the first company that is not already working it.
    setCompanyId(companies.find((c) => c.id !== area?.companyId)?.id ?? companies[0]?.id ?? null);
    // Reset per rectangle only; `companies` refetches with every change on the map.
  }, [areaId]);

  if (!area) return null;
  const open = unfinished(area.counts);
  const company = companies.find((c) => c.id === companyId) ?? null;
  const picked = company ? company.crews.filter((c) => crewIds.has(c.id)) : [];

  if (step === "delete") {
    return (
      <ConfirmSheet
        open
        title="Delete area"
        body={
          <div className="space-y-2">
            <p className="font-semibold text-ink">{area.label}</p>
            <p className="text-sm text-muted">Lots stay, no crew</p>
            <ErrorLine text={err} />
          </div>
        }
        action="Delete area"
        busy={remove.isPending}
        onConfirm={() => {
          setErr(null);
          remove.mutate(
            { areaId: area.id },
            {
              onSuccess: () => {
                refresh();
                onDone(`${area.label} removed`);
                onClose();
              },
              onError: (x) => setErr(errorText(x)),
            },
          );
        }}
        onClose={() => setStep("menu")}
      />
    );
  }

  if (step === "done" || step === "dnt") {
    const dnt = step === "dnt";
    return (
      <ConfirmSheet
        open
        title={dnt ? (open > 0 ? `Do not touch, ${lots(open)}` : "Do not touch") : `Mark ${lots(open)} done`}
        body={
          <div className="space-y-2">
            <p className="font-semibold text-ink">{area.label}</p>
            <ErrorLine text={mark.err} />
          </div>
        }
        action={dnt ? "Do not touch" : "Done"}
        busy={mark.busy}
        onConfirm={() => mark.markArea(area.id, dnt ? "doNotTouch" : "done")}
        onClose={() => setStep("menu")}
      />
    );
  }

  return (
    <Sheet open onClose={onClose} title={area.label}>
      <div className="space-y-4 pb-2">
        {area.doNotTouch && <DntTag />}
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2 p-3 sm:grid-cols-4">
          <div className="col-span-2">
            <Fact label="Streets">{area.streets || "None"}</Fact>
          </div>
          <div className="col-span-2">
            <Fact label="Company">{area.companyName ?? "None"}</Fact>
          </div>
          <Counts c={area.counts} />
        </div>
        {step === "reassign" ? (
          <section aria-label="Reassign" className="space-y-3">
            <Select
              label="Company"
              value={companyId ?? ""}
              onChange={(e) => {
                setCompanyId(e.target.value ? Number(e.target.value) : null);
                setCrewIds(new Set());
              }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {company && (
              <div role="group" aria-label="Crews" className="flex flex-wrap gap-2">
                {company.crews.map((c) => (
                  <ToggleChip
                    key={c.id}
                    on={crewIds.has(c.id)}
                    onChange={() =>
                      setCrewIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                  >
                    {c.name}
                  </ToggleChip>
                ))}
              </div>
            )}
            <ErrorLine text={err} />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" onClick={() => setStep("menu")}>
                Back
              </Button>
              <Button
                size="lg"
                disabled={picked.length === 0 || companyId === null}
                busy={reassign.isPending}
                onClick={() => {
                  if (companyId === null) return;
                  setErr(null);
                  reassign.mutate(
                    { areaId: area.id, companyId, crewIds: picked.map((c) => c.id) },
                    {
                      onSuccess: (r) => {
                        onDone(`${area.label} to ${r.label}`);
                        onClose();
                      },
                      onError: (x) => setErr(errorText(x)),
                    },
                  );
                }}
              >
                {picked.length === 0 ? "Reassign" : `Reassign to ${joinNames(picked.map((c) => c.name))}`}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <Actions open={open} onStep={setStep} reassign={companies.length > 0} />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" onClick={() => onEditCorners(area.id)}>
                Edit corners
              </Button>
              <Button variant="secondary" size="lg" onClick={() => setStep("delete")}>
                Delete area
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
};
// #endregion

// #region area drawn on the map (SPEC 21)
/**
 * After Draw area: pick one or several crews at this CC, or build crews for a
 * company that has none, then Assign. The Todo lots inside go to the crews.
 */
export const AssignAreaSheet = ({
  open,
  polygon,
  todoInside,
  companies,
  buildable,
  onClose,
  onDone,
}: {
  open: boolean;
  polygon: { type: "Polygon"; coordinates: Array<Array<[number, number]>> } | null;
  todoInside: number;
  companies: DayOfPlan["companies"];
  buildable: DayOfPlan["buildable"];
  onClose: () => void;
  onDone: (msg: string) => void;
}) => {
  const refresh = useGreenInvalidate();
  const assign = trpc.green.assignArea.useMutation();
  const build = trpc.green.buildCrews.useMutation();
  const [crewIds, setCrewIds] = useState<ReadonlySet<number>>(() => new Set());
  const [heads, setHeads] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setCrewIds(new Set());
    setErr(null);
  }, [open, polygon]);

  const allCrews = companies.flatMap((c) => c.crews);
  const picked = allCrews.filter((c) => crewIds.has(c.id));
  const toggle = (id: number): void =>
    setCrewIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Sheet open={open && polygon !== null} onClose={onClose} title="New area">
      <div className="space-y-4 pb-2">
        <div className="rounded-2xl bg-surface-2 p-3">
          <Fact label="Todo inside">{todoInside}</Fact>
        </div>
        {companies.map((co) => (
          <section key={co.id} aria-label={co.name} className="space-y-2">
            <h3 className="text-sm font-bold text-muted uppercase">{co.name}</h3>
            <div role="group" aria-label={`${co.name} crews`} className="flex flex-wrap gap-2">
              {co.crews.map((c) => (
                <ToggleChip key={c.id} on={crewIds.has(c.id)} onChange={() => toggle(c.id)}>
                  {c.name}
                </ToggleChip>
              ))}
            </div>
          </section>
        ))}
        {buildable.length > 0 && (
          <section aria-label="Build crews" className="space-y-2">
            <h3 className="text-sm font-bold text-muted uppercase">Build crews</h3>
            <ul className="space-y-2">
              {buildable.map((co) => (
                <li key={co.id} className="flex flex-wrap items-end gap-2">
                  <span className="min-w-0 flex-1 self-center font-semibold break-words">{co.name}</span>
                  {co.headcount === null && (
                    <Field
                      label="Headcount"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      className="w-28"
                      value={heads[co.id] ?? ""}
                      onChange={(e) => setHeads((h) => ({ ...h, [co.id]: e.target.value }))}
                    />
                  )}
                  <Button
                    variant="secondary"
                    busy={build.isPending && build.variables?.companyId === co.id}
                    disabled={co.headcount === null && !(Number(heads[co.id]) >= 1)}
                    onClick={() => {
                      setErr(null);
                      const n = Number(heads[co.id]);
                      build.mutate(
                        { companyId: co.id, headcount: co.headcount === null ? n : undefined },
                        {
                          onSuccess: (made) => {
                            setCrewIds((prev) => new Set([...prev, ...made.map((c) => c.id)]));
                            refresh();
                          },
                          onError: (x) => setErr(errorText(x)),
                        },
                      );
                    }}
                  >
                    {co.headcount === null ? "Build crews" : `Build crews, ${co.headcount}`}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ErrorLine text={err} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="lg"
            disabled={picked.length === 0 || polygon === null}
            busy={assign.isPending}
            onClick={() => {
              if (!polygon) return;
              setErr(null);
              assign.mutate(
                { polygon, crewIds: picked.map((c) => c.id) },
                {
                  onSuccess: (r) => {
                    refresh();
                    onDone(`${r.label}, ${lots(r.moved)}`);
                    onClose();
                  },
                  onError: (x) => setErr(errorText(x)),
                },
              );
            }}
          >
            {picked.length === 0 ? "Assign" : `Assign to ${joinNames(picked.map((c) => c.name))}`}
          </Button>
        </div>
      </div>
    </Sheet>
  );
};
// #endregion

