"use client";
import { useId } from "react";
import { useT } from "@/components/locale-provider";
import { AUDIENCE_LABELS, type SharingPolicy } from "@/lib/sharing-policy";
export function PolicySummary({ policy }: { policy: SharingPolicy }) {
  const t = useT();
  return (
    <>
      {t(AUDIENCE_LABELS[policy.audience])}
      {policy.audience !== "private" && <> · {t(policy.comments ? "Can comment" : "Can view")}</>}
    </>
  );
}
export default function PolicyFields({
  value,
  onChange,
  disabled = false,
  includePublic = false,
}: {
  value: SharingPolicy;
  onChange: (p: SharingPolicy) => void;
  disabled?: boolean;
  includePublic?: boolean;
}) {
  const t = useT(),
    id = useId();
  return (
    <div className="scope-policy-fields">
      <label htmlFor={id}>{t("Who can access")}</label>
      <select
        id={id}
        value={value.audience}
        disabled={disabled}
        onChange={(e) =>
          onChange({
            ...value,
            audience: e.target.value as SharingPolicy["audience"],
          })
        }
      >
        {(
          [
            "private",
            "tenant",
            "login",
            "anyone",
            ...(includePublic || value.audience === "public" ? ["public"] : []),
          ] as SharingPolicy["audience"][]
        ).map((a) => (
          <option key={a} value={a}>
            {t(AUDIENCE_LABELS[a])}
          </option>
        ))}
      </select>
      {value.audience === "tenant" && (
        <p>
          {t("Each document is visible only to members of its own tenant.")}
        </p>
      )}
      {value.audience === "login" && (
        <p>{t("Includes signed-in accounts from other tenants.")}</p>
      )}
      <div className="scope-toggle">
        <label htmlFor={id + "comments"}>{t("Allow comments")}</label>
        <input
          id={id + "comments"}
          role="switch"
          type="checkbox"
          checked={value.comments}
          disabled={disabled || value.audience === "private"}
          onChange={(e) => onChange({ ...value, comments: e.target.checked })}
        />
      </div>
      <p>
        {t(
          value.comments
            ? "Readers can see comments. Sign in to post."
            : "New comments and replies are paused. Existing discussions remain readable.",
        )}
      </p>
    </div>
  );
}
