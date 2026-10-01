/**
 * SocialFlow local-development bootstrap.
 *
 * `npm run dev` invokes this automatically. It makes a fresh checkout usable
 * without requiring the developer to remember Prisma initialization steps.
 * It never runs for the production Docker start command.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const envPath = resolve(root, ".env");
const envExamplePath = resolve(root, ".env.example");
const dbDir = resolve(root, "db");
const legacyPrismaDbDir = resolve(root, "prisma", "db");
const rootDbFile = resolve(dbDir, "custom.db");
const legacyDbFile = resolve(legacyPrismaDbDir, "custom.db");

mkdirSync(dbDir, { recursive: true });
// Older SocialFlow packages used file:./db/custom.db which Prisma resolves
// below /prisma. Keep this directory available so an existing .env still
// boots, then migrate the default string below when it is safe to do so.
mkdirSync(legacyPrismaDbDir, { recursive: true });

function secret() {
  return randomBytes(32).toString("hex");
}

function buildFreshEnv() {
  let source = existsSync(envExamplePath)
    ? readFileSync(envExamplePath, "utf8")
    : 'DATABASE_URL="file:../db/custom.db"\n';

  source = source
    .replace(/JWT_SECRET="[^"]*"/, `JWT_SECRET="${secret()}"`)
    .replace(/TOKEN_ENCRYPTION_KEY="[^"]*"/, `TOKEN_ENCRYPTION_KEY="${secret()}"`)
    .replace(/CRON_SECRET="[^"]*"/, `CRON_SECRET="${secret()}"`);
  return source;
}

if (!existsSync(envPath)) {
  writeFileSync(envPath, buildFreshEnv(), "utf8");
  console.log("[SocialFlow] Created local .env with development secrets.");
} else {
  let env = readFileSync(envPath, "utf8");
  // Repair the exact path shipped by the previous package. Do not rewrite a
  // custom DATABASE_URL supplied by the developer.
  if (/DATABASE_URL\s*=\s*["']file:\.\/db\/custom\.db["']/.test(env)) {
    if (existsSync(legacyDbFile) && !existsSync(rootDbFile)) {
      copyFileSync(legacyDbFile, rootDbFile);
      console.log("[SocialFlow] Preserved the existing legacy SQLite database in /db/custom.db.");
    }
    env = env.replace(
      /DATABASE_URL\s*=\s*["']file:\.\/db\/custom\.db["']/,
      'DATABASE_URL="file:../db/custom.db"'
    );
    writeFileSync(envPath, env, "utf8");
    console.log("[SocialFlow] Repaired legacy SQLite database path in .env.");
  }
}

// Execute Prisma's JavaScript CLI entrypoint directly with Node.
// This avoids npx.cmd / .cmd spawning issues on Windows and also avoids
// package-exports resolution pointing at Prisma's type declarations.
const prismaCli = resolve(root, "node_modules", "prisma", "build", "index.js");
if (!existsSync(prismaCli)) {
  console.error("[SocialFlow] Prisma CLI is not installed correctly. Run npm install and try again.");
  console.error(`[SocialFlow] Missing: ${prismaCli}`);
  process.exit(1);
}

function runPrisma(args, label) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.error) {
    console.error(`[SocialFlow] ${label} could not start:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[SocialFlow] ${label} failed. Fix the message above and run npm run repair.`);
    process.exit(result.status ?? 1);
  }
}

console.log("[SocialFlow] Checking Prisma client…");
runPrisma(["generate"], "Prisma generate");
console.log("[SocialFlow] Syncing local database schema…");
runPrisma(["db", "push", "--skip-generate"], "Prisma db push");
console.log("[SocialFlow] Local database is ready.");
