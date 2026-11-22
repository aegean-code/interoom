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

Implemented locally on `feat/private-messaging`; production is unchanged.

Files:
- `src/messaging.jsx`, `src/messaging-api.js`, `src/messaging.css`: inbox/thread, participant search, reliable retries, read receipts, owner deletion, blocking/reporting, privacy preferences, presence and responsive navigation.
- `src/main.jsx`, `src/community.js`, `src/routing.js`: integration and optional unique usernames; conversation URLs survive refresh.
- `supabase/migrations/20261121180814_private_messaging.sql`: seven additive tables (six public RLS tables and private reported-message evidence), optional username column, guarded RPCs, rate limits and Realtime publication entries. No existing content is rewritten. Apply this migration **before** deploying the frontend that selects `profiles.username`.
- `tests/messaging.test.js`, `tests/messaging-client.test.js`: actual PostgreSQL permission/behavior tests plus client retry/event/route checks.
- `tests/browser/`: reproducible local two-account browser harness; excluded from the production build.

Validation on 2026-11-22:
- `npm test`: 34 passing tests, including existing posts/admin/routing regressions.
- `npm run build`: passes with public environment configuration. Existing large-bundle warning remains (approximately 535 kB main chunk).
- Local browser: two-way sending, immediate inbox updates/unread indicator, read receipts, history after refresh, mutual blocking/unblocking, reporting, deletion propagated to the peer, opt-in online status and 390px mobile layout checked. No horizontal overflow at 375px content width.
- Browser harness uses real SQL and components with a local event bus; hosted Supabase Realtime and real-account authentication have **not** yet been verified.

Release gates:
1. Save the tested checkpoint in a draft PR.
2. Apply the additive migration after reviewing current production schema; never seed production fixture users/messages.
3. Verify live delivery and refresh with two user-controlled registered accounts, including unread badges and access denial for a third account.
4. Merge/deploy only after those checks pass. Keep the additive schema if a frontend rollback is needed; do not delete message records.

Profile images currently use initials, matching existing accounts. Uploaded profile pictures remain part of Priority 4. Reports retain only the reported message and reason in private storage; the moderator review interface is part of Priority 5.

## Known blockers / pending verification

- Email delivery is NOT confirmed fixed. Resend `auth.interoom.org` domain was prepared; DNS verification and Supabase SMTP configuration are pending. Auth error/resend improvements are retained in draft PR #4. Do not claim reliable delivery until real inbox/callback tests pass.
- Google OAuth configuration needs inspection under Priority 3.
- Live private-message verification needs two user-controlled authenticated accounts; never extract sessions or credentials from the browser.
- Existing Supabase advisories: private tables deliberately deny direct access; legacy guarded public definer RPCs; `rls_auto_enable()` execute grants and leaked-password protection warrant later review. Do not broaden this batch into unrelated changes.

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
