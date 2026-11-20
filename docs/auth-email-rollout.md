# Authentication email delivery

## Status

Prepared against the existing Interoom repository and Supabase project. No database migrations, account changes, or production deployment are part of this preparation.

On 19 November 2026, production Auth logs contained 22 HTTP 429 responses with `over_email_send_rate_limit` in the preceding 24 hours. Custom SMTP was disabled in the dashboard. Resend sign-in, sending-domain verification, and SMTP credentials are still required. The frontend changes do not by themselves remove Supabase's email sending quota.

## Integration

Use Resend as Supabase Auth's custom SMTP provider. Supabase continues to generate and verify confirmation and recovery links, maintain passwords and sessions, and enforce its existing access controls. Do not add a browser-side Resend SDK or an unauthenticated send-email endpoint.

After signing into Resend, verify a sending domain owned by Interoom using the exact DNS records Resend provides. Confirm the sender address belongs to that verified domain. Disable email link tracking so authentication URLs are not rewritten. Do not replace existing website, MX, or unrelated DNS records.

Configure the existing project's **Authentication → Emails → SMTP Settings**:

| Setting | Value |
| --- | --- |
| Custom SMTP | Enabled only once the domain and credentials are ready |
| Sender name | Interoom |
| Sender email | A verified Interoom sender, e.g. `hello@interoom.org` if that domain is verified |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Resend API key with sending access for the verified domain |

Store the API key only in Supabase's SMTP password field. Never add it to a `VITE_*` variable, repository, test fixture, log, or frontend bundle. Do not disable email confirmation to avoid limits.

Check **Authentication → Rate Limits** after enabling SMTP. Start with a bounded hourly email allowance supported by the actual Resend plan (Supabase documents an initial custom-SMTP limit of 30 emails/hour). Keep the minimum interval between emails at 60 seconds. Adjust only the email quota as needed; do not remove sign-in or token verification protections. Resend's own daily/monthly limits still apply.

## Callback configuration

Observed on 20 November 2026:

- Site URL: `https://www.interoom.org`.
- Production redirects: `https://www.interoom.org/` and `https://www.interoom.org/?reset=1`.
- One existing protected preview origin is allowlisted.

The application preserves the initiating origin and uses `/?reset=1` for password recovery. Before live testing, allow the exact candidate preview origin and its recovery URL. If the SDK adds a PKCE flow query parameter, allow that query pattern only on the selected trusted origin. Do not allow every Vercel project or arbitrary domains. Room-subdomain activation remains a separate rollout.

Keep confirmation/recovery templates using Supabase's confirmation URL, including its token and callback handling. PKCE email links must be opened in the browser that requested them. Switching from Supabase's mail transport to Resend does not require replacing existing users or tokens.

## Verification and release gate

Automated tests (`npm test`) use the installed Supabase SDK with a fake HTTP transport, so they send no real email and modify no production data. They cover request parameters and PKCE challenges for signup/reset/resend, HTTP 429 propagation, concurrent/repeated submission suppression, cooldown persistence, safe error text, and callback cleanup. `npm run build` checks the production bundle. Browser smoke checks cover form navigation and failed links.

Before production deployment, complete these checks with a designated test inbox/account:

1. Confirm the sending domain is verified and the SMTP key is restricted appropriately.
2. Verify delivery through Resend to the designated test inbox before routing production Auth mail through it.
3. Configure SMTP, confirm settings persisted, and confirm the Auth email rate allowance.
4. From the candidate preview, create the designated test account and receive its verification email. Open the newest link in the requesting browser; verify the account can sign in.
5. Exercise verification resend on an unconfirmed test account. Confirm it sends one message and the cooldown blocks immediate repeats.
6. Request a password reset for the test account, open the link in the requesting browser, and complete the password change. Verify the old password fails and the new password succeeds. Do not reset a real member's password.
7. Check an expired/used link and wrong credentials. Test 429s using the fake transport rather than exhausting the production quota.
8. Review Auth and Resend logs for delivery/429 errors; confirm normal existing-account sign-in still works.
9. Merge and deploy only after these checks pass. Verify the production deployment and a production auth smoke test. Leave accounts, messages, and database records intact.

If SMTP delivery fails, restore the previous email settings using the dashboard, understanding that the built-in service's restrictions return. Frontend rollback is the previous Vercel deployment. Neither rollback requires a database reset or migration.

## References

- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend SMTP with Supabase](https://resend.com/docs/send-with-supabase-smtp)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Supabase Auth errors](https://supabase.com/docs/guides/auth/debugging/error-codes)
