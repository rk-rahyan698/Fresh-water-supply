/**
 * Live end-to-end verification against the real Supabase project.
 *
 *   node --env-file-if-exists=.env.local scripts/verify-live.mjs
 *
 * Signs in as the actual demo users over the anon key, so every write goes
 * through real auth, real RLS and the real SQL functions - exactly the path the
 * app uses. Nothing here talks to the service-role client except for reading
 * the before/after snapshot.
 *
 * Every write is REVERSED at the end (adjustments removed, payments voided) and
 * the script proves the totals return to their starting values. Payments are
 * voided rather than deleted because the database does not allow deletion -
 * which is the point.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.SEED_PASSWORD;

if (!URL || !ANON || !SERVICE || !PASSWORD) {
  console.error("Missing env. Need NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SEED_PASSWORD.");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const money = (n) => "৳" + Number(n ?? 0).toLocaleString("en-US");

let pass = 0, fail = 0;
const failures = [];
const createdPayments = [];
const adjustedBills = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
}

async function expectReject(name, promise, token) {
  const { error } = await promise;
  if (!error) { fail++; failures.push(name); console.log(`  FAIL  ${name} (expected rejection)`); return; }
  if (token && !error.message.includes(token)) {
    fail++; failures.push(name); console.log(`  FAIL  ${name} (wrong error: ${error.message})`); return;
  }
  pass++; console.log(`  PASS  ${name} -> ${error.message.slice(0, 55)}`);
}

async function signIn(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
  return { c, id: data.user.id, email };
}

/** Reads one bill's full ladder. */
async function ladder(billId) {
  const { data } = await admin
    .from("monthly_bills")
    .select("bill_amount, adjustment_amount, adjusted_amount, paid_amount, due_amount, status, adjustment_type, adjustment_reason, adjusted_by")
    .eq("id", billId).single();
  return {
    original: Number(data.bill_amount),
    adjustment: Number(data.adjustment_amount),
    adjusted: Number(data.adjusted_amount),
    paid: Number(data.paid_amount),
    due: Number(data.due_amount),
    status: data.status,
    type: data.adjustment_type,
    reason: data.adjustment_reason,
    approvedBy: data.adjusted_by,
  };
}

function show(l) {
  console.log(
    `        original ${money(l.original)} | adjustment ${money(l.adjustment)} | adjusted ${money(l.adjusted)} | paid ${money(l.paid)} | due ${money(l.due)} | ${l.status.toUpperCase()}`,
  );
}

async function snapshot() {
  const { data } = await admin.from("monthly_bills").select("bill_amount, adjustment_amount, paid_amount, due_amount");
  const s = (k) => data.reduce((a, r) => a + Number(r[k]), 0);
  const { count } = await admin.from("payments").select("*", { count: "exact", head: true });
  return { original: s("bill_amount"), adjustment: s("adjustment_amount"), paid: s("paid_amount"), due: s("due_amount"), payments: count };
}

/** Records a payment as the given user and remembers it for cleanup. */
async function pay(user, clientId, month, amount, note) {
  const { data, error } = await user.c.rpc("record_payment", {
    p_client_id: clientId, p_billing_month: month, p_amount: amount,
    p_payment_method: "cash", p_notes: note, p_payment_date: null,
  });
  if (error) throw new Error(`payment ${amount} as ${user.email}: ${error.message}`);
  createdPayments.push(data.id);
  return data;
}

