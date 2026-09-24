"use client";
import { useEffect, useId, useState, type RefObject } from "react";
import { useT } from "@/components/locale-provider";
import type { CommentScope } from "@/lib/comments/contracts";
import type { MentionCandidatePage } from "@/lib/comments/mention-types";
import { mentionTrigger } from "./mention-trigger";
import { commentRequest } from "./comment-client";
type Person = { userId: string; label: string };
export function MentionPicker({
  endpoint,
  scope,
  shareToken,
  textarea,
  disabled,
  onInsert,
}: {
  endpoint: string;
  scope: CommentScope;
  shareToken?: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  onInsert: (person: Person, start: number, end: number) => void;
}) {
  const t = useT(),
    id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<Person[]>([]),
    [status, setStatus] = useState(""),
    [active, setActive] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const detect = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      const end = input.selectionStart;
      const match = mentionTrigger(input.value, end);
      if (match) {
        setRange({ start: match.start, end });
        setItems([]);
        setActive(0);
        setStatus(t("Finding people…"));
        setQuery(match.query);
        setOpen(true);
      } else setOpen(false);
    };
    input.addEventListener("input", detect);
    input.addEventListener("compositionend", detect);
    return () => {
      input.removeEventListener("input", detect);
      input.removeEventListener("compositionend", detect);
    };
  }, [textarea, t]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        versionId: scope.versionId,
        q: query,
      });
      if (scope.entry.kind === "share")
        params.set("shareId", scope.entry.shareId);
      void commentRequest<MentionCandidatePage>(
        endpoint + "/mentions?" + params,
        shareToken,
      )
        .then((result) => {
          if (live) {
            setItems(result.items);
            setStatus(
              result.truncated
                ? t("Keep typing to narrow the list.")
                : result.items.length
                  ? ""
                  : t("No eligible people in this discussion."),
            );
          }
        })
        .catch(() => {
          if (live) setStatus(t("Could not load people. Try again."));
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    open,
    query,
    scopeKey,
    endpoint,
    shareToken,
    t,
    scope.versionId,
    scope.entry,
  ]);
  function choose(person: Person) {
    onInsert(person, range.start, range.end);
    setOpen(false);
  }
  return (
    <div className="comment-mention-picker">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-label={t("Mention someone")}
        onClick={() => {
          const input = textarea.current;
          if (!input) return;
          setRange({ start: input.selectionStart, end: input.selectionEnd });
          setItems([]);
          setActive(0);
          setStatus(t("Finding people…"));
          setQuery("");
          setOpen((value) => !value);
        }}
      >
        @
      </button>
      {open && (
        <div
          className="comment-mention-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              textarea.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) =>
                Math.max(
                  0,
                  Math.min(
                    items.length - 1,
                    value + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (items[active]) choose(items[active]);
            }
          }}
        >
          <input
            autoFocus
            role="combobox"
            aria-label={t("Find someone to mention")}
            aria-controls={id}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? id + active : undefined}
            value={query}
            onChange={(event) => {
              setItems([]);
              setActive(0);
              setStatus(t("Finding people…"));
              setQuery(event.target.value);
            }}
            placeholder={t("Search by name")}
          />
          <div
            id={id}
            role="listbox"
            aria-label={t("People in this discussion")}
          >
            {items.map((person, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                id={id + index}
                key={person.userId}
                onClick={() => choose(person)}
              >
                <span aria-hidden="true" className="comment-mention-avatar">
                  {Array.from(person.label)[0]}
                </span>
                <span>{person.label}</span>
              </button>
            ))}
          </div>
          {status && <small role="status">{status}</small>}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              textarea.current?.focus();
            }}
          >
            {t("Cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
