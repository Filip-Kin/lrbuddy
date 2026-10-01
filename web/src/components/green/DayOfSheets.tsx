import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { ConfirmSheet } from "../ConfirmSheet.tsx";
import { Select } from "../Field.tsx";
import { ToggleChip } from "../Segmented.tsx";
import { Sheet } from "../Sheet.tsx";
import { trpc } from "../../lib/trpc.ts";
import type { DayOfArea, DayOfPlan, DayOfSide } from "./dayOfLayer.ts";
import { errorText, useGreenInvalidate } from "./hooks.ts";
import { Fact } from "./ui.tsx";

const lots = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "lot" : "lots"}`;
const unfinished = (c: DayOfSide["counts"]): number => c.open + c.inProgress;
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`);

type Step = "menu" | "reassign" | "done" | "dnt";

const DntTag = () => <span className="inline-flex rounded-full px-2.5 py-0.5 text-sm font-bold ring-2 ring-inset ring-warn">Do not touch</span>;

const Counts = ({ c }: { c: DayOfSide["counts"] }) => (
  <>
    <Fact label="Open">{unfinished(c)}</Fact>
    <Fact label="Done">{c.done}</Fact>
    {c.skipped > 0 && <Fact label="Skipped">{c.skipped}</Fact>}
  </>
);

/** Done and Do not touch, then their confirm with the count. Shared by the rectangle and the block side sheets. */
const useMark = (onDone: (msg: string) => void, onClose: () => void) => {
  const refresh = useGreenInvalidate();
  const [err, setErr] = useState<string | null>(null);
  const opts = {
    onSettled: refresh,
    onError: (x: unknown) => setErr(errorText(x)),
  };
  const area = trpc.green.markArea.useMutation(opts);
  const side = trpc.green.markSide.useMutation(opts);
  const finish = (action: "done" | "doNotTouch", changed: number): void => {
    onDone(action === "done" ? `${lots(changed)} done` : `Do not touch, ${lots(changed)}`);
    onClose();
  };
  return {
    err,
    clearErr: () => setErr(null),
    busy: area.isPending || side.isPending,
    markArea: (areaId: number, action: "done" | "doNotTouch") => area.mutate({ areaId, action }, { onSuccess: (r) => finish(action, r.changed) }),
    markSide: (key: string, action: "done" | "doNotTouch") => side.mutate({ key, action }, { onSuccess: (r) => finish(action, r.changed) }),
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
}: {
  area: DayOfArea | null;
  companies: DayOfPlan["companies"];
  onClose: () => void;
  onDone: (msg: string) => void;
}) => {
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
          <Actions open={open} onStep={setStep} reassign={companies.length > 0} />
        )}
      </div>
    </Sheet>
  );
};
// #endregion

// #region block side
export const SideSheet = ({
  side,
  areaLabel,
  onClose,
  onDone,
}: {
  side: DayOfSide | null;
  areaLabel: string | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) => {
  const [step, setStep] = useState<Step>("menu");
  const mark = useMark(onDone, onClose);
  const key = side?.key ?? null;
  useEffect(() => {
    setStep("menu");
    mark.clearErr();
  }, [key]);
  if (!side) return null;
  const open = unfinished(side.counts);
  if (step === "done" || step === "dnt") {
    const dnt = step === "dnt";
    return (
      <ConfirmSheet
        open
        title={dnt ? (open > 0 ? `Do not touch, ${lots(open)}` : "Do not touch") : `Mark ${lots(open)} done`}
        body={
          <div className="space-y-2">
            <p className="font-semibold text-ink">{side.label}</p>
            <ErrorLine text={mark.err} />
          </div>
        }
        action={dnt ? "Do not touch" : "Done"}
        busy={mark.busy}
        onConfirm={() => mark.markSide(side.key, dnt ? "doNotTouch" : "done")}
        onClose={() => setStep("menu")}
      />
    );
  }
  return (
    <Sheet open onClose={onClose} title={side.label}>
      <div className="space-y-4 pb-2">
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2 p-3 sm:grid-cols-4">
          <div className="col-span-2">
            <Fact label="Area">{areaLabel ?? "None"}</Fact>
          </div>
          <Counts c={side.counts} />
        </div>
        <Actions open={open} onStep={setStep} reassign={false} />
      </div>
    </Sheet>
  );
};
// #endregion
