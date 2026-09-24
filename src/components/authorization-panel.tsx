"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale-provider";
import { managementReasonHeaders } from "@/lib/management-reason";
type Resource = {
  type: "site" | "tenant";
  id: string;
};
type Subject = {
  type: "user" | "tenant" | "everyone";
  id?: string;
};
type Binding = {
  id: string;
  subject: Subject;
  subjectName: string | null;
  roleId: string;
  revision: number;
  canEdit: boolean;
};
type Candidate = {
  id: string;
  name?: string;
  display_name?: string;
  email?: string;
};
const labels: Record<string, string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
  "site-admin": "Site administrator",
  "tenant-admin": "Workspace administrator",
};
const descriptions: Record<string, string> = {
  viewer: "Read current and official versions. No source download or history.",
  commenter:
    "Read current and official versions and comment when comments are enabled.",
  editor: "Edit content, read history and download source files.",
  "site-admin":
    "Manage content, sharing and ordinary grants. Cannot transfer ownership or appoint administrators.",
  "tenant-admin":
    "Manage workspace members and administer its sites with a recorded reason.",
};
export async function authorizationFetch<T>(
  path: string,
  reason: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...managementReasonHeaders(reason),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || String(response.status));
  return data;
}
export default function AuthorizationPanel({
  resource,
  reason = "",
}: {
  resource: Resource;
  reason?: string;
}) {
  const t = useT();
  const [bindings, setBindings] = useState<Binding[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Binding | null>(null);
  const [subjectType, setSubjectType] = useState<Subject["type"]>("user");
  const [subjectId, setSubjectId] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [roleId, setRoleId] = useState("");
  const [opened, setOpened] = useState(false);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const params = new URLSearchParams({
    resourceType: resource.type,
    resourceId: resource.id,
  }).toString();
  const load = useCallback(async () => {
    const data = await authorizationFetch<{
      bindings: Binding[];
      nextCursor: string | null;
    }>(`/api/authorization/bindings?${params}`, reason);
    setBindings(data.bindings);
    setNextCursor(data.nextCursor);
  }, [params, reason]);
  useEffect(() => {
    let alive = true;
    authorizationFetch<{
      bindings: Binding[];
      nextCursor: string | null;
    }>(`/api/authorization/bindings?${params}`, reason)
      .then((data) => {
        if (alive) {
          setBindings(data.bindings);
          setNextCursor(data.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [params, reason]);
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    void Promise.all([
      authorizationFetch<{
        roles: {
          id: string;
        }[];
      }>(
        `/api/authorization/roles?${params}&subjectType=${subjectType}`,
        reason,
      ),
      subjectType === "everyone"
        ? Promise.resolve({ subjects: [] as Candidate[], nextCursor: null })
        : authorizationFetch<{
            subjects: Candidate[];
            nextCursor?: string | null;
          }>(
            `/api/authorization/subjects?${params}&type=${subjectType}&q=${encodeURIComponent(query)}`,
            reason,
          ),
    ])
      .then(([catalog, subjects]) => {
        if (!alive) return;
        setRoles(catalog.roles.map((r) => r.id));
        setCandidates(subjects.subjects);
        setCandidateCursor(subjects.nextCursor ?? null);
        if (subjectType === "tenant")
          setSubjectId(subjects.subjects[0]?.id ?? "");
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [opened, params, reason, subjectType, query]);
  async function more(subjects = false) {
    setBusy(true);
    try {
      if (subjects) {
        const data = await authorizationFetch<{
          subjects: Candidate[];
          nextCursor: string | null;
        }>(
          `/api/authorization/subjects?${params}&type=user&q=${encodeURIComponent(query)}&cursor=${candidateCursor}`,
          reason,
        );
        setCandidates((current) => [...current, ...data.subjects]);
        setCandidateCursor(data.nextCursor);
      } else {
        const data = await authorizationFetch<{
          bindings: Binding[];
          nextCursor: string | null;
        }>(
          `/api/authorization/bindings?${params}&cursor=${nextCursor}`,
          reason,
        );
        setBindings((current) => [...(current ?? []), ...data.bindings]);
        setNextCursor(data.nextCursor);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  function open(binding: Binding | null) {
    setRoles([]);
    setCandidates([]);
    setEditing(binding);
    setSubjectType(binding?.subject.type ?? "user");
    setSubjectId(binding?.subject.id ?? "");
    setRoleId(binding?.roleId ?? "");
    setQuery("");
    setError("");
    setOpened(true);
    dialog.current?.showModal();
  }
  function close() {
    if (busy) return;
    dialog.current?.close();
    setOpened(false);
  }
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      const subject =
        subjectType === "everyone"
          ? { type: subjectType }
          : { type: subjectType, id: subjectId };
      await authorizationFetch(
        `/api/authorization/bindings${editing ? `/${editing.id}` : ""}`,
        reason,
        remove ? "DELETE" : editing ? "PATCH" : "POST",
        editing
          ? {
              expectedRevision: editing.revision,
              ...(!remove ? { roleId } : {}),
            }
          : { resource, subject, roleId },
      );
      await load();
      dialog.current?.close();
      setOpened(false);
      setNotice(t(remove ? "Authorization revoked" : "Authorization saved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="authorization-panel">
      <div className="authorization-heading">
        <h3>{t("Authorization")}</h3>
        <button className="btn" onClick={() => open(null)}>
          {t("Add authorization")}
        </button>
      </div>
      <p className="drawer-note">
        {t(
          "Permissions from multiple grants add together. Visibility, ownership and share links are managed separately.",
        )}
      </p>
      {notice && <p role="status">{notice}</p>}
      {!opened && error && (
        <p className="drawer-error" role="alert">
          {error}
        </p>
      )}
      {bindings === null ? (
        <p>{t("Loading…")}</p>
      ) : bindings.length === 0 ? (
        <p className="authorization-empty">
          {t(
            "No direct grants. Owners and administrators retain their existing authority.",
          )}
        </p>
      ) : (
        <ul className="authorization-list">
          {bindings.map((binding) => (
            <li key={binding.id}>
              <div>
                <strong>
                  {binding.subject.type === "everyone"
                    ? t("Everyone (including other workspaces)")
                    : binding.subjectName || binding.subject.id}
                </strong>
                <small>
                  {t(
                    binding.subject.type === "tenant"
                      ? "All members of this workspace"
                      : binding.subject.type === "everyone"
                        ? "Anonymous visitors can only read"
                        : "Individual member",
                  )}
                </small>
              </div>
              <span>{t(labels[binding.roleId] ?? binding.roleId)}</span>
              <button
                className="btn"
                disabled={!binding.canEdit}
                onClick={() => open(binding)}
              >
                {t("Edit")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button className="btn" disabled={busy} onClick={() => void more()}>
          {t("Load more")}
        </button>
      )}
      <dialog
        ref={dialog}
        className="authorization-dialog"
        aria-label={t(editing ? "Edit authorization" : "Add authorization")}
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setOpened(false);
        }}
        onClose={() => setOpened(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="authorization-heading">
            <h3>{t(editing ? "Edit authorization" : "Add authorization")}</h3>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={close}
            >
              {t("Close")}
            </button>
          </div>
          {error && (
            <p className="drawer-error" role="alert">
              {error}
            </p>
          )}
          <label>
            {t("Who receives access?")}
            <select
              disabled={!!editing || busy}
              value={subjectType}
              onChange={(e) => {
                setRoles([]);
                setCandidates([]);
                setSubjectType(e.target.value as Subject["type"]);
                setSubjectId("");
                setRoleId("");
              }}
            >
              <option value="user">{t("Individual member")}</option>
              {resource.type === "site" && (
                <>
                  <option value="tenant">
                    {t("All members of this workspace")}
                  </option>
                  <option value="everyone">
                    {t("Everyone (including other workspaces)")}
                  </option>
                </>
              )}
            </select>
          </label>
          {subjectType === "user" && !editing && (
            <>
              <label>
                {t("Find workspace member")}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("Name or email")}
                />
              </label>
              <label>
                {t("Member")}
                <select
                  required
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                >
                  <option value="">{t("Select a member")}</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name || c.email || c.id}
                    </option>
                  ))}
                </select>
              </label>
              {candidateCursor && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void more(true)}
                >
                  {t("Load more")}
                </button>
              )}
            </>
          )}
          {editing && (
            <p>{editing.subjectName || editing.subject.id || t("Everyone")}</p>
          )}
          <label>
            {t("Role")}
            <select
              required
              disabled={busy}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">{t("Select a role")}</option>
              {roles.map((id) => (
                <option key={id} value={id}>
                  {t(labels[id] ?? id)}
                </option>
              ))}
            </select>
          </label>
          {roleId && (
            <p className="drawer-note">{t(descriptions[roleId] ?? roleId)}</p>
          )}
          {subjectType === "everyone" && (
            <p className="share-warn">
              {t(
                "This includes people outside your workspace. Commenting and editing require sign-in. Anonymous visitors can only read.",
              )}
            </p>
          )}
          <div className="authorization-actions">
            {editing && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void save(true)}
              >
                {t("Revoke authorization")}
              </button>
            )}
            <button
              type="submit"
              className="btn primary"
              disabled={
                busy ||
                !roles.includes(roleId) ||
                (subjectType !== "everyone" && !subjectId)
              }
            >
              {t(busy ? "Saving…" : "Save")}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
