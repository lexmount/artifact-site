# Comment P0/P1 acceptance

Baseline: PR #170, master `8aafbec`. This pass covers mobile interaction,
accessibility, large discussions, and the Agent image-feedback workflow.
It does not add notifications, mentions, compression of oversized source uploads,
or change attachment quotas, storage, permissions, or schema.

## Fixes

- Keep the small image thumbnails, but provide 44px preview/remove targets on
  coarse pointers and place removal beside the preview instead of over it.
- Fetch authorized image bytes only when their placeholders approach the viewport
  (160px margin). Preserve request cancellation, credential-dependent identity,
  private blob URLs, retry, and full-size previews. Give image controls a filename
  description for assistive technology. Avoid announcing every image placeholder.
- Classify personal-token result associations as Agent operations, like OAuth.
  Preserve the accountable user's identity and record the correct actor kind in
  both the result association and audit event. Browser sessions remain user actions.
  Historical audit rows are not rewritten.

## Automated acceptance

| Area | Coverage | Limit |
| --- | --- | --- |
| Mobile | 320/390px layouts, coarse-pointer targets without overlap, saved image drafts, upload retry/cancel, dialog bounds, keyboard viewport inset simulation | Chromium emulation, not a physical keyboard/native selection menu |
| Keyboard | Open image with Enter, close with Escape, return focus to the thumbnail; existing discussion/menu focus restoration | Does not certify screen-reader announcements |
| Image performance | 12 image replies; offscreen images stay unfetched, first/last become available after scrolling | Already loaded blobs remain until unmount; this is not virtualization |
| Discussion volume | 180 discussions, 3 versions, 3 sharing contexts; 30→60 pagination, unique IDs, refresh retains scroll, historical keyword search | Local fixture, not a production throughput benchmark |
| Reading stability | Existing unread/reply/search/reaction concurrency and stale-response regressions | No event push added; polling still refreshes the loaded window |
| Agent | Actual HTTP MCP: list/read scoped feedback and image → historical source → same-site version update → result association; verify revision conflict, permission rejection, unchanged original scope/status, Agent audit identity | Tests the tool contract and data, not a model's visual interpretation |
| Isolation | Existing attachment/link revocation and wrong-link access tests; PostgreSQL RBAC/comment suite | No broader visibility granted |

The browser tests write screenshots and local fixture measurements to
`output/acceptance/`. The directory is deliberately not checked into source control.
Run against a production build and isolated PostgreSQL using `COMMENTS_E2E_URL`
and `COMMENTS_E2E_DATA`, as documented at the top of
`test/comments-browser.e2e.test.ts`. Restart the isolated server between full
suite runs so accumulated fixture writes do not exhaust its rate-limit bucket.

Local sample: first page in 197ms for 180 threads; visiting the first and last
image in the 12-image discussion fetched 2 images. These are local observations,
not latency guarantees.

## Release checks that remain manual

These are **not marked passed** by browser emulation:

1. Physical iPhone Safari and Android Chrome: long-press/drag selection in HTML
   and selectable PDF, native copy-menu coexistence, comment entry reachable.
2. Real software keyboard: type, rotate, dismiss/reopen, scroll long drafts,
   attach/retry images; close/send controls remain reachable without losing text.
3. VoiceOver/TalkBack: labels, dialog announcement and focus, emoji/menu operation,
   upload failure announcements; test enlarged system text and landscape.

Record device/OS/browser, steps, and a screenshot or recording for failures.
The available desktop environment does not establish physical-device coverage.

## Follow-up thresholds

- Measure production list latency and request volume before changing polling or
  adding list virtualization; loaded-window refresh cost still grows with pages.
- Consider thumbnail derivatives if authorized full-image reads remain costly after
  viewport deferral. Keep full-resolution access authenticated.
- Keep notifications, mentions, and subscription semantics in a separate design.

## iPhone Mirroring follow-up

Verified on the connected physical iPhone through Mirroring (2026-09-21):

- LAN HTTP initially reached the app but triggered Next's client error boundary.
  Comment preview initialization used secure-context-only `crypto.randomUUID`.
  The browser helper now generates RFC 4122 v4 IDs with `crypto.getRandomValues`
  when native UUID generation is unavailable; it never falls back to Math.random.
- After the fix, the artifact and aggregated comments loaded on the same phone.
- Created a whole-file test comment and verified it appeared after saving.
- Opened a reply, entered a draft, closed it, and verified the text on reopening.
- Opened the native image source menu (library / camera / files), then cancelled;
  no personal photos were accessed or uploaded.
- Entered location selection and selected the chart; the composer showed its file
  context and remained within the visible phone viewport.

Mirroring used hardware-keyboard input and showed only the accessory bar, not the
full software keyboard. Native long-press selection, VoiceOver, rotation and full
software-keyboard occlusion remain unverified. This narrows the remaining manual
checks; it does not replace them.

A browser regression disables native randomUUID and exercises preview handshake,
image attachment and comment submission. The fallback has separate unit coverage.

## User-assisted manual confirmation

After the Mirroring pass, the user reported that software-keyboard occlusion,
long-press selection and VoiceOver worked without issues. This is user-reported
acceptance, separate from the automated and directly observed Mirroring checks.
Android, rotation and enlarged system text were not separately confirmed.
