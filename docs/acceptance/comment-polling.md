# Comment polling acceptance

## Scope

Reduce redundant client requests without changing APIs, schema, comment permissions,
read tracking, list order, draft persistence, or attachment storage.

- List polling is completion-based: unchanged successful snapshots increase the
  interval from 10 to 20 to 30 seconds. Changed content and local mutations reset
  the delay used when scheduling the next timer; an already armed timer is retained. Existing immediate mutation refreshes remain in place.
- A hidden page schedules no list or unread polling timer. An already running
  request may finish. Returning to the foreground refreshes without waiting for
  the idle interval; adjacent focus/visibility events are coalesced.
- Closing the panel, composer and markers stops list polling. Existing unread
  checks remain separate (15 seconds open, 60 seconds closed).
- Existing failure backoff, stale-response guards, reading-order preservation,
  and read-receipt behavior remain in place.

## Verification

- Fake-timer tests cover idle/change/interaction cadence, hidden mounting,
  suspension, foreground event coalescing, slow requests and cleanup.
- Production Chromium + PostgreSQL acceptance counts actual API requests over
  real time: two idle list polls in 40 seconds, no requests during 16 hidden
  seconds, one foreground list/unread refresh, and no list refresh after closing.
  The test controls `document.hidden` and dispatches visibility events; this is
  scheduler verification, not a physical-device background lifecycle test.
- Existing browser regression scenarios cover posting, replies, reactions,
  drafts, search, pagination, read tracking, permissions, and HTML/PDF anchors.

No incremental feed, push transport, image derivatives, or virtualization is
introduced. Large expanded lists are still revalidated in full. Inactive visible
panels may discover remote changes up to roughly 30 seconds later, plus network
latency; failures retain the existing longer retry backoff.
