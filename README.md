# Interoom

International student discussions and room chat. React + Vite, Supabase Auth/Postgres/Realtime. Existing Interoom branding and purple styling are preserved. There are no seeded users, conversations, reactions, or invented activity counts.

## Development

Use Node 22 or newer. Run `npm ci`, copy `.env.example` to `.env.local`, set the Supabase URL and publishable key, then `npm run dev`. Never put a service-role or secret key in a VITE variable. `npm test` covers URL routing; `npm run build` creates the production bundle.

## Database

`supabase/migrations/20261113000000_create_community.sql` creates profiles, rooms, posts, replies, reactions, messages and reports. Only the five room definitions are seeded. The migration was applied to the connected Interoom Supabase project. RLS restricts content to signed-in members, profile edits and content deletion to their owners, and reports to admin review through the dashboard. Chat uses Realtime with a periodic refresh fallback.

`tests/database.sql` validates ownership, anonymous denial, report privacy and cascade deletion inside a rolled-back transaction. Run only on a dedicated test database or an empty project before launch.

## Release checklist

- [x] Shared database, ownership rules, realtime publication.
- [x] Signup, confirmation-aware login, profile editing, password recovery UI.
- [x] Shared posts, replies, reactions, room messages and reports.
- [x] Remove demonstration people and content.
- [x] URL routing and browser back/reload behavior.
- [ ] Verify email delivery with a real test inbox; configure Supabase SMTP if necessary.
- [ ] In Supabase Auth URL configuration, add the exact protected preview origin and `/?reset=1` callback. Production Site URL should be `https://www.interoom.org`; allow callbacks on www and each approved room host.
- [ ] Complete signup, email confirmation, login, recovery and two-browser chat checks with real test accounts.
- [ ] Obtain owner approval before production release or DNS/domain changes.
- [ ] Configure production VITE variables, attach the five hosts to the existing Vercel project and verify DNS/TLS.
- [ ] Set VITE_ROOM_SUBDOMAINS=true only when the hosts resolve and callback URLs are allowed; rebuild.

Room hosts: general.interoom.org, study.interoom.org, careers.interoom.org, abroad.interoom.org, culture.interoom.org. Until enabled, previews use `?room=...&view=chat` on the same origin. Production sessions share cookies only across the known Interoom domain; preview sessions stay on their own host.

The initial feed loads 60 posts, a reply thread loads 100 replies and chat loads the latest 100 messages. Search filters loaded posts. Reporting records a private report for owner review; there is no staffed moderation service or automatic removal.
