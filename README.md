# Water Supply — Collection & Accounting

A mobile-first web app that replaces the paper ledger for a small water supply
business: clients, monthly bills, payment collection, collector cash
reconciliation and the reports the owner actually needs.

Built with **Next.js 16 (App Router)**, **TypeScript**, **Tailwind CSS v4** and
**Supabase** (Postgres + Auth + Row Level Security). Deploys to **Vercel**.

At any moment the owner can answer:

- এই মাসে মোট কত টাকা bill হয়েছে? → Dashboard / Monthly Report
- কত টাকা collect হয়েছে, কত বাকি? → Dashboard / Due Report
- কে কত টাকা collect করেছে? → Collector Report / Daily Collection
- কার কাছে কত টাকা unsubmitted আছে? → Cash Submission

---

## Contents

- [Quick start](#quick-start)
- [Setup](#setup)
- [Demo data](#demo-data)
- [How the money works](#how-the-money-works)
- [Discounts vs. underpayment](#discounts-vs-underpayment)
- [Financial integrity](#financial-integrity)
- [Security model](#security-model)
- [Screens](#screens)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Deploying to Vercel](#deploying-to-vercel)
- [Adding Bengali](#adding-bengali)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
npm install
cp .env.example .env.local     # then fill in your Supabase keys
# paste supabase/setup.sql into the Supabase SQL editor (see Setup)
npm run seed                   # optional demo data
npm run dev
```

Open <http://localhost:3000>.

---

## Setup

### 1. Create a Supabase project

<https://supabase.com/dashboard> → **New project**. Pick a region close to
Bangladesh (Singapore is usually the best available) and save the database
password somewhere safe.

### 2. Run the migrations

**Easiest path:** open **SQL Editor → New query**, paste the entire contents of
`supabase/setup.sql`, and hit **Run**. That one file is the three migrations
concatenated in order, and it is safe to run twice.

Or run them individually **in order**, from `supabase/migrations/`:

| File | What it creates |
|---|---|
| `0001_init_schema.sql` | Tables, enums, generated columns, triggers |
| `0002_functions.sql` | Every money-moving operation, as SQL functions |
| `0003_rls_policies.sql` | Row Level Security policies and grants |
| `0004_bill_adjustments.sql` | Discounts / waivers, and adjustment-aware due + status |

They are written to be safe to re-run.

If you prefer the CLI, push the migrations folder (ignore `setup.sql`, which
would apply the same SQL a second time):

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### 3. Configure environment variables

Copy `.env.example` to `.env.local` and fill in the values from
**Project Settings → API**:

| Variable | Where to find it | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key | Public; RLS still applies |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` / secret key | **Server only — never commit** |
| `NEXT_PUBLIC_BUSINESS_NAME` | Your choice | Shown in the header and on receipts |

The service-role key bypasses RLS. It is used in exactly one place — creating
and updating auth users from the admin **Users** screen (`src/lib/supabase/admin.ts`)
— and that file imports `server-only`, so the build fails if it is ever pulled
into a client bundle.

### 4. Create the first admin

Either run `npm run seed` (below), or create a user by hand:

1. Supabase → **Authentication → Users → Add user**, with "Auto Confirm" on.
2. Supabase → **Table Editor → profiles**, set that row's `role` to `admin`.

A profile row is created automatically for every new auth user by the
`on_auth_user_created` trigger, defaulting to the `collector` role.

---

## Demo data

```bash
npm run seed
```

Creates one admin, two collectors, 14 clients, three months of bills, a
realistic spread of full and partial payments, and cash submissions.

The seeder deliberately works through the **real API**: it creates users with
the admin API, then *signs in as each of them* and calls
`generate_monthly_bills`, `record_payment` and `create_cash_submission` exactly
as the app does. Seeding therefore also proves that auth, RLS and the financial
functions are wired up correctly.

| Role | Email | Name |
|---|---|---|
| admin | `abbu@watersupply.demo` | Abbu (Owner) |
| collector | `mama@watersupply.demo` | Mama |
| collector | `jamal@watersupply.demo` | Jamal |

The password is **not hardcoded**. Set `SEED_PASSWORD` in `.env.local` to choose
one, or leave it blank and the script generates a random password and prints it
once when it finishes.

Re-running is safe: users and clients are upserted, bill generation is
idempotent, and payments/submissions are only seeded when there are none yet.

> The seed script is for development and demo environments. It resets the
> passwords of the three demo accounts each time it runs.

---

## How the money works

```
Client → Monthly bill → Payment → Collector → Cash submission → Reports
```

**1. Bills.** Admin picks a month and hits *Generate monthly bills*. Every active
client whose `start_date` falls on or before the end of that month gets one bill
at their current `monthly_bill` rate. Running it twice creates nothing extra —
the `(client_id, billing_month)` unique constraint plus `ON CONFLICT DO NOTHING`
guarantee one bill per client per month.

**2. Payments.** A collector opens a client, sees the bill, taps *Collect
payment*. Partial payments are supported and each one is a separate, permanent
transaction. Overpayment is rejected. The bill's `paid_amount`, `due_amount` and
`status` update themselves.

**3. Cash submission.** When a collector hands cash to the owner, the owner
records it. `Unsubmitted = cash collected − cash submitted`, and the app will not
let a collector be recorded as submitting more than they actually hold.

Only `cash` payments are reconciled this way — bank transfers and mobile banking
never pass through the collector's hands, so counting them would inflate what
the collector appears to owe.

**4. Adjustments.** An admin can reduce a bill with a discount or waiver. See
below - this is the distinction that a paper ledger usually loses.

**5. Corrections.** Payments are never edited or deleted. An admin *voids* a
payment with a reason; the amount returns to the client's due and the
transaction stays in the record, marked voided.

---

## Discounts vs. underpayment

Two situations look identical on paper and mean opposite things:

| | Bill | Adjustment | Paid | Due | Status |
|---|---|---|---|---|---|
| Client short-paid | ৳1,000 | ৳0 | ৳800 | **৳200** | Partial |
| Business gave a discount | ৳1,000 | **৳200** | ৳800 | **৳0** | Paid |

Both took ৳800 against a ৳1,000 bill. In the first the client still owes ৳200;
in the second they owe nothing. The app keeps them apart:

```
adjusted_amount = bill_amount - adjustment_amount     (what is actually owed)
due_amount      = adjusted_amount - total valid payments
```

`bill_amount` always holds the **original** figure, so the discount never
disappears from the record. Every bill view shows the full ladder - Original ->
Adjustment -> Adjusted -> Paid -> Due - so nobody has to guess which case they
are looking at.

**Only an admin can adjust a bill.** A collector records payments and nothing
else, which is what stops a bill being quietly reduced in the field.
`set_bill_adjustment()` re-checks the role from the JWT and stamps `adjusted_by`
itself, so the form cannot claim someone else approved it.

**Every adjustment needs a type and a reason** (discount, waiver, special
reduction, other). That is enforced in the form, in the SQL function, *and* by a
CHECK constraint - a row with an adjustment but no reason cannot exist. The
reason, the approver and the timestamp all show on the bill.

An adjustment can never exceed the bill, and can never waive money already
collected - void the payment first if you really need to go further.

---

## Financial integrity

The rules live in the **database**, not in the UI, so they hold no matter how a
write arrives.

| Rule | How it is enforced |
|---|---|
| Due is never negative | `CHECK (paid_amount <= bill_amount)` |
| `due_amount` always equals bill − paid | `GENERATED ALWAYS AS (bill_amount - paid_amount) STORED` |
| Status matches the amounts | `status` is a `GENERATED` column, not app logic |
| `paid_amount` never drifts | Recomputed by trigger as `SUM(payments)` where not voided — app code never writes it |
| No duplicate bills | `UNIQUE (client_id, billing_month)` |
| An adjustment never exceeds the bill | `CHECK (adjustment_amount <= bill_amount)` |
| An adjustment always has a type, reason and approver | `CHECK` on the metadata columns - a reasonless adjustment cannot be stored |
| Only admins adjust | `set_bill_adjustment()` calls `require_admin()`; collectors have no write path |
| Payments are immutable | Trigger rejects `DELETE`, and rejects `UPDATE` of anything but the void fields |
| No overpayment | `record_payment()` re-reads the bill `FOR UPDATE`, so concurrent collections cannot race past the limit |
| No over-submission | `create_cash_submission()` locks the collector row and checks the balance |
| Everything is traceable | Payment, bill, client and submission changes write to `audit_logs` in the same transaction |

Every money-moving operation is a `SECURITY DEFINER` SQL function in
`0002_functions.sql`. The application never inserts into `payments` or
`cash_submissions` directly — **there is no RLS policy that would allow it.**

### Verifying it

```bash
npm run verify:db
```

Runs the real migrations against [PGlite](https://pglite.dev) (Postgres compiled
to WebAssembly — no Docker, no Supabase account) and asserts 54 behaviours,
including both acceptance scenarios from the spec:

```
== Acceptance: Mama collects Rahim's full 1000 ==
  PASS  Bill 1000 / Paid 1000 / Due 0 / status paid
  PASS  Mama total collection = 1000
  PASS  Mama unsubmitted = 1000

== Acceptance: Karim 1500 - Mama 1000 then Jamal 500 ==
  PASS  after 1000 of 1500: Paid 1000 / Due 500 / partial
  PASS  overpayment rejected with the due in the message
  PASS  after 500 more: Paid 1500 / Due 0 / paid
  PASS  both partial payments kept as separate transactions

RESULT: 57 passed, 0 failed
```

`npm run verify:migration` covers the adjustment feature separately (32 more
assertions). It builds the pre-adjustment schema, fills it with bills and
payments, applies `0004` on top, and checks that nothing was lost or
recalculated wrongly - because production already holds data when that
migration runs:

```
== Addendum Test 4: business discount ==
  PASS  Test 4 result: paid 800, DUE 0, status PAID (not partial)
== Addendum Test 5: discount + partial payment ==
  PASS  Test 5 result: adjusted 800, paid 600, due 200, PARTIAL
== Section 9: partial payment is NOT a discount ==
  PASS  Karim (no adjustment) still owes 200
  PASS  Sabbir (adjusted) owes nothing, though both paid 800
```

It also covers RLS (a collector cannot read another collector's payments, or
write to any financial table), payment immutability, void-and-reversal,
submission caps, and the dashboard aggregates.

---

## Security model

Three independent layers — the app never relies on the frontend alone:

1. **`src/proxy.ts`** refreshes the Supabase session on every request and
   redirects signed-out visitors to `/login`. Convenience, not security.
2. **Route layouts** check the role server-side. `requireAdmin()` sends a
   collector to their own dashboard.
3. **Row Level Security + `SECURITY DEFINER` functions** are the real boundary.
   Even a request crafted straight against the Supabase REST API is constrained.

| Table | Collector | Admin |
|---|---|---|
| `profiles` | own row | all, and may edit |
| `clients` | read | full |
| `monthly_bills` | read | full |
| `payments` | read own only; **no writes** | read all; **no writes** |
| `cash_submissions` | read own only; **no writes** | read all; **no writes** |
| `audit_logs` | none | read |

Writes to `payments` and `cash_submissions` happen only through the audited SQL
functions, which re-check the caller's role from the JWT. A collector cannot
record a payment under someone else's name: `collected_by` is stamped from
`auth.uid()` inside the function, never from the request body.

Self-service profile edits go through `update_own_profile()`, which deliberately
cannot touch `role` or `is_active` — so a collector cannot promote themselves.

---

## Screens

**Admin** — Dashboard, Clients, Bills, Collections, Cash Submission, Due Report,
Collector Report, Monthly Report, Daily Collection, Users, Settings.

**Collector** (under `/my/*`) — Dashboard, Clients, My Collections, My
Submissions, Profile.

Both roles share the printable **Receipt** at `/receipt/[id]`, which shows the
figures *as they stood at that transaction* — a printed receipt does not change
meaning when a later payment is recorded.

### Mobile

Collectors work from a phone, so: bottom tab bar, 44px+ touch targets, a numeric
keypad for amounts, one-tap "Pay full due", `tel:` links on every phone number,
tables that scroll inside their own container rather than the page, and 16px
inputs so iOS does not zoom on focus.

### Dashboard charts

- **Billed vs collected** — stacked bars where the total height *is* the month's
  bill, split into collected and due. Plotting "billed" as a third bar would
  draw the same number twice.
- **Collection by collector** — one series, one colour, horizontal bars.

Both have a table view toggle, so no value is reachable only by hovering. The
two-colour palette is validated for colour-vision deficiency (CVD ΔE 24.7 against
a ≥8 target).

---

## Project structure

```text
src/
  app/
    (auth)/login/            Sign in
    (admin)/                 Admin shell + role gate
      dashboard/ clients/ bills/ collections/ submissions/
      reports/{due,collector,monthly,daily}/ users/ settings/
    (collector)/my/          Collector shell + role gate
      dashboard/ clients/ collections/ submissions/ profile/
    receipt/[id]/            Printable receipt (both roles)
  components/
    ui/                      Button, Card, Field, Modal, Toast, Table, ...
    layout/                  App shell, sidebar, bottom tabs
    clients/ payments/ submissions/ users/ bills/ charts/ filters/
  lib/
    supabase/                Browser, server, admin and proxy clients
    actions/                 Server Actions (all mutations)
    queries/                 Server-side reads
    validations/             Zod schemas, shared by forms and actions
    i18n/                    UI strings (see "Adding Bengali")
    format.ts errors.ts auth.ts env.ts
  types/database.ts          Hand-maintained mirror of the SQL schema
supabase/
  migrations/                0001 schema · 0002 functions · 0003 RLS · 0004 adjustments
  setup.sql                  the three above, concatenated for the SQL editor
scripts/                     seed.mts · verify-db.mjs · verify-migration-0004.mjs
```

Forms use React Hook Form + Zod. **The same Zod schema runs again inside the
server action** — client-side validation is for speed of feedback, never for
trust.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:db` | Run migrations + 57 assertions in PGlite |
| `npm run verify:migration` | Apply 0004 to a *populated* schema and check nothing breaks |
| `npm run seed` | Demo data (reads `.env.local`) |

---

## Deploying to Vercel

1. Push the repository to GitHub.
2. Vercel → **Add New → Project** → import the repo. The framework preset is
   detected automatically; no build settings need changing.
3. Add the environment variables under **Settings → Environment Variables**, for
   Production *and* Preview:

   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   NEXT_PUBLIC_BUSINESS_NAME
   ```

   Do **not** add `SEED_PASSWORD` in production.
4. Deploy.
5. In Supabase → **Authentication → URL Configuration**, add your Vercel domain
   to the allowed redirect URLs.

`.env*` is gitignored (with `.env.example` explicitly re-included), so secrets
cannot be committed by accident.

---

## Adding Bengali

No component contains a hardcoded user-facing string — they all come from
`src/lib/i18n`. To add Bengali:

1. Copy `src/lib/i18n/en.ts` to `bn.ts` and translate the values. TypeScript
   will flag any key you miss, because the dictionary is typed against `en`.
2. Register it and switch the locale in `src/lib/i18n/index.ts`:

   ```ts
   const dictionaries: Record<Locale, Dictionary> = { en, bn };
   export const ACTIVE_LOCALE: Locale = "bn";
   ```

No component changes are needed. The font stack already includes
`Noto Sans Bengali`, and the currency symbol (৳) and date helpers are shared.

---

## Currency, dates and timezone

Amounts are Bangladeshi Taka, formatted `৳12,500`. Money columns use tabular
figures so they line up.

The business day is **Asia/Dhaka**, not the server's timezone. `payment_date`,
`billing_month` and `submission_date` are Postgres `date` columns defaulted from
`(now() AT TIME ZONE 'Asia/Dhaka')::date`, so "today's collection" means today in
Dhaka wherever the server happens to run.

On the client those dates are formatted by splitting the `YYYY-MM-DD` string,
never with `new Date("2026-08-26")` — that parses as UTC midnight and renders as
the 25th for anyone west of Greenwich. Only true timestamps (`created_at`) go
through `Intl` with an explicit `Asia/Dhaka` timezone.

---

## Troubleshooting

**"Missing environment variable NEXT_PUBLIC_SUPABASE_URL"**
`.env.local` is missing or incomplete. Copy `.env.example` and fill it in, then
restart `npm run dev` — Next.js only reads env files at startup.

**Signed in but immediately bounced back to `/login`**
The auth user has no `profiles` row, or its `is_active` is false. Check the
`profiles` table.

**"No bill exists for this client for the selected month"**
Bills for that month have not been generated. Admin → **Bills → Generate monthly
bills**, or use *Create bill for this month* on the client's page.

**A collector sees an empty payment history on a client**
Expected. RLS limits collectors to payments they took themselves; the screen
says so. The bill's paid/due figures are still complete.

**Bill totals look wrong**
They cannot drift — `paid_amount` is recomputed by trigger from the payment rows.
Check whether a payment was voided (Collections → set *Voided* to "Shown").

**`npm run seed` fails with "Could not sign in"**
Email confirmations are on for new signups. The seeder sets `email_confirm: true`,
so this usually means `SUPABASE_SERVICE_ROLE_KEY` is wrong or belongs to a
different project.
#   F r e s h - w a t e r - s u p p l y 
 
 