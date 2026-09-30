import { Button, ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { phoneText, since } from "../../components/crew/format.ts";
import { DirectionsIcon, MegaphoneIcon, PhoneIcon, PinIcon, TextIcon } from "../../components/crew/Icons.tsx";
import { Skeleton } from "../../components/crew/Skeleton.tsx";
import { useNow } from "../../components/crew/useNow.ts";
import { Page } from "../../components/Page.tsx";
import { clock, mapsDirections, smsHref, telHref } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const Broadcast = () => {
  const q = trpc.shared.latestBroadcast.useQuery(undefined, { refetchInterval: 60_000 });
  const now = useNow(60_000);
  const b = q.data;
  if (!b) return null;
  return (
    <section aria-label="Latest broadcast" className="rounded-2xl bg-brand p-4 text-on-brand">
      <div className="flex items-start gap-3">
        <MegaphoneIcon size={24} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-lg leading-snug font-semibold break-words whitespace-pre-line">{b.body}</p>
          <p className="mt-1 text-sm opacity-80">
            {b.sentBy ? `${b.sentBy}, ` : ""}
            {clock(b.at)}, {since(b.at, now)}
          </p>
        </div>
      </div>
    </section>
  );
};

export const CcPage = () => {
  const q = trpc.shared.ccCard.useQuery(undefined, { staleTime: 5 * 60_000 });

  if (q.isLoading)
    return (
      <Page title="Command center">
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </Page>
    );
  if (q.isError || !q.data)
    return (
      <Page title="Command center">
        <EmptyState
          title="Command center not loaded"
          action={
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      </Page>
    );

  const { cc, day, greenShirts } = q.data;
  return (
    <Page title={`CC ${cc.name}`}>
      <div className="space-y-5">
        <Broadcast />

        <section aria-label="Location" className="rounded-2xl bg-surface p-4 ring-1 ring-line">
          <div className="flex items-start gap-3">
            <PinIcon size={24} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="text-lg leading-snug font-semibold break-words">{cc.address?.trim() || `CC ${cc.name}`}</p>
              {day && <p className="text-sm text-muted">{day.label}</p>}
            </div>
          </div>
          {cc.notes?.trim() && <p className="mt-3 text-base break-words whitespace-pre-line">{cc.notes}</p>}
          <ButtonLink href={mapsDirections(cc.lat, cc.lng)} size="lg" block className="mt-4">
            <DirectionsIcon size={22} />
            Directions
          </ButtonLink>
        </section>

        <section aria-labelledby="greens" className="space-y-3">
          <h2 id="greens" className="text-sm font-bold tracking-wide text-muted uppercase">
            Green shirts
          </h2>
          {greenShirts.length === 0 ? (
            <p className="rounded-2xl bg-surface-2 px-4 py-5 text-center font-semibold text-muted">No green shirts listed</p>
          ) : (
            <ul className="space-y-3">
              {greenShirts.map((g) => (
                <li key={g.id} className="rounded-2xl bg-surface p-3 ring-1 ring-line">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-lg font-bold break-words">{g.name}</p>
                    {g.roleLabel && <p className="text-sm text-muted">{g.roleLabel}</p>}
                  </div>
                  {g.phone ? (
                    <>
                      <p className="text-base text-muted tabular-nums">{phoneText(g.phone)}</p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <ButtonLink href={telHref(g.phone)} size="lg">
                          <PhoneIcon size={22} />
                          Call
                        </ButtonLink>
                        <ButtonLink href={smsHref(g.phone)} size="lg" variant="secondary">
                          <TextIcon size={22} />
                          Text
                        </ButtonLink>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted">No phone</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
};
