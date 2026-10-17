# Frontend inspection (Checkpoint 1)

Source: `emailScheduling-frontend.zip` extracted unmodified into `frontend/`
(81 files). Package manager: **pnpm** (`pnpm-lock.yaml` kept). Stack: Next.js 16.4,
React 19, Tailwind 4, @base-ui/react, SWR, sonner, DOMPurify.

## Verified at this checkpoint
- `pnpm install --frozen-lockfile` : OK
- `tsc --noEmit` : OK (0 errors)
- `next build` : NOT verified here - sandbox cannot fetch Google Fonts (Inter, Pixelify Sans) from
  `app/layout.tsx`. Not a code defect; should build on a machine with internet.
  Note `next.config.mjs` sets `typescript.ignoreBuildErrors: true` (original; to revisit).

## Mock / integration points found
| Area | File | Current behaviour |
|---|---|---|
| Login (Google + email/password) | `components/auth/login-form.tsx` | Fake: `setTimeout` then toast "Welcome back, Oliver" and redirect. Email/password form has no backend counterpart (spec only asks for Google). |
| Current user | `lib/mock-data.ts` (`currentUser`) | Hardcoded; imported by `sidebar.tsx`, `email-detail.tsx` |
| Sender list | `lib/mock-data.ts` (`senderAddresses`) | Hardcoded; used by `compose-form.tsx` |
| Sign out | `components/mail/user-profile.tsx` | Just `router.push('/login')` |
| Email data layer | `lib/services/email-service.ts` | In-memory store: `listEmails(folder, query, filters)`, `getEmail`, `getCounts`, `toggleStar`, `removeEmail`, `sendEmail(draft)`, `scheduleEmail(draft, Date)` |
| Data hooks | `hooks/use-mail.ts` | SWR wrappers over the service functions |
| Compose | `components/compose/compose-form.tsx` | Per-draft `delayBetweenSeconds`, `hourlyLimit`, `scheduledAt`; one email object with many recipients |
| Recipients / CSV | `components/compose/recipient-input.tsx` | Client-side only: `extractEmails(file.text())`, dedupe, 2 MB cap |
| Schedule popup | `components/compose/schedule-popover.tsx` | Presets + datetime-local; future-time validation |
| Detail page | `components/email/email-detail.tsx` | Star, delete, attachments, sanitized HTML |

## Gaps between the assignment text and the actual frontend
These need decisions (proposed handling in brackets):
1. **No Slack UI exists** - there is no "Connect Slack" control anywhere. [Add a minimal control in the user dropdown / sidebar reusing existing dropdown + button styles, at Checkpoint 6.]
2. **Service function names differ** from the assignment list (`listEmails`, `getEmail`, `sendEmail`, `scheduleEmail` vs `getScheduledEmails`, `scheduleEmails`, ...). [Keep existing names/signatures so components stay untouched; add the missing ones (`getCurrentUser`, `logout`, `uploadRecipients`, Slack functions, `searchEmails`) and thin aliases.]
3. **No `getCurrentUser`/`logout`/`uploadRecipients` exist.** [Add.]
4. **Frontend model is one email with N recipients (`to: Recipient[]`)**; backend spec is one DB row per recipient. [Backend returns/aggregates a campaign view, or the list endpoint returns per-recipient rows mapped to `to: [recipient]`. Decision needed at Checkpoint 3; default: per-recipient rows, each mapped to a single-recipient `Email`.]
5. **Starred, delete, attachments** have no backend requirement. [Starred: small `starred` column + endpoint. Delete: map to cancel for scheduled emails. Attachments: not supported by backend spec; UI kept, files not sent - will be documented as a limitation.]
6. **"Send" (immediate) vs "Send Later"** both exist. [Immediate send = schedule with `startAt = now`; goes through the same queue.]
7. **Delay is in seconds, hourly limit is per draft** - maps to the campaign delay and requested hourly limit (validated against `MAX_EMAILS_PER_HOUR_PER_SENDER`).
8. **Pagination** not present in UI; backend will paginate, UI will request a generous page size.
9. Login page has an email/password form with no backend; it will be left visually intact but flagged as non-functional (Google OAuth is the real path).

## Repo layout at this checkpoint
```
reachinbox-assignment/
  frontend/              original frontend (+ .env.example)
  .gitignore
  README.md              placeholder
  FRONTEND_INSPECTION.md this file
```
