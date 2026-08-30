/**
 * Authenticated page smoke test.
 *
 *   node --env-file-if-exists=.env.local scripts/verify-pages.mjs [baseUrl]
 *
 * Signs in as a real user, borrows the session cookies that @supabase/ssr
 * itself would write, and fetches every screen as that user.
 *
 * This exists because checking that a protected route redirects to /login only
 * proves the gate works - it never renders the page. A server/client boundary
 * mistake (passing a function to a Client Component, say) sails straight
 * through a redirect check, through `tsc`, and through `next build`, and only
 * shows up when a logged-in person opens the screen. So: log in, and look.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv[2] ?? "http://localhost:3000";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.SEED_PASSWORD;

if (!URL_ || !ANON || !SERVICE) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const service = createClient(URL_, SERVICE, { auth: { persistSession: false } });

/**
 * Picks a live account for each role instead of assuming the seeded ones.
 *
 * Once demo data is cleared the old demo admin may be gone or demoted, and
 * signing in as them then makes every admin page "fail" with a redirect that
 * is actually correct behaviour. Ask the database who the admin is.
 */
async function pickUser(role) {
  const { data, error } = await service
    .from("profiles")
    .select("id, email, full_name")
    .eq("role", role)
    .eq("is_active", true)
    .not("email", "is", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`looking up ${role}: ${error.message}`);
  return data; // null when no such user exists - callers decide whether to skip
}

let pass = 0, fail = 0;
const failures = [];

/** Phrases that mean the page did not render properly. */
const ERROR_MARKERS = [
  "Functions cannot be passed directly to Client Components",
  "Internal Server Error",
  "Unhandled Runtime Error",
  "call-stack-frame",
  "Something went wrong", // our own error boundary
  "Application error:",
];

/**
 * Signs in and returns a Cookie header. createServerClient does the encoding
 * and chunking, so this matches byte-for-byte what the browser would hold.
 */
async function sessionCookie(email) {
  const jar = [];
  const client = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (list) => jar.push(...list) },
  });

  // Password first when SEED_PASSWORD covers this account; otherwise mint a
  // one-shot magic link with the service key. Either way the cookies are the
  // real ones @supabase/ssr would write, so the app cannot tell the difference.
  let error = PASSWORD
    ? (await client.auth.signInWithPassword({ email, password: PASSWORD })).error
    : { message: "no SEED_PASSWORD" };

  if (error) {
    const { data: link, error: linkError } = await service.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError) throw new Error(`${email}: ${linkError.message}`);
    const { error: otpError } = await client.auth.verifyOtp({
      type: "magiclink",
      token_hash: link.properties.hashed_token,
    });
    if (otpError) throw new Error(`${email}: ${otpError.message}`);
  }

  if (jar.length === 0) throw new Error(`${email}: no session cookies produced`);
  return jar.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function check(label, path, cookie, mustContain) {
  let res, body;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
    body = await res.text();
  } catch (e) {
    fail++; failures.push(`${label} ${path}`);
    console.log(`  FAIL  ${path.padEnd(28)} network: ${e.message}`);
    return;
  }

  if (res.status >= 300 && res.status < 400) {
    fail++; failures.push(`${label} ${path}`);
    console.log(`  FAIL  ${path.padEnd(28)} ${res.status} redirect -> ${res.headers.get("location")} (session rejected?)`);
    return;
  }
  if (res.status !== 200) {
    fail++; failures.push(`${label} ${path}`);
    console.log(`  FAIL  ${path.padEnd(28)} HTTP ${res.status}`);
    return;
  }

  const hit = ERROR_MARKERS.find((m) => body.includes(m));
  if (hit) {
    fail++; failures.push(`${label} ${path}`);
    console.log(`  FAIL  ${path.padEnd(28)} rendered an error: "${hit}"`);
    return;
  }

  if (mustContain && !body.includes(mustContain)) {
    fail++; failures.push(`${label} ${path}`);
    console.log(`  FAIL  ${path.padEnd(28)} 200 but missing expected content: "${mustContain}"`);
    return;
  }

  pass++;
  console.log(`  PASS  ${path.padEnd(28)} 200  ${(body.length / 1024).toFixed(0)}kb`);
}

