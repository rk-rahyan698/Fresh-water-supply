/**
 * Regenerates supabase/setup.sql from supabase/migrations/*.sql.
 *
 *   npm run build:setup
 *
 * setup.sql is the paste-into-the-Supabase-SQL-Editor version of the whole
 * schema. It used to be maintained by hand, which is how it ended up missing a
 * migration - a fresh project set up from it would then be running different
 * SQL from one set up with the CLI. Generating it removes that possibility:
 * the file is now a pure function of the migrations directory.
 *
 * `npm run verify:setup` re-runs this and fails if the checked-in file differs,
 * so a forgotten regeneration shows up as a failing check rather than as a
 * broken database three weeks later.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const TARGET = join(ROOT, "supabase", "setup.sql");

const HEADER = `-- =============================================================================
-- setup.sql  -  complete database setup in ONE file
--
-- GENERATED FILE - do not edit by hand.
-- Run \`npm run build:setup\` after changing anything in supabase/migrations/.
--
-- Every migration in supabase/migrations/ concatenated in order. Paste the
-- whole thing into a new query in the Supabase SQL Editor and Run.
--
-- It lives OUTSIDE supabase/migrations/ on purpose, so \`supabase db push\`
-- does not apply the same SQL twice. If you use the Supabase CLI, ignore this
-- file and push the migrations folder instead.
--
-- Safe to re-run on a database that already holds data.
-- =============================================================================

`;

export function buildSetupSql() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("no migrations found");

  const body = files
    .map((f) => {
      const banner = `\n\n-- >>>>>>>>>>>>>>>>>>>>>>>>  ${f}  <<<<<<<<<<<<<<<<<<<<<<<<\n\n`;
      // Normalise to LF so the generated file is byte-stable across platforms.
      return banner + readFileSync(join(MIGRATIONS, f), "utf8").replace(/\r\n/g, "\n").trimEnd() + "\n";
    })
    .join("");

  return { files, sql: HEADER + body.trimStart() + "\n" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const checkOnly = process.argv.includes("--check");
  const { files, sql } = buildSetupSql();

  if (checkOnly) {
    const current = readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
    if (current === sql) {
      console.log(`OK  setup.sql is up to date (${files.length} migrations)`);
      process.exit(0);
    }
    console.error(
      "FAIL  supabase/setup.sql is stale.\n" +
        "      Run `npm run build:setup` and commit the result.",
    );
    process.exit(1);
  }

  writeFileSync(TARGET, sql);
  console.log(`Wrote supabase/setup.sql from ${files.length} migrations:`);
  for (const f of files) console.log(`  ${f}`);
}