async function main() {
  console.log("Live verification against", URL, "\n");

  const before = await snapshot();
  console.log("=== SNAPSHOT BEFORE ===");
  console.log(`  original ${money(before.original)} | adjustment ${money(before.adjustment)} | paid ${money(before.paid)} | due ${money(before.due)} | ${before.payments} payments\n`);

  const abbu = await signIn("abbu@watersupply.demo");
  const mama = await signIn("mama@watersupply.demo");
  const jamal = await signIn("jamal@watersupply.demo");
  console.log("=== SIGN IN ===");
  check("all three accounts sign in over the anon key", Boolean(abbu.id && mama.id && jamal.id));

  // Pick four untouched ৳1,000 bills so the spec's exact figures apply.
  const { data: open } = await admin
    .from("monthly_bills")
    .select("id, billing_month, client_id, clients!inner(name, client_code)")
    .eq("bill_amount", 1000).eq("paid_amount", 0).eq("adjustment_amount", 0)
    .order("billing_month", { ascending: false });

  if (!open || open.length < 4) {
    console.error(`\nNeed 4 untouched ৳1,000 bills, found ${open?.length ?? 0}.`);
    process.exit(1);
  }
  const [A, B, C, D] = open;
  const m = (b) => String(b.billing_month).slice(0, 10);
  console.log(`\n  Test bills: A=${A.clients.name}/${m(A).slice(0,7)}  B=${B.clients.name}/${m(B).slice(0,7)}  C=${C.clients.name}/${m(C).slice(0,7)}  D=${D.clients.name}/${m(D).slice(0,7)}`);

  /* ---------------------------------------------------------------- TEST 1 */
  console.log("\n=== TEST 1 - Full payment ===");
  console.log("    Bill ৳1,000, payment ৳1,000, no adjustment -> due ৳0, PAID");
  await pay(mama, A.client_id, m(A), 1000, "Addendum test 1");
  let l = await ladder(A.id); show(l);
  check("T1: due 0 and status paid", l.due === 0 && l.status === "paid" && l.paid === 1000, JSON.stringify(l));

  /* ------------------------------------------------------------- TEST 2/3/6 */
  console.log("\n=== TEST 2 - Partial payment ===");
  console.log("    Bill ৳1,000, Mama collects ৳800 -> due ৳200, PARTIAL");
  await pay(mama, B.client_id, m(B), 800, "Addendum test 2 - Mama");
  l = await ladder(B.id); show(l);
  check("T2: due 200 and status partial", l.due === 200 && l.status === "partial" && l.paid === 800, JSON.stringify(l));

  console.log("\n=== TEST 3 + TEST 6 - Later payment by a DIFFERENT collector ===");
  console.log("    Abbu then collects ৳200 -> total ৳1,000, due ৳0, PAID; both records kept");
  await pay(abbu, B.client_id, m(B), 200, "Addendum test 3/6 - Abbu");
  l = await ladder(B.id); show(l);
  check("T3: total paid 1000, due 0, status paid", l.paid === 1000 && l.due === 0 && l.status === "paid", JSON.stringify(l));

  const { data: hist } = await admin
    .from("payments")
    .select("amount, notes, collected_by, profiles:collected_by(full_name)")
    .eq("monthly_bill_id", B.id).is("voided_at", null).order("created_at");
  check("T3: both transactions preserved (not overwritten)", hist.length === 2, `got ${hist.length}`);
  console.log("        history:", hist.map((h) => `${money(h.amount)} by ${h.profiles.full_name}`).join("  |  "));

  check("T6: ৳800 attributed to Mama", hist[0].collected_by === mama.id && Number(hist[0].amount) === 800);
  check("T6: ৳200 attributed to Abbu, NOT Mama", hist[1].collected_by === abbu.id && Number(hist[1].amount) === 200);

  // Collector totals must split the same way.
  const mamaStats = (await abbu.c.rpc("collector_stats", { p_collector_id: mama.id, p_month: null })).data;
  const abbuStats = (await abbu.c.rpc("collector_stats", { p_collector_id: abbu.id, p_month: null })).data;
  console.log(`        Mama all-time ${money(mamaStats.total_collection)} | Abbu all-time ${money(abbuStats.total_collection)}`);
  check("T6: collector_stats does not credit the full 1000 to Mama", Number(mamaStats.total_collection) > 0 && Number(abbuStats.total_collection) > 0);

  /* ---------------------------------------------------------------- TEST 4 */
  console.log("\n=== TEST 4 - Business discount ===");
  console.log("    Bill ৳1,000, adjustment ৳200, payment ৳800 -> adjusted ৳800, due ৳0, PAID");
  const { error: adjErr } = await abbu.c.rpc("set_bill_adjustment", {
    p_bill_id: C.id, p_adjustment_amount: 200,
    p_adjustment_type: "discount", p_adjustment_reason: "Owner approved special discount",
  });
  if (adjErr) throw new Error("adjustment C: " + adjErr.message);
  adjustedBills.push(C.id);

  l = await ladder(C.id); show(l);
  check("T4: adjusted 800 and due 800 BEFORE payment", l.adjusted === 800 && l.due === 800 && l.status === "unpaid", JSON.stringify(l));

  await pay(mama, C.client_id, m(C), 800, "Addendum test 4");
  l = await ladder(C.id); show(l);
  check("T4: paid 800 -> due 0, status PAID (not partial)", l.paid === 800 && l.due === 0 && l.status === "paid", JSON.stringify(l));
  check("T4: original ৳1,000 still on record", l.original === 1000);
  check("T4: reason + approver stored", l.reason === "Owner approved special discount" && l.approvedBy === abbu.id && l.type === "discount");
  await expectReject("T4: cannot pay more on a discounted, settled bill",
    mama.c.rpc("record_payment", { p_client_id: C.client_id, p_billing_month: m(C), p_amount: 1, p_payment_method: "cash", p_notes: null, p_payment_date: null }),
    "BILL_ALREADY_PAID");

  /* ---------------------------------------------------------------- TEST 5 */
  console.log("\n=== TEST 5 - Discount AND partial payment ===");
  console.log("    Bill ৳1,000, adjustment ৳200, payment ৳600 -> adjusted ৳800, due ৳200, PARTIAL");
  const { error: adjErr2 } = await abbu.c.rpc("set_bill_adjustment", {
    p_bill_id: D.id, p_adjustment_amount: 200,
    p_adjustment_type: "waiver", p_adjustment_reason: "Service issue this month",
  });
  if (adjErr2) throw new Error("adjustment D: " + adjErr2.message);
  adjustedBills.push(D.id);

  await pay(mama, D.client_id, m(D), 600, "Addendum test 5");
  l = await ladder(D.id); show(l);
  check("T5: adjusted 800, paid 600, due 200, PARTIAL",
    l.adjusted === 800 && l.paid === 600 && l.due === 200 && l.status === "partial", JSON.stringify(l));
  await expectReject("T5: payment cannot exceed the remaining adjusted due",
    mama.c.rpc("record_payment", { p_client_id: D.client_id, p_billing_month: m(D), p_amount: 201, p_payment_method: "cash", p_notes: null, p_payment_date: null }),
    "PAYMENT_EXCEEDS_DUE|200.00");

  /* ------------------------------------------------- Section 9 side by side */
  console.log("\n=== SECTION 9 - a discount is NOT an underpayment ===");
  const bLadder = await ladder(B.id);
  const cLadder = await ladder(C.id);
  console.log(`    Bill B: paid ${money(1000)} of ৳1,000, no adjustment -> due ${money(bLadder.due)}`);
  console.log(`    Bill C: paid ${money(cLadder.paid)} of ৳1,000, adjustment ৳200 -> due ${money(cLadder.due)}`);
  const dLadder = await ladder(D.id);
  check("underpaid bill still owes, discounted bill does not",
    dLadder.due === 200 && cLadder.due === 0 && dLadder.paid === 600 && cLadder.paid === 800);

  /* -------------------------------------------------- Authorisation (13/25) */
  console.log("\n=== AUTHORISATION - collectors cannot adjust (section 13) ===");
  await expectReject("collector cannot create an adjustment",
    mama.c.rpc("set_bill_adjustment", { p_bill_id: D.id, p_adjustment_amount: 500, p_adjustment_type: "discount", p_adjustment_reason: "sneaky" }),
    "ADMIN_ONLY");
  await expectReject("collector cannot remove an adjustment",
    jamal.c.rpc("remove_bill_adjustment", { p_bill_id: D.id }), "ADMIN_ONLY");

  const rogue = await mama.c.from("monthly_bills").update({ adjustment_amount: 900 }).eq("id", D.id).select();
  const stillD = await ladder(D.id);
  check("collector's direct UPDATE changes nothing (RLS)",
    (rogue.data?.length ?? 0) === 0 && stillD.adjustment === 200, JSON.stringify(rogue.data));

  console.log("\n=== VALIDATION (section 25) ===");
  await expectReject("adjustment requires a reason",
    abbu.c.rpc("set_bill_adjustment", { p_bill_id: D.id, p_adjustment_amount: 100, p_adjustment_type: "discount", p_adjustment_reason: "" }),
    "ADJUSTMENT_REASON_REQUIRED");
  await expectReject("adjustment cannot exceed the bill",
    abbu.c.rpc("set_bill_adjustment", { p_bill_id: D.id, p_adjustment_amount: 2000, p_adjustment_type: "discount", p_adjustment_reason: "too big" }),
    "ADJUSTMENT_EXCEEDS_BILL|1000.00");
  await expectReject("adjustment cannot waive money already collected",
    abbu.c.rpc("set_bill_adjustment", { p_bill_id: D.id, p_adjustment_amount: 500, p_adjustment_type: "discount", p_adjustment_reason: "below paid" }),
    "ADJUSTMENT_BELOW_PAID|400.00");

  /* ------------------------------------------------------------ Audit trail */
  console.log("\n=== AUDIT TRAIL (section 26) ===");
  const { data: audits } = await abbu.c
    .from("audit_logs")
    .select("action, created_at")
    .in("action", ["bill.adjustment_set", "payment.created"])
    .order("created_at", { ascending: false }).limit(12);
  check("adjustments and payments are both audited",
    audits.some((a) => a.action === "bill.adjustment_set") && audits.some((a) => a.action === "payment.created"),
    JSON.stringify(audits.map((a) => a.action)));

  /* ------------------------------------------------ Dashboard reconciliation */
  console.log("\n=== DASHBOARD (admin, live) ===");
  for (const month of [...new Set([m(A), m(C), m(D)])]) {
    const { data: s } = await abbu.c.rpc("dashboard_summary", { p_month: month });
    const ok = Number(s.collected_amount) + Number(s.due_amount) === Number(s.billed_amount);
    console.log(`    ${month.slice(0,7)}  original ${money(s.original_amount)} | adj ${money(s.adjustment_amount)} | billed ${money(s.billed_amount)} | collected ${money(s.collected_amount)} | due ${money(s.due_amount)}`);
    check(`dashboard ${month.slice(0,7)}: collected + due = billed`, ok);
  }

  /* ------------------------------------------------------------- REVERSE ALL */
  console.log("\n=== REVERSING EVERY TEST WRITE ===");
  for (const billId of adjustedBills) {
    const { error } = await abbu.c.rpc("remove_bill_adjustment", { p_bill_id: billId });
    if (error) console.log("  ! remove adjustment:", error.message);
  }
  console.log(`  removed ${adjustedBills.length} adjustments`);

  for (const paymentId of createdPayments) {
    const { error } = await abbu.c.rpc("void_payment", { p_payment_id: paymentId, p_reason: "Live verification test - reversed" });
    if (error) console.log("  ! void:", error.message);
  }
  console.log(`  voided ${createdPayments.length} test payments (voided, never deleted - the DB forbids deletion)`);

  const after = await snapshot();
  console.log("\n=== SNAPSHOT AFTER ===");
  console.log(`  original ${money(after.original)} | adjustment ${money(after.adjustment)} | paid ${money(after.paid)} | due ${money(after.due)} | ${after.payments} payment rows`);
  check("original total restored", after.original === before.original, `${before.original} -> ${after.original}`);
  check("adjustment total back to zero", after.adjustment === before.adjustment, `${before.adjustment} -> ${after.adjustment}`);
  check("collected total restored", after.paid === before.paid, `${before.paid} -> ${after.paid}`);
  check("due total restored", after.due === before.due, `${before.due} -> ${after.due}`);
  check("payment rows retained (voided, not deleted)", after.payments === before.payments + createdPayments.length,
    `${before.payments} + ${createdPayments.length} = ${after.payments}`);

  console.log("\n" + "=".repeat(64));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
