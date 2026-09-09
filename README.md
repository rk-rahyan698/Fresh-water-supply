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
- [First run](#first-run)
- [How the money works](#how-the-money-works)
- [Discounts vs. underpayment](#discounts-vs-underpayment)
- [Areas and rate changes](#areas-and-rate-changes)
- [Financial integrity](#financial-integrity)
- [Third normal form](#third-normal-form)
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
# create the first admin in the Supabase dashboard (see Setup step 4)
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
`supabase/setup.sql`, and hit **Run**. That one file is every migration
concatenated in order, and it is safe to run twice.

`setup.sql` is generated — `npm run build:setup` rebuilds it from the
migrations directory, and `npm run verify:setup` fails if the checked-in copy
has fallen behind. It used to be maintained by hand, which is how it once ended
up missing a migration.

Or run them individually **in order**, from `supabase/migrations/`:

| File | What it creates |
|---|---|
| `0001_init_schema.sql` | Tables, enums, generated columns, triggers |
| `0002_functions.sql` | Every money-moving operation, as SQL functions |
| `0003_rls_policies.sql` | Row Level Security policies and grants |
| `0004_bill_adjustments.sql` | Discounts / waivers, and adjustment-aware due + status |
| `0005_areas_and_rates.sql` | Areas, client area assignment, scheduled rate changes |
| `0006_analytics.sql` | Year × month bill matrix, area summary, area-filtered aggregates |
| `0007_collection_report.sql` | Collection matrix, headline summaries, per-client history |
| `0008_normalize_3nf.sql` | Third normal form: removes two redundant columns |

They are written to be safe to re-run, on an empty database and on one that
already holds bills and payments.

> After applying them, **reload the PostgREST schema cache** — Supabase →
> **API Docs → Reload**, or run `notify pgrst, 'reload schema';` in the SQL
> editor. Supabase usually does this for you, but `0008` adds `monthly_bill`
> as a *computed field* rather than a column, and PostgREST only serves it once
> it has seen it. If the cache is stale the app throws a message saying exactly
> this rather than quietly showing ৳0.

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

There is no seeder - create the owner account by hand, once:

1. Supabase → **Authentication → Users → Add user**, with "Auto Confirm" on.
2. Supabase → **Table Editor → profiles**, set that row's `role` to `admin`.

A profile row is created automatically for every new auth user by the
`on_auth_user_created` trigger, defaulting to the `collector` role.

---

## First run

There is no demo seeder — the project ships empty on purpose, so nothing
fictional can ever end up in a real ledger. Getting to a working screen takes
about a minute:

1. Sign in as the admin you created in **Setup step 4**.
2. **Areas → Add area.** Optional, but area filters run through every report,
   so it is worth doing first.
3. **Clients → Add client.** The client code is suggested for you. The monthly
   rate you enter here becomes the client's opening rate, effective from their
   start month.
4. **Bills → Generate monthly bills** for the current month. Every active client
   whose start date falls on or before the end of that month gets one bill.
   Running it again creates nothing extra.
5. Open a client and **Collect payment**. The bill's paid, due and status
   figures update themselves, and the receipt is printable.

To add collectors: **Users → Add user**. They get the `collector` role by
default and see only their own clients and their own collections.

`supabase/remove-demo-data.sql` is a leftover from the seeder that used to
exist: it deletes the three `@watersupply.demo` accounts and everything they
created, and refuses to run until a real admin exists. Keep it only if your
database still holds those rows — on a fresh project it has nothing to do.

---

## How the money works

```
Client → Monthly bill → Payment → Collector → Cash submission → Reports
```

**1. Bills.** Admin picks a month and hits *Generate monthly bills*. Every active
client whose `start_date` falls on or before the end of that month gets one bill
at the rate effective for that month. Running it twice creates nothing extra —
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
| Due is never negative | `CHECK (paid_amount <= bill_amount - adjustment_amount)` |
| `due_amount` always equals adjusted − paid | `GENERATED ALWAYS AS (bill_amount - adjustment_amount - paid_amount) STORED` |
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

### Checking the screens actually render

```bash
npm run dev          # in one terminal
npm run verify:pages # in another
```

Signs in as a real admin and a real collector, borrows the session cookies
`@supabase/ssr` itself would write, and fetches all 21 screens as those users -
asserting HTTP 200, no error markers in the HTML, and expected content.

This exists because checking that a protected route redirects to `/login` only
proves the gate works; it never renders the page. A server/client boundary
mistake - passing a function to a Client Component, say - passes `tsc`, passes
`next build`, passes a redirect check, and only breaks when a logged-in person
opens the screen. So the test logs in and looks.

---

## Areas and rate changes

**Areas** group clients geographically. The area lives on the *client*, never on
a bill or payment, so moving someone between areas changes where they are
counted from now on and rewrites nothing historical. Clients with no area are
reported as **Unassigned** rather than dropped, so area totals always add up to
the business totals.

Every list and report takes an area filter, and they combine - *August 2026 +
Area 1 + Mama* answers "what did Mama collect in Area 1 last month".

**Rate changes.** `client_rate_history` is the single source of truth for what
a client pays. Every client has an opening row at their start month, and the
rate in force for any month is the newest row with `effective_from <=` that
month. Bill generation copies that figure into `monthly_bills.bill_amount`, and
an existing bill is never rewritten, so a rate change only ever affects future
bills.

Scheduling therefore comes for free: *"৳1,200 from September"* is recorded with
a reason and a date, and generation asks for the rate effective for the month it
is billing:

```
January–March  ৳1,000   (already billed - untouched)
April onwards  ৳1,200   (scheduled, effective April)
```

A rate can never be back-dated into a month that is already billed - the SQL
function rejects it.

There is no second copy of the rate anywhere. There used to be:
`clients.monthly_bill` held "the rate in force today", and nothing moved it
when a scheduled change came into effect - so from the 1st of the month the
client list showed the old figure while billing used the new one, indefinitely.
Migration `0008` removed the column and made the current rate a derived value.
See [Third normal form](#third-normal-form).

**Long-term history.** A client's bills are shown as a Year x Month matrix,
years as columns and months as rows. Only a bounded year window is ever
queried, and a cell's payments load when the cell is opened - so a client with
ten years of history stays as fast as one with three months.

---

## Third normal form

The schema is in 3NF. Two columns were not, and both had already produced
wrong numbers before they were removed in `0008_normalize_3nf.sql`.

### `clients.monthly_bill`

`client_rate_history` holds the rate for every effective month, so a separate
"current rate" column on `clients` was a second, independently-updated copy of
a fact that table already owned.

Nothing kept the two in step across a month boundary. Schedule *"৳1,500 from
next month"* and `clients.monthly_bill` stayed at ৳1,000 — no job moves it when
the month turns over. From the 1st onwards the client list and the client detail
page showed ৳1,000 while `generate_monthly_bills()` billed ৳1,500, and they
stayed out of step until somebody happened to re-save the client form.

Now: `client_rate_history` is the sole authority, every client is guaranteed an
opening row at their start month, and the current rate reaches the API as a
PostgREST **computed field** with the same name. Callers still read
`monthly_bill` — it is derived on read instead of stored twice, so it cannot
disagree with the rate billing uses. Because it is computed, it has to be asked
for by name: `.select("*, monthly_bill")`, not `.select("*")`.

### `payments.client_id`

A payment belongs to a bill, and a bill belongs to a client:

```
payments.id → payments.monthly_bill_id → monthly_bills.client_id
```

`monthly_bill_id` is not a key of `payments` and `client_id` is not part of one,
so `client_id` was transitively dependent — the textbook 3NF violation. Nothing
constrained it to match the bill's own client either, so a direct insert could
file a payment under client A against client B's bill, after which every report
disagreed with every other depending on which column it joined through.

Now: the column is gone. Payments reach their client through the bill, which is
the only path that can be wrong in one place at a time. The migration refuses to
drop the column if any existing row disagrees with its bill, rather than burying
the evidence.

The API shape did not change. `src/lib/queries/payments.ts` embeds
`monthly_bills → clients` and flattens the result, so components still receive
`payment.clients`.

### Deliberately kept: `monthly_bills.paid_amount`

This one looks like denormalisation and is not a 3NF violation: it is an
**aggregate** over `payments`, not a functional dependency between columns of
`monthly_bills`, and normal forms are defined over functional dependencies.

It is a materialised sum, maintained only by `sync_bill_paid_amount()` and
re-derived by `monthly_bills_derive_paid()` if anything writes it directly — so
even an admin with a raw REST client cannot desync it. `due_amount` and `status`
are `GENERATED` from it, which is what makes the bill's arithmetic impossible
to get wrong.

### Checking it

```bash
npm run verify:3nf
```

48 assertions. It seeds a populated database on the *old* schema, reproduces the
rate anomaly, applies `0008`, and then proves the columns are gone, that no
bill, payment or total changed, that a scheduled rate now flows through to the
generated bill with nobody re-saving anything, and that every report which used
to read `payments.client_id` still returns the same figures.

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
      areas/ reports/{due,collector,monthly,daily,area,collections}/ users/ settings/
    (collector)/my/          Collector shell + role gate
      dashboard/ clients/ collections/ submissions/ profile/
    receipt/[id]/            Printable receipt (both roles)
  components/
    ui/                      Button, Card, Field, Modal, Toast, Table, ...
    layout/                  App shell, sidebar, bottom tabs
    clients/ payments/ submissions/ users/ bills/ areas/ charts/ reports/ filters/
  lib/
    supabase/                Browser, server, admin and proxy clients
    actions/                 Server Actions (all mutations)
    queries/                 Server-side reads
    validations/             Zod schemas, shared by forms and actions
    export/                  CSV and PDF generation (browser-side)
    i18n/                    UI strings (see "Adding Bengali")
    format.ts errors.ts auth.ts env.ts
  proxy.ts                   Session refresh + auth gate (Next 16 middleware)
  types/database.ts          Hand-maintained mirror of the SQL schema
supabase/
  migrations/                0001 schema · 0002 functions · 0003 RLS · 0004 adjustments
                             0005 areas+rates · 0006 analytics · 0007 reports · 0008 3NF
  setup.sql                  GENERATED - all of the above, for the SQL editor
scripts/                     verify-*.mjs suites · build-setup-sql.mjs
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
| `npm run verify:deploy` | **Reproduce the Vercel build locally, before pushing** |
| `npm run verify:db` | Run migrations + 57 assertions in PGlite |
| `npm run verify:migration` | Apply 0004 to a *populated* schema and check nothing breaks |
| `npm run verify:analytics` | Areas, rate history, bill matrix and area reporting |
| `npm run verify:reports` | Collection matrix, summaries and per-client history |
| `npm run verify:3nf` | Apply 0008 to a *populated* schema: normalisation, no data loss |
| `npm run verify:exports` | CSV and PDF generation |
| `npm run verify:cleanup` | `remove-demo-data.sql` deletes demo rows and only demo rows |
| `npm run verify:setup` | Fail if `supabase/setup.sql` is stale |
| `npm run verify:all` | Every offline suite in sequence (266 assertions) |
| `npm run build:setup` | Regenerate `supabase/setup.sql` from the migrations |
| `npm run verify:pages` | Log in for real and render every screen (needs `npm run dev` running) |
| `npm run verify:live` | End-to-end against a real Supabase project, then reverse every write |

Everything from `verify:db` down to `verify:setup` runs entirely offline
against PGlite — no Docker, no Supabase account, safe in CI. Only
`verify:pages` and `verify:live` talk to a real project.

---

## Deploying to Vercel

### Check it first

```bash
npm run verify:deploy
```

Run this before every push. `npm run build` is **not** the build Vercel runs —
Vercel builds only the files git tracks, minus everything `.vercelignore`
excludes, with a clean `npm ci` and no `.env.local`. `verify:deploy`
reconstructs exactly that tree and builds it, so a deploy-only failure shows up
in a couple of minutes locally instead of as a red cross in the dashboard.

It catches the four things that differ from your working copy:

| Difference | What it looks like on Vercel |
|---|---|
| An untracked or gitignored file the build needs | `Module not found` |
| A `.vercelignore` rule that matches more than intended | `Module not found`, in bulk |
| `package.json` and `package-lock.json` out of sync | `npm ci` fails |
| A module reading a required env var at import time | Build fails collecting page data |

> **The `.vercelignore` trap, in particular.** `.vercelignore` uses gitignore
> matching, where a pattern *without* a slash matches at **any** depth. A rule
> reading `supabase/` therefore deletes `src/lib/supabase/` as well — the
> Supabase clients the whole app imports — and the deploy dies with sixteen
> copies of `Can't resolve '@/lib/supabase/server'` while the local build stays
> green. Every rule in this project's `.vercelignore` is anchored with a
> leading slash for that reason, and `verify:deploy` fails loudly if a future
> edit drops one.

### Steps

1. Push the repository to GitHub.
2. Vercel → **Add New → Project** → import the repo. The framework preset is
   detected automatically; no build settings need changing.
3. Add the environment variables under **Settings → Environment Variables**, for
   Production **and** Preview **and** Development:

   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   NEXT_PUBLIC_BUSINESS_NAME
   ```

   All three environments, not just Production: `NEXT_PUBLIC_*` values are
   baked into the browser bundle **at build time**, so a preview deploy built
   without them ships a client that cannot reach Supabase at all — the pages
   render and then every action fails.

   Do **not** add `SEED_PASSWORD` in production.
4. Deploy.
5. In Supabase → **Authentication → URL Configuration**, set **Site URL** to
   your Vercel domain and add it to **Redirect URLs**. Without this, login
   appears to succeed and then bounces straight back to `/login`.

`.env*` is gitignored (with `.env.example` explicitly re-included), so secrets
cannot be committed by accident.

### A green build is not a green site

The build never contacts Supabase, so it cannot tell you the database is
unreachable. If every page returns 500 after a successful deploy, check in this
order:

1. **Does the project still exist?** A deleted or paused Supabase project stops
   resolving in DNS entirely. Confirm with
   `nslookup <your-ref>.supabase.co` — `Non-existent domain` means the project
   is gone and no amount of redeploying will help; create a new one and run
   `supabase/setup.sql` against it.
2. **Are the environment variables actually set for this environment?** Vercel
   scopes them per environment; a Preview deploy does not inherit Production's.
3. **Has `supabase/setup.sql` been run?** A project with no tables returns a
   PostgREST error on every query.
4. **Is the Vercel URL in Supabase's redirect allow-list?** (Step 5 above.)

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
`profiles` table. On a deployed site, also check that your Vercel URL is in
Supabase → **Authentication → URL Configuration**; a session cookie set for the
wrong origin looks exactly like this.

**"Supabase did not return the computed field `monthly_bill`"**
`0008_normalize_3nf.sql` has not been applied, or PostgREST's schema cache is
stale. Apply it, then Supabase → **API Docs → Reload**, or run
`notify pgrst, 'reload schema';`.

**Every page returns 500 on Vercel, but the build was green**
The build never contacts Supabase, so it cannot catch a database problem. Work
through the four checks in
[Deploying to Vercel → A green build is not a green site](#a-green-build-is-not-a-green-site).
The one people miss: a deleted or paused Supabase project stops resolving in
DNS entirely — `nslookup <your-ref>.supabase.co` returning
`Non-existent domain` means the project is gone.

**"No bill exists for this client for the selected month"**
Bills for that month have not been generated. Admin → **Bills → Generate monthly
bills**, or use *Create bill for this month* on the client's page.

**A collector sees an empty payment history on a client**
Expected. RLS limits collectors to payments they took themselves; the screen
says so. The bill's paid/due figures are still complete.

**Bill totals look wrong**
They cannot drift — `paid_amount` is recomputed by trigger from the payment rows.
Check whether a payment was voided (Collections → set *Voided* to "Shown").

**A newly created user cannot sign in**
Email confirmations are on for new signups. Create the user from Supabase →
**Authentication → Users → Add user** with "Auto Confirm" ticked, or confirm
the address from the same screen afterwards.
