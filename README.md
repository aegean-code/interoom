# Interoom

A responsive React/Vite prototype for an international student community, branded **Interoom**.

## Run locally

```bash
npm install
npm run dev
```

## Deploy on Vercel

1. Upload this project to a new GitHub repository (all files, including `src`).
2. In Vercel, select **Add New → Project → Import Git Repository**.
3. Vercel detects Vite. Build command: `npm run build`; output directory: `dist`.
4. Deploy. Under **Project → Settings → Domains**, add `interoom.org` and `www.interoom.org`.
5. At GoDaddy → Domain Portfolio → interoom.org → DNS, add/change only the records Vercel tells you to use. Avoid changing mail-related records.

## Important: prototype limitations

The demo uses browser `localStorage` for profiles, posts, likes and chat. These are **not shared between visitors** and are not secure accounts. Sample community posts are fictional. Before opening to real students, add secure authentication, a hosted database, server-side authorization, abuse reporting, moderation, privacy policy and appropriate safeguards for minors. Do not collect personal or sensitive information through the prototype.