async function main() {
  console.log(`Authenticated page check against ${BASE}\n`);

  const adminUser = await pickUser("admin");
  if (!adminUser) throw new Error("No active admin with an email address exists - nothing to check.");
  const collectorUser = await pickUser("collector");

  console.log(`  admin:     ${adminUser.full_name} <${adminUser.email}>`);
  console.log(
    collectorUser
      ? `  collector: ${collectorUser.full_name} <${collectorUser.email}>\n`
      : "  collector: none on file - the collector screens will be skipped\n",
  );

  const adminCookie = await sessionCookie(adminUser.email);
  const collectorCookie = collectorUser ? await sessionCookie(collectorUser.email) : null;

  // Find real ids so the detail pages are exercised with real data.
  const { data: client } = await service.from("clients").select("id, name").limit(1).maybeSingle();
  const { data: payment } = await service.from("payments").select("id").limit(1).maybeSingle();
  // A freshly cleaned database has neither, so the screens that need a real
  // row are skipped rather than failed. Every screen that stands on its own is
  // still checked, which is the part that catches render-time mistakes.
  if (!client) console.log("  note: no clients on file - client detail screens will be skipped\n");

  console.log("== ADMIN ==");
  await check("admin", "/dashboard", adminCookie, "Dashboard");
  await check("admin", "/clients", adminCookie, "Clients");
  if (client) {
    await check("admin", `/clients/${client.id}`, adminCookie, client.name);
    await check("admin", `/clients/${client.id}/edit`, adminCookie, "Edit client");
    await check("admin", `/clients/${client.id}/payments`, adminCookie, "Payments");
  } else {
    console.log("  SKIP  /clients/[id] and children  no clients on file");
  }
  await check("admin", "/clients/new", adminCookie, "Add client");
  await check("admin", "/areas", adminCookie, "Areas");
  await check("admin", "/bills", adminCookie, "Bills");
  await check("admin", "/collections", adminCookie, "Collections");
  await check("admin", "/submissions", adminCookie, "Cash submission");
  await check("admin", "/reports/due", adminCookie, "Due Report");
  await check("admin", "/reports/area", adminCookie, "Area Report");
  await check("admin", "/reports/collections", adminCookie, "Collection Report");
  await check("admin", "/reports/collector", adminCookie, "Collector Report");
  await check("admin", "/reports/monthly", adminCookie, "Monthly Report");
  await check("admin", "/reports/daily", adminCookie, "Daily Collection");
  await check("admin", "/users", adminCookie, "Users");
  await check("admin", "/settings", adminCookie, "Settings");
  if (payment) {
    await check("admin", `/receipt/${payment.id}`, adminCookie, "Receipt");
  } else {
    console.log("  SKIP  /receipt/[id]              no payments recorded yet");
  }

  console.log("\n== COLLECTOR ==");
  if (collectorCookie) {
    await check("collector", "/my/dashboard", collectorCookie, "Hello");
    await check("collector", "/my/clients", collectorCookie, "Clients");
    if (client) await check("collector", `/my/clients/${client.id}`, collectorCookie, client.name);
    await check("collector", "/my/collections", collectorCookie, "My Collections");
    await check("collector", "/my/submissions", collectorCookie, "My Submissions");
    await check("collector", "/my/profile", collectorCookie, "Profile");
  } else {
    console.log("  SKIP  all /my/* screens          no collector account exists yet");
  }

  console.log("\n== NEW FILTERS AND VIEWS ==");
  if (client) {
    await check("admin", `/clients/${client.id}?year=${new Date().getFullYear()}`, adminCookie, client.name);
  }
  await check("admin", "/clients?area=none", adminCookie, "Clients");
  await check("admin", "/dashboard?area=", adminCookie, "Dashboard");
  if (collectorCookie) await check("collector", "/my/clients?area=", collectorCookie, "Clients");

  console.log("\n== ROLE SEPARATION ==");
  if (collectorCookie) {
    const res = await fetch(`${BASE}/dashboard`, { headers: { cookie: collectorCookie }, redirect: "manual" });
    const bounced = res.status === 307 || res.status === 302;
    if (bounced) { pass++; console.log(`  PASS  collector on /dashboard -> ${res.status} ${res.headers.get("location")}`); }
    else { fail++; failures.push("collector blocked from /dashboard"); console.log(`  FAIL  collector reached /dashboard (HTTP ${res.status})`); }
  } else {
    console.log("  SKIP  collector role separation  no collector account exists yet");
  }

  console.log("\n" + "=".repeat(58));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(58));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
