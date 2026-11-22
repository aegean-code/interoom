# Private messaging browser checks

Start the existing Vite development preview and open `/tests/browser/messaging.html`. The mobile wrapper is `/tests/browser/messaging-mobile.html` (390px iframe).

This harness runs the real messaging components, RPC adapter, and SQL migrations in an isolated PGlite IndexedDB database. Its two explicitly local fixtures never connect to Supabase and never appear in production. Both-account view exercises inbox updates, reply delivery, read receipts, blocking, reports, deletion, opt-in presence and the notification bell. Send a local message while the recipient has its conversation closed to check the badge, mark-read controls and opening the conversation from its notification. Refresh retains the local conversation history. Clear this origin's IndexedDB to reset local fixtures after schema changes.

The in-page subscription bus substitutes for Supabase Realtime. It verifies component behavior, **not** hosted WebSocket delivery or Supabase authentication. The release gate still requires two controlled registered accounts on a preview using the real Supabase project.

These HTML files are development-only entries; Vite's production build uses root `index.html` and does not ship this fixture or local database engine.
