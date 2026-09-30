import { ButtonLink } from "../Button.tsx";
import { smsHref, telHref } from "../../lib/format.ts";
import { PhoneIcon, TextIcon } from "./ui.tsx";

/** Call and Text side by side. Nothing renders without a phone number. */
export const ContactButtons = ({ phone, who }: { phone: string | null; who: string }) => {
  if (!phone) return <p className="text-sm font-semibold text-muted">No phone</p>;
  return (
    <div className="grid grid-cols-2 gap-2">
      <ButtonLink href={telHref(phone)} variant="secondary" size="md">
        <PhoneIcon />
        Call
        <span className="sr-only">{who}</span>
      </ButtonLink>
      <ButtonLink href={smsHref(phone)} variant="secondary" size="md">
        <TextIcon />
        Text
        <span className="sr-only">{who}</span>
      </ButtonLink>
    </div>
  );
};
