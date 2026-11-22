# Interoom development progress

## Current baseline — 2026-11-22 (Asia/Bishkek)

Existing React 19 / Vite app on Vercel, Supabase Auth/Postgres/Realtime. Continue the existing application and preserve production records.

Completed and deployed before this batch:
- Posts author relationship fix (PR #5).
- Admin registered-user directory, including unfinished accounts; 18 tests passed (PR #6, main `83d8262`).
- Existing globe favicon and public room chat. Do not rebuild these features.

## Active batch: Priority 1 — private messaging

Branch: `feat/private-messaging`.
- Reuse Supabase session, profiles, sidebar navigation, existing visual identity and error/empty-state conventions.
- Add participant-only conversations/messages, idempotent sending, read receipts, unread counts, owner deletion, blocking, reporting and opt-in online status.
- All schema changes additive. No production test users or artificial engagement.
- Test permissions and history with disposable local PostgreSQL accounts, then verify live Realtime with two controlled registered accounts before declaring end-to-end completion.

## Validation and release

Private messaging implementation is saved in draft PR #7. The additive migration has been applied; the new frontend has not been released to production.

Files:
- `src/messaging.jsx`, `src/messaging-api.js`, `src/messaging.css`: inbox/thread, member search, send retries, read receipts, deletion, blocking/reporting, presence preferences and responsive navigation.
- `src/main.jsx`, `src/community.js`, `src/routing.js`: integration, optional usernames and conversation URLs.
- `supabase/migrations/20261121180814_private_messaging.sql`: additive messaging tables, participant access controls, guarded RPCs, rate limits and Realtime publication entries. Apply before deploying the frontend that selects `profiles.username`.
- `tests/messaging.test.js`, `tests/messaging-client.test.js`, `tests/browser/`: database/client tests and an isolated browser harness excluded from production builds.

Validation:
- 34 automated tests pass, including existing posts/admin/routing checks.
- Production build passes; a large-bundle warning remains.
- Local browser checks passed for two-way sending, inbox/unread updates, read receipts, refresh persistence, block/unblock, reporting, peer deletion updates, opt-in presence and 390px mobile layout.
- The local harness uses real SQL and components with a substitute event bus. A live session connected successfully and member search was verified.
- A second controlled session is still needed to verify hosted bidirectional delivery and refresh before merging. No production messages were created during the checks.

Current limitations:
- Profile images use initials; uploads are part of Priority 4.
- Report evidence is stored privately; the moderator review interface is part of Priority 5.
- Authentication email delivery remains unverified. The auth improvements are retained in draft PR #4 pending configuration and real delivery/callback checks.
- Google sign-in inspection is part of Priority 3.

## Priority 2 batch — notifications

Branch: `feat/notifications`, based on the private-messaging branch.

Implemented:
- Notification bell, red unread count, persistent history, individual/read-all controls and links opening the correct conversation or post.
- Database-triggered private-message, reply, reaction and username-mention notifications. DM notices are grouped per conversation and contain no message body; duplicate actions and self-notifications are suppressed.
- Notification rate limits and a five-recipient mention limit. Blocked actors are suppressed.
- Separate post/chat unread counts in room navigation, starting with new activity after rollout. Read markers advance only through loaded entries.
- Recipient-only RLS and server-controlled mutation functions. Stale single-item read requests cannot clear newer activity; mark-all uses a server snapshot.

Files: `src/notifications*.js*`, `src/notifications.css`, existing navigation/feed/routing integration, `tests/notifications*.test.js`, post deep-link regression and the browser harness.

Migration: `supabase/migrations/20261122053858_notifications.sql` adds notifications, room activity metadata, room read markers and guarded triggers/RPCs. This migration has NOT been applied to production. No historical content is backfilled.

Validation: all 48 automated tests pass, including permission, deduplication, mention, rate-limit, pagination, read-state, room-counter and existing-feature checks. Production build and diff whitespace checks pass; the large-bundle warning remains. Browser checks cover immediate badges, refresh persistence, individual/read-all controls and opening a DM from its notification. The notification panel also passed the 390px mobile check with no horizontal overflow. This batch is ready for a draft PR, not production release.

Not yet included: friend-request/acceptance notifications depend on Priority 4; followed-community preferences depend on Priority 8. Current rooms use navigation counters. Profile images still use initials until profile uploads exist. Hosted two-account Realtime verification remains a release gate.

## Next priorities

2. Realtime notifications and navigation badges, using recipient-only records and no private-message previews in analytics.
3. Authentication verification, Resend completion and Google sign-in preparation.
4. Friends and richer profiles/discovery.
5. Student verification and moderation.
6. Navy/blue visual refresh while preserving globe branding.
7. Aggregated admin analytics.
8. Community memberships and richer post interactions.
9. Map, founding badges, language exchange and events.

Update this file after each tested commit with files, migrations, results and any required user action.
