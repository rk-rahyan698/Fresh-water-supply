/**
 * Reproduces a Vercel build locally, before you push.
 *
 *   npm run verify:deploy
 *
 * WHY THIS EXISTS
 *
 * `npm run build` in your working tree is not the build Vercel runs. Vercel
 * builds a tree that contains only:
 *
 *   - files git tracks (untracked and gitignored files never leave your machine)
 *   - minus everything .vercelignore excludes
 *
 * ...with a clean `npm ci` and no .env.local. Any of those four differences can
 * turn a green local build into a red deploy, and this project has already been
 * bitten by one of them: `.vercelignore` had an unanchored `supabase/` rule,
 * which matches at ANY depth under gitignore semantics. It therefore deleted
 * src/lib/supabase/ - the Supabase clients the entire app imports - and the
 * deploy failed with sixteen copies of
 *
 *     Module not found: Can't resolve '@/lib/supabase/server'
 *
 * while `npm run build` locally stayed perfectly green, because the directory
 * was still there.
 *
 * So: this script materialises the exact tree Vercel would receive, installs
 * from the lockfile, and builds it with the environment variables removed. If
 * it passes here, the Vercel build will pass too.
 *
 * It does NOT check runtime behaviour - a build can succeed and every page
 * still return 500 because the Supabase env vars are missing or wrong in the
 * Vercel dashboard. See README "Deploying to Vercel".
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const KEEP = process.argv.includes("--keep");
const step = (msg) => console.log(`\n→ ${msg}`);
const ok = (msg) => console.log(`  OK    ${msg}`);
const die = (msg) => { console.error(`\n  FAIL  ${msg}\n`); process.exit(1); };

function run(cmd, args, cwd, extra = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  });
}

/**
 * npm and npx are `.cmd` shims on Windows, which Node refuses to spawn through
 * execFileSync (EINVAL since Node 20). They have to go through a shell, and a
 * single command string keeps Node from warning about unescaped arguments.
 * Every call site here passes fixed, non-user-supplied arguments.
 */
function runShell(command, cwd, extra = {}) {
  return execSync(command, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  });
}

/** Every entry at any depth whose basename matches `name` (`*` allowed). */
function findAnywhere(dir, name) {
  const rx = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const hits = [];
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (rx.test(entry.name)) hits.push(p);
      if (entry.isDirectory()) walk(p);
    }
  })(dir);
  return hits;
}

const root = process.cwd();
if (!existsSync(join(root, "package.json"))) die("run this from the project root");

const work = mkdtempSync(join(tmpdir(), "vercel-sim-"));
const tree = join(work, "tree");

try {
  /* ---------------------------------------------------------------- 1/5 */
  step("Exporting the tree Vercel would receive (git-tracked files only)");
  // Tracked paths, working-tree content: what you would get if you committed
  // and pushed right now. Untracked and .gitignored files are excluded, which
  // is the point - .env.local and next-env.d.ts never reach Vercel.
  const tracked = run("git", ["ls-files", "-z"], root).split("\0").filter(Boolean);
  if (tracked.length === 0) die("git ls-files returned nothing - is this a git repository?");

  for (const rel of tracked) {
    const src = join(root, rel);
    if (!existsSync(src)) continue; // tracked but deleted in the working tree
    const dest = join(tree, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  ok(`${tracked.length} tracked file(s) exported`);

  /* ---------------------------------------------------------------- 2/5 */
  step("Applying .vercelignore");
  const ignoreFile = join(root, ".vercelignore");
  const patterns = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];

  if (patterns.length === 0) {
    ok("no .vercelignore rules");
  } else {
    for (const pattern of patterns) {
      // gitignore semantics: a pattern with a leading or interior slash is
      // anchored to the root; one without matches at any depth. That second
      // case is the footgun this whole script exists to catch, so model it.
      const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
      const anchored = pattern.startsWith("/") || pattern.replace(/\/+$/, "").includes("/");
      const matches = anchored ? [join(tree, body)] : findAnywhere(tree, body);

      for (const m of matches) {
        if (existsSync(m)) {
          rmSync(m, { recursive: true, force: true });
          const rel = m.slice(tree.length + 1).replace(/\\/g, "/");
          const suspicious = rel.startsWith("src/");
          console.log(`  ${suspicious ? "WARN " : "     "} "${pattern}" removed ${rel}`);
          if (suspicious) {
            die(
              `.vercelignore rule "${pattern}" deletes ${rel}, which is application source.\n` +
              `        Anchor it with a leading slash (e.g. "/${body}/") so it only matches at the repo root.`,
            );
          }
        }
      }
    }
    ok(`${patterns.length} rule(s) applied, none touched src/`);
  }

  /* ---------------------------------------------------------------- 3/5 */
  step("Checking nothing the build needs was left behind");
  for (const required of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "src/app/layout.tsx"]) {
    if (!existsSync(join(tree, required))) die(`${required} is missing from the deployed tree`);
  }
  ok("required files present");

  /* ---------------------------------------------------------------- 4/5 */
  step("npm ci (clean install from the lockfile, as Vercel does)");
  try {
    runShell("npm ci --no-audit --no-fund", tree);
    ok("dependencies installed");
  } catch (e) {
    const log = `${e.stdout || ""}${e.stderr || ""}`.trim();
    die(
      "npm ci failed. The usual cause is package.json and package-lock.json " +
      "being out of sync -\n        run `npm install` and commit the updated lockfile.\n\n" +
      (log ? log.split("\n").slice(-20).join("\n") : e.message),
    );
  }

  /* ---------------------------------------------------------------- 5/5 */
  step("next build with NO environment variables set");
  // .env.local never reaches Vercel. If a module reads a required variable at
  // import time rather than at request time, this is where it shows up.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("NEXT_PUBLIC_") || k.startsWith("SUPABASE_") || k === "SEED_PASSWORD") delete env[k];
  }
  env.CI = "1";

  try {
    const out = runShell("npx next build", tree, { env });
    const routes = (out.match(/^[┌├└]\s+[ƒ○●]\s+\/.*$/gm) || []).length;
    ok(`build succeeded, ${routes} route(s) compiled`);
  } catch (e) {
    const log = `${e.stdout || ""}${e.stderr || ""}`;
    console.error(log.split("\n").slice(-40).join("\n"));
    die("next build failed in the deployment tree (it would fail on Vercel too)");
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log("DEPLOY CHECK PASSED - this tree builds the way Vercel builds it.");
  console.log("");
  console.log("Remember: a green build is not a green site. Vercel also needs");
  console.log("NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and");
  console.log("SUPABASE_SERVICE_ROLE_KEY set for Production, Preview and");
  console.log("Development, and your Vercel URL added to Supabase's redirect");
  console.log("allow-list. See README \"Deploying to Vercel\".");
  console.log("=".repeat(64));
} finally {
  if (KEEP) console.log(`\n(kept: ${work})`);
  else rmSync(work, { recursive: true, force: true });
}
