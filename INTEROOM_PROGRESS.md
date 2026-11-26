# Interoom development progress

## Current baseline — 2026-11-22 (Asia/Bishkek)

Existing React 19 / Vite app on Vercel, Supabase Auth/Postgres/Realtime. Continue the existing application and preserve production records.

Completed and deployed before this batch:
- Posts author relationship fix (PR #5).
- Admin registered-user directory, including unfinished accounts; 18 tests passed (PR #6, main `83d8262`).
- Existing globe favicon and public room chat. Do not rebuild these features.

## Priority 1 — private messaging deployed

Branch: `feat/private-messaging`.
- Reuse Supabase session, profiles, sidebar navigation, existing visual identity and error/empty-state conventions.
- Add participant-only conversations/messages, idempotent sending, read receipts, unread counts, owner deletion, blocking, reporting and opt-in online status.
- All schema changes additive. No production test users or artificial engagement.
- Permissions and message history were tested with disposable local PostgreSQL accounts. Hosted two-account delivery has not been tested; the owner explicitly approved releasing without that check on 2026-11-22.

## Validation and release

Release source: PR #8 (notifications) was merged into PR #7 (private messaging), and PR #7 was merged into main as `515075e` on 2026-11-22. Vercel completed the production deployment and the existing Interoom domains serve the release. Both additive database migrations have been applied without rewriting existing community content.

Production smoke check: the community landing page and new Messages navigation render successfully, and signed-out visitors see the private-message sign-in gate. The signed-in notification behavior was validated in the isolated browser harness; hosted two-account delivery remains untested as documented below. No additional account or live test message was needed for release.

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
- Hosted bidirectional delivery and refresh remain unverified. Per the owner’s 2026-11-22 instruction, this is documented as a test limitation and does not block release. No production messages were created during the checks.

Current limitations:
- Profile images use initials; uploads are part of Priority 4.
- Report evidence is stored privately; the moderator review interface is part of Priority 5.
- Authentication email delivery remains unverified. The auth improvements are retained in draft PR #4 pending configuration and real delivery/callback checks.
- Google sign-in inspection is part of Priority 3.

## Priority 2 — notifications deployed

Branch: `feat/notifications`, based on the private-messaging branch. Implemented in PR #8: https://github.com/aegean-code/interoom/pull/8.

Implemented:
- Notification bell, red unread count, persistent history, individual/read-all controls and links opening the correct conversation or post.
- Database-triggered private-message, reply, reaction and username-mention notifications. DM notices are grouped per conversation and contain no message body; duplicate actions and self-notifications are suppressed.
- Notification rate limits and a five-recipient mention limit. Blocked actors are suppressed.
- Separate post/chat unread counts in room navigation, starting with new activity after rollout. Read markers advance only through loaded entries.
- Recipient-only RLS and server-controlled mutation functions. Stale single-item read requests cannot clear newer activity; mark-all uses a server snapshot.

Files: `src/notifications*.js*`, `src/notifications.css`, existing navigation/feed/routing integration, `tests/notifications*.test.js`, post deep-link regression and the browser harness.

Migration: `supabase/migrations/20261122053858_notifications.sql` adds notifications, room activity metadata, room read markers and guarded triggers/RPCs. This migration has been applied to production. No historical content is backfilled.

Validation: all 48 automated tests pass, including permission, deduplication, mention, rate-limit, pagination, read-state, room-counter and existing-feature checks. Production build and diff whitespace checks pass; the large-bundle warning remains. Browser checks cover immediate badges, refresh persistence, individual/read-all controls and opening a DM from its notification. The notification panel also passed the 390px mobile check with no horizontal overflow. The preview and production builds completed successfully. Production release used the automated tests and isolated browser checks, without requiring a second live account.

Not yet included: friend-request/acceptance notifications depend on Priority 4; followed-community preferences depend on Priority 8. Current rooms use navigation counters. Profile images still use initials until profile uploads exist. Hosted two-account Realtime verification is an outstanding optional check, not a release gate.

## Priority 3 — authentication prepared, configuration pending

Draft PR #4 (`fix/auth-email-delivery`) has been brought up to date with the deployed messaging and notification changes.

Implemented:
- Safe authentication errors, verification resends and a shared 60-second email request cooldown, including duplicate-request protection.
- Separate recovery, verification and Google callback handling, including expired links and failed callbacks when an older session remains valid.
- Continue with Google using the existing Supabase Auth client and PKCE. The button is shown only when the project's public settings report Google enabled. Google display names can prefill profile setup.
- No Resend or Google client secret is exposed to the frontend. Accounts, messages and existing database records are unchanged.

Validation: all 67 automated tests and the production build passed on 2026-11-25. Tests use disposable local databases or a mocked Auth transport; no live email or production test records were created. Browser checks covered auth form navigation and hidden Google controls while the provider is disabled. The existing large-bundle warning remains.

Remaining release gates: verify the Resend sending domain, create a domain-restricted sending credential, configure Supabase SMTP and confirm real verification/reset delivery. Configure the Google OAuth client, provider and exact callback allowlist, then validate a real Google sign-in. Dashboard access and credential setup are still pending; the frontend alone does not fix the production email quota. See `docs/auth-email-rollout.md` for setup and release checks.

2026-11-26 setup check: Resend reports that all required DNS records are missing. Registrar sign-in still needs to complete before those records can be added. No sending credential has been created and no production authentication settings have been changed. Code and validation are saved in PR #4; production remains on the existing release.

Files: `src/auth.js`, `src/main.jsx`, `src/style.css`, `public/google-g.png`, `tests/auth.test.js`, and the rollout guide. No new migration is required.

## Next priorities

3. Authentication verification, Resend completion and Google sign-in preparation.
4. Friends and richer profiles/discovery.
5. Student verification and moderation.
6. Navy/blue visual refresh while preserving globe branding.
7. Aggregated admin analytics.
8. Community memberships and richer post interactions.
9. Map, founding badges, language exchange and events.

Update this file after each tested commit with files, migrations, results and any required user action.
