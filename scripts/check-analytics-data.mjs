import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function safeDatabaseUrl(value) {
  if (!value) return "(missing)";
  if (value.startsWith("file:")) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(configured)";
  }
}

try {
  console.log("\nSocialCensus Analytics Data Check");
  console.log("Database:", safeDatabaseUrl(process.env.DATABASE_URL));

  const accounts = await prisma.socialAccount.findMany({
    where: { platform: "instagram" },
    select: {
      id: true,
      handle: true,
      status: true,
      followers: true,
      externalUserId: true,
      _count: {
        select: {
          accountAnalyticsSnapshots: true,
          instagramAccountInsightWindows: true,
          instagramMediaInsights: true,
        },
      },
    },
    orderBy: { connectedAt: "desc" },
  });

  const snapshots = await prisma.accountAnalyticsSnapshot.aggregate({
    _count: { _all: true },
    _min: { date: true, syncedAt: true },
    _max: { date: true, syncedAt: true },
  });

  const windows = await prisma.instagramAccountInsightWindow.aggregate({
    _count: { _all: true },
    _min: { since: true, until: true, syncedAt: true },
    _max: { since: true, until: true, syncedAt: true },
  });

  const media = await prisma.instagramMediaInsight.aggregate({
    _count: { _all: true },
    _min: { publishedAt: true, syncedAt: true },
    _max: { publishedAt: true, syncedAt: true },
  });

  console.log("Instagram accounts:", accounts.length);
  for (const account of accounts) {
    console.log(
      ` - ${account.handle}: ${account.status}, ${account.followers} followers, ` +
      `${account._count.accountAnalyticsSnapshots} daily reach snapshots, ` +
      `${account._count.instagramAccountInsightWindows} exact account-total windows, ` +
      `${account._count.instagramMediaInsights} media records, ` +
      `Instagram ID ${account.externalUserId ? "present" : "missing"}`,
    );
  }

  console.log("Daily reach snapshots:", snapshots._count._all);
  console.log("Exact account-total windows:", windows._count._all);
  console.log("Last exact account-total sync:", windows._max.syncedAt ?? "never");
  console.log("Media insight rows:", media._count._all);
  console.log("Media published range:", media._min.publishedAt ?? "none", "→", media._max.publishedAt ?? "none");
  console.log("Last media sync:", media._max.syncedAt ?? "never");

  if (accounts.length && media._count._all === 0) {
    console.log("\nRESULT: Account connection exists, but Content Analytics has no stored media yet.");
    console.log("Open Analytics → Content Analytics and run Sync Instagram. Keep the terminal open until it finishes.");
  } else if (media._count._all > 0) {
    console.log("\nRESULT: Media records exist. If the browser still shows 0, check the selected client/date range and confirm this is the same DATABASE_URL used by the running app.");
  } else {
    console.log("\nRESULT: No Instagram account/media records were found in this database.");
  }
} catch (error) {
  console.error("Analytics check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
