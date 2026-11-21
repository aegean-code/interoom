# Interoom

International student discussions and room chat. React + Vite, Supabase Auth/Postgres/Realtime. Interoom branding is preserved with a quieter forum layout, warm neutral backgrounds and forest-green navigation and rust accents. There are no seeded users, conversations, reactions, or invented activity counts.

## Development

Use Node 22 or newer. Run `npm ci`, copy `.env.example` to `.env.local`, set the Supabase URL and publishable key, then `npm run dev`. Never put a service-role or secret key in a VITE variable. `npm test` covers routing, the posts query, and the admin directory's PostgreSQL permissions and pagination; `npm run build` creates the production bundle. Database tests use disposable local PGlite instances and never write to the production project.

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
- [x] Owner approved production publishing on 17 November 2026. Room DNS activation remains a separate rollout.
- [x] Configure production Supabase VITE variables for the existing Interoom Vercel project.
- [ ] Attach the five room hosts to the existing Vercel project and verify DNS/TLS.
- [ ] Set VITE_ROOM_SUBDOMAINS=true only when the hosts resolve and callback URLs are allowed; rebuild.

Room hosts: general.interoom.org, study.interoom.org, careers.interoom.org, abroad.interoom.org, culture.interoom.org. Until enabled, previews use `?room=...&view=chat` on the same origin. Production sessions share cookies only across the known Interoom domain; preview sessions stay on their own host.

The initial feed loads 60 posts, a reply thread loads 100 replies and chat loads the latest 100 messages. Search filters loaded posts. Reporting records a private report for owner review; there is no staffed moderation service or automatic removal.

## School ambassadors and admin access

The ambassador directory is at `/?view=ambassadors`; the management panel is at `/?view=admin`. Members can add their school to their profile. Only an admin can assign a school ambassador badge, change the represented school, or remove the role. Badges appear with posts, replies and chat messages. There are no seeded ambassadors.

`supabase/migrations/20261119000000_school_ambassadors.sql` adds the role tables and guarded RPCs. Admin membership is held in a private schema and must be provisioned by the project owner for a verified account; there is no client-side admin-grant endpoint. Member emails are returned only by the admin-only RPCs. Assignment and removal actions are audited privately.

`tests/ambassadors.sql` checks assign, update, remove, access revocation, anonymous denial, self-promotion prevention and profile ownership within a rolled-back transaction. The ambassador directory is paginated at 40 ambassadors per page.

`supabase/migrations/20261121000000_admin_member_directory.sql` adds an admin-only registered-user list, including accounts with unverified emails or unfinished profiles. `list_community_members` checks private admin membership on every request and returns only name, email, school/country, signup date, verification/profile status and roles. Anonymous and deleted Auth entries are excluded. The list opens automatically, supports literal name/email/school searches and paginates all results at 25 per page. It grants no direct client access to `auth.users` or admin membership. Apply this additive migration before deploying the admin interface.

The browser/search globe in `public/favicon.svg` is a static vector version of the homepage artwork: terracotta wireframe globe, green star and circular Interoom lettering. PNG, ICO and Apple icon exports use the same design. Search-engine icons update after recrawling and are not guaranteed to appear immediately.
