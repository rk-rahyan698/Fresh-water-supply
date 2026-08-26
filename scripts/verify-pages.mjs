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

const BASE = process.argv[2] ?? "http://localhost:3000";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = process.env.SEED_PASSWORD;

if (!URL_ || !ANON || !PASSWORD) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SEED_PASSWORD");
  process.exit(1);
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
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
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

  const adminCookie = await sessionCookie("abbu@watersupply.demo");
  const collectorCookie = await sessionCookie("mama@watersupply.demo");

  // Find real ids so the detail pages are exercised with real data.
  const anon = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: () => {} } });
  await anon.auth.signInWithPassword({ email: "abbu@watersupply.demo", password: PASSWORD });
  const { data: client } = await anon.from("clients").select("id, name").limit(1).single();
  const { data: payment } = await anon.from("payments").select("id").limit(1).single();

  console.log("== ADMIN ==");
  await check("admin", "/dashboard", adminCookie, "Dashboard");
  await check("admin", "/clients", adminCookie, "Clients");
  await check("admin", `/clients/${client.id}`, adminCookie, client.name);
  await check("admin", `/clients/${client.id}/edit`, adminCookie, "Edit client");
  await check("admin", "/clients/new", adminCookie, "Add client");
  await check("admin", "/bills", adminCookie, "Bills");
  await check("admin", "/collections", adminCookie, "Collections");
  await check("admin", "/submissions", adminCookie, "Cash submission");
  await check("admin", "/reports/due", adminCookie, "Due Report");
  await check("admin", "/reports/collector", adminCookie, "Collector Report");
  await check("admin", "/reports/monthly", adminCookie, "Monthly Report");
  await check("admin", "/reports/daily", adminCookie, "Daily Collection");
  await check("admin", "/users", adminCookie, "Users");
  await check("admin", "/settings", adminCookie, "Settings");
  await check("admin", `/receipt/${payment.id}`, adminCookie, "Receipt");

  console.log("\n== COLLECTOR ==");
  await check("collector", "/my/dashboard", collectorCookie, "Hello");
  await check("collector", "/my/clients", collectorCookie, "Clients");
  await check("collector", `/my/clients/${client.id}`, collectorCookie, client.name);
  await check("collector", "/my/collections", collectorCookie, "My Collections");
  await check("collector", "/my/submissions", collectorCookie, "My Submissions");
  await check("collector", "/my/profile", collectorCookie, "Profile");

  console.log("\n== ROLE SEPARATION ==");
  const res = await fetch(`${BASE}/dashboard`, { headers: { cookie: collectorCookie }, redirect: "manual" });
  const bounced = res.status === 307 || res.status === 302;
  if (bounced) { pass++; console.log(`  PASS  collector on /dashboard -> ${res.status} ${res.headers.get("location")}`); }
  else { fail++; failures.push("collector blocked from /dashboard"); console.log(`  FAIL  collector reached /dashboard (HTTP ${res.status})`); }

  console.log("\n" + "=".repeat(58));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(58));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
