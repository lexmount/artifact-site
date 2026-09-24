# Comment mentions

Mentions reuse the discussion notification inbox and never grant access to an artifact,
version, or share. They are separate from subscriptions: an explicit mention can notify an
unfollowed participant, but cannot resubscribe them.

## Candidate policy

`MentionAudienceProvider` exposes candidate discovery and membership checks. The current
policy considers the site owner, permanent site members, and authors in the exact discussion
space (site + version + main/share ID). Candidates must also pass the shared comment reader
authorization check. No tenant directory, email address, or other share's participant list is
returned. Disabled users are excluded.

`mentionAudiencePolicy` is the future policy selection boundary. A recent-contacts or tenant
provider can be added there. Every provider remains subject to `mayMention` and current resource
permissions; broadening discovery must not broaden resource access.

The candidate endpoint checks the caller's session and discussion access without acquiring the
global RBAC mutation lock. Discovery returns labels with IDs and checks at most 20 distinct
candidates per query; refine the search if the relevant person is outside that bound. Before
that limit, share discovery excludes expired/revoked receipts and obsolete access revisions,
while retaining owners and site administrators. Canonical authorization still checks every
returned candidate. The API reports when discovery reaches its bounded budget, even if authorization removes
some candidates; the picker then prompts users to keep typing to narrow the list. It does
not repeat the provider membership query for its own search results. New and re-added
mentions are validated again inside the comment transaction. Retaining an already active mention
on an unrelated edit preserves historical attribution, even after the recipient loses access;
it neither sends another notification nor grants access. Removing and re-adding it requires
fresh authorization. Inbox reads and navigation always enforce current permissions. A share participant needs a live,
version-scoped access receipt or independent management access; neither a mention nor a
notification creates one.

## Storage and delivery

- `comment_messages.rich_content.mentions`: user ID, display label, and UTF-16 start/end offsets
  into the trimmed body. Typing an arbitrary `@name` does not create a mention identity.
- `comment_mentions`: message/user relationship with creation and removal timestamps. Removal
  retains a tombstone to avoid notifying again on repeated remove/re-add edits.
- `notification_events`: accepts mention events as well as reply events. Reply mentions reuse
  the reply event; a recipient who follows and is mentioned receives one inbox row.
- `user_notifications.reason`: distinguishes an explicit mention from a followed reply. Existing
  read state is preserved when reasons overlap. The actor is never notified about their own action.

Migration 0013 preserves event IDs, inbox IDs, timestamps and read state while extending the
event-kind constraint. Its table replacement runs within the existing migration transaction;
SQLite and PostgreSQL use the same data-preserving sequence. PostgreSQL retains the
`notification_events_next_*` and `user_notifications_next_*` constraint/index names after the
rename; subsequent migrations must account for those names. Migration 0013 is already shared
and its SQL is not rewritten. Comment deletion and access loss
continue to use the inbox's existing content redaction and navigation checks.

## Editor behavior

The toolbar's @ button and typing @ open a searchable, keyboard-operable picker. Selecting a
person inserts a visible label and stores its identity separately. Editing inside that label
removes the identity; edits outside it move its offsets. Drafts retain this metadata. Changing
posting destinations does not authorize old mentions in the new space: sending rechecks them.

This release does not expose tenant-wide candidate settings, email/push delivery, bulk mentions,
or automatic permission grants.

Mention event insertion also handles a concurrent `(type, message_id)` conflict by returning
the existing event ID without replacing its identity or timestamps. Recipient upserts retain
read state. The normal write transaction still serializes comment mutations.
