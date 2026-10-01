import { PrismaClient } from "@prisma/client";

// Prisma resolves SQLite file paths relative to prisma/schema.prisma.
// For local development we keep the database in the repository-level /db
// directory. `npm run dev` runs scripts/local-setup.mjs first, which creates
// the env file and syncs this schema automatically.
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
  process.env.DATABASE_URL = "file:../db/custom.db";
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
