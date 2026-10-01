import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/secrets";

const IG_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? "v26.0";
const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;

interface GraphErrorPayload {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

interface InsightValue {
  value?: number | string | Record<string, unknown>;
  end_time?: string;
}

interface InsightBreakdownResult {
  dimension_values?: string[];
  value?: number | string;
}

interface InsightBreakdown {
  dimension_keys?: string[];
  results?: InsightBreakdownResult[];
}

interface InsightItem {
  name?: string;
  values?: InsightValue[];
  value?: number | string;

  total_value?: {
    value?: number | string | Record<string, unknown>;
    breakdowns?: InsightBreakdown[];
  };
}

interface InsightPayload extends GraphErrorPayload {
  data?: InsightItem[];
}

export interface InstagramAnalyticsSyncResult {
  accountId: string;
  handle: string;
  status: "synced" | "failed" | "skipped";
  accountDays: number;
  mediaSynced: number;
  accountTotalsSynced?: boolean;
  accountTotalsError?: string;
  needsReconnect?: boolean;
  error?: string;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metricValue(payload: InsightPayload, name: string): number {
  const item = payload?.data?.find((m) => m.name === name);
  const value = item?.values?.[0]?.value ?? item?.value ?? item?.total_value?.value;
  return numberValue(value);
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function metricNullable(
  payload: InsightPayload | null | undefined,
  name: string,
): number | null {
  const item = payload?.data?.find(
    (metric) => metric.name === name,
  );

  if (!item) return null;

  const raw =
    item.values?.[0]?.value ??
    item.value ??
    item.total_value?.value;

  return nullableNumber(raw);
}

async function graphOptional<T>(
  url: string,
): Promise<T | null> {
  try {
    return await graphJson<T>(url);
  } catch {
    return null;
  }
}

function dayStart(input: Date | string) {
  const date = new Date(input);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function dayKey(input: Date | string) {
  return dayStart(input).toISOString().slice(0, 10);
}

function isInsightsPermissionError(message: string) {
  return /manage_insights|permission|permissions|oauth|access token|insufficient/i.test(message);
}

async function graphJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const message = body?.error?.message || body?.raw || `Instagram API request failed (${res.status})`;
    const error = new Error(String(message));
    (error as any).status = res.status;
    (error as any).payload = body;
    throw error;
  }
  return body as T;
}

async function fetchAccountProfile(externalUserId: string, token: string) {
  const params = new URLSearchParams({
    fields: "id,username,followers_count,media_count,profile_picture_url",
    access_token: token,
  });
  return graphJson<{
    id?: string;
    username?: string;
    followers_count?: number;
    media_count?: number;
    profile_picture_url?: string;
  }>(`${IG_GRAPH_BASE}/${externalUserId}?${params.toString()}`);
}

type AccountInsightTotals = {
  reach: number | null;
  views: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  replies: number | null;
  reposts: number | null;
  profileLinksTaps: number | null;
  follows: number | null;
  unfollows: number | null;
  netFollows: number | null;
};

function unixSeconds(input: Date) {
  return Math.floor(input.getTime() / 1000);
}

function endOfUtcDay(input: Date) {
  const value = new Date(input);
  value.setUTCHours(23, 59, 59, 999);
  return value;
}

function daysInclusive(since: Date, until: Date) {
  const a = dayStart(since).getTime();
  const b = dayStart(until).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

/**
 * Instagram User Insights v26:
 * - account totals are returned as metric_type=total_value
 * - only reach is used here as metric_type=time_series for the daily chart
 * - legacy profile_views is no longer requested
 *
 * The old implementation mixed legacy metrics with current metrics and parsed
 * only values[]. Valid total_value responses were therefore silently displayed
 * as zero.
 */
async function fetchAccountTotalMetricGroup(
  externalUserId: string,
  token: string,
  metrics: string[],
  since: Date,
  until: Date,
) {
  const request = async (metricList: string[]) => {
    const params = new URLSearchParams({
      metric: metricList.join(","),
      period: "day",
      metric_type: "total_value",
      since: String(unixSeconds(dayStart(since))),
      until: String(unixSeconds(endOfUtcDay(until))),
      access_token: token,
    });

    return graphJson<InsightPayload>(
      `${IG_GRAPH_BASE}/${externalUserId}/insights?${params.toString()}`,
    );
  };

  let groupedData: InsightItem[] = [];
  let groupedError: Error | null = null;

  try {
    const grouped = await request(metrics);
    groupedData = grouped.data ?? [];
  } catch (error) {
    groupedError =
      error instanceof Error
        ? error
        : new Error("Instagram account insights request failed");
  }

  const returned = new Set(
    groupedData
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name)),
  );

  const missing = metrics.filter((metric) => !returned.has(metric));
  const recoveredResults = await Promise.all(
    missing.map(async (metric) => {
      try {
        const payload = await request([metric]);
        return { items: payload.data ?? [], error: null as Error | null };
      } catch (error) {
        return {
          items: [] as InsightItem[],
          error:
            error instanceof Error
              ? error
              : new Error(`Instagram metric ${metric} failed`),
        };
      }
    }),
  );

  const byName = new Map<string, InsightItem>();
  for (const item of groupedData) {
    if (item.name) byName.set(item.name, item);
  }
  for (const result of recoveredResults) {
    for (const item of result.items) {
      if (item.name) byName.set(item.name, item);
    }
  }

  if (!byName.size) {
    const individualError =
      recoveredResults.find((result) => result.error)?.error;
    const everyIndividualRequestFailed =
      recoveredResults.length > 0 &&
      recoveredResults.every((result) => Boolean(result.error));

    // HTTP 200 + empty data is a valid Meta response when a metric has no
    // data for the selected window. Only fail when the grouped request and
    // every individual recovery request actually errored.
    if (groupedError && everyIndividualRequestFailed) {
      throw groupedError ?? individualError!;
    }
  }

  return { data: Array.from(byName.values()) } satisfies InsightPayload;
}

async function fetchFollowsAndUnfollows(
  externalUserId: string,
  token: string,
  since: Date,
  until: Date,
) {
  const params = new URLSearchParams({
    metric: "follows_and_unfollows",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    since: String(unixSeconds(dayStart(since))),
    until: String(unixSeconds(endOfUtcDay(until))),
    access_token: token,
  });

  return graphOptional<InsightPayload>(
    `${IG_GRAPH_BASE}/${externalUserId}/insights?${params.toString()}`,
  );
}

async function fetchAccountReachTimeSeries(
  externalUserId: string,
  token: string,
  since: Date,
  until: Date,
) {
  const params = new URLSearchParams({
    metric: "reach",
    period: "day",
    metric_type: "time_series",
    since: String(unixSeconds(dayStart(since))),
    until: String(unixSeconds(endOfUtcDay(until))),
    access_token: token,
  });

  return graphOptional<InsightPayload>(
    `${IG_GRAPH_BASE}/${externalUserId}/insights?${params.toString()}`,
  );
}

async function fetchAccountInsightsV26(
  externalUserId: string,
  token: string,
  since: Date,
  until: Date,
): Promise<{ totals: AccountInsightTotals; reachSeries: InsightPayload | null }> {
  const metrics = [
    "reach",
    "views",
    "accounts_engaged",
    "total_interactions",
    "likes",
    "comments",
    "shares",
    "saves",
    "replies",
    "reposts",
    "profile_links_taps",
  ];

  const [totalsPayload, followsPayload, reachSeries] = await Promise.all([
    fetchAccountTotalMetricGroup(externalUserId, token, metrics, since, until),
    fetchFollowsAndUnfollows(externalUserId, token, since, until),
    fetchAccountReachTimeSeries(externalUserId, token, since, until),
  ]);

  const followRows = breakdownEntries(followsPayload, "follows_and_unfollows");
  // Exact key matching is important: non_follower contains follower.
  const follows = findBreakdownValue(followRows, ["follower"]);
  const unfollows = findBreakdownValue(followRows, ["non_follower"]);

  return {
    totals: {
      reach: metricNullable(totalsPayload, "reach"),
      views: metricNullable(totalsPayload, "views"),
      accountsEngaged: metricNullable(totalsPayload, "accounts_engaged"),
      totalInteractions: metricNullable(totalsPayload, "total_interactions"),
      likes: metricNullable(totalsPayload, "likes"),
      comments: metricNullable(totalsPayload, "comments"),
      shares: metricNullable(totalsPayload, "shares"),
      saves: metricNullable(totalsPayload, "saves"),
      replies: metricNullable(totalsPayload, "replies"),
      reposts: metricNullable(totalsPayload, "reposts"),
      profileLinksTaps: metricNullable(totalsPayload, "profile_links_taps"),
      follows,
      unfollows,
      netFollows:
        follows !== null || unfollows !== null
          ? (follows ?? 0) - (unfollows ?? 0)
          : null,
    },
    reachSeries,
  };
}

function insightSeries(payload: InsightPayload | null | undefined) {
  const days = new Map<string, Record<string, number>>();
  for (const metric of payload?.data ?? []) {
    if (!metric.name) continue;
    for (const point of metric.values ?? []) {
      if (!point.end_time) continue;
      const key = dayKey(point.end_time);
      const bucket = days.get(key) ?? {};
      bucket[metric.name] = numberValue(point.value);
      days.set(key, bucket);
    }
  }
  return days;
}

interface InstagramMediaRow {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
}

async function fetchOwnedMedia(
  externalUserId: string,
  token: string,
  maxMedia = 60,
  mediaSince?: Date,
  mediaUntil?: Date,
) {
  const fields = [
    "id",
    "caption",
    "media_type",
    "media_product_type",
    "permalink",
    "timestamp",
    "thumbnail_url",
    "media_url",
    "like_count",
    "comments_count",
  ].join(",");
  const collected: InstagramMediaRow[] = [];
  let next: string | undefined = `${IG_GRAPH_BASE}/${externalUserId}/media?${new URLSearchParams({ fields, limit: "50", access_token: token }).toString()}`;

  while (next && collected.length < maxMedia) {
    const page: { data?: InstagramMediaRow[]; paging?: { next?: string } } = await graphJson(next);
    const rows = page.data ?? [];
    collected.push(...rows);

    if (mediaSince && rows.some((row) => {
      if (!row.timestamp) return false;
      const published = new Date(row.timestamp);
      return !Number.isNaN(published.getTime()) && published.getTime() <= mediaSince.getTime();
    })) {
      break;
    }

    next = page.paging?.next;
  }
  return collected
    .filter((row) => {
      if (!row.timestamp) return !mediaSince && !mediaUntil;
      const published = new Date(row.timestamp);
      if (Number.isNaN(published.getTime())) return false;
      if (mediaSince && published.getTime() < mediaSince.getTime()) return false;
      if (mediaUntil && published.getTime() > mediaUntil.getTime()) return false;
      return true;
    })
    .slice(0, maxMedia);
}

async function fetchMediaMetricGroup(
  mediaId: string,
  token: string,
  metrics: string[],
  metricType?: "total_value",
) {
  if (!metrics.length) {
    return { data: [] } satisfies InsightPayload;
  }

  const requestMetric = async (
    metric: string,
  ): Promise<InsightItem[]> => {
    const single = new URLSearchParams({
      metric,
      access_token: token,
    });

    if (metricType) {
      single.set("metric_type", metricType);
    }

    const response =
      await graphOptional<InsightPayload>(
        `${IG_GRAPH_BASE}/${mediaId}/insights?${single.toString()}`,
      );

    return response?.data ?? [];
  };

  const params = new URLSearchParams({
    metric: metrics.join(","),
    access_token: token,
  });

  if (metricType) {
    params.set("metric_type", metricType);
  }

  let groupedData: InsightItem[] = [];

  try {
    const grouped =
      await graphJson<InsightPayload>(
        `${IG_GRAPH_BASE}/${mediaId}/insights?${params.toString()}`,
      );

    groupedData =
      grouped.data ?? [];
  } catch {
    /*
     * If the grouped request itself fails, recover every metric
     * independently so one unsupported/temporarily unavailable
     * metric cannot hide the valid ones.
     */
    groupedData = [];
  }

  /*
   * IMPORTANT:
   *
   * Meta can return HTTP 200 for a grouped request while omitting
   * one or more requested metrics from data[].
   *
   * Previously SocialFlow treated that as a complete success and
   * never retried the omitted metric. That can make values such as
   * facebook_views, crossposted_views, profile_activity, follows,
   * or watch-time remain N/A even when an individual request works.
   *
   * Retry only the missing metric names one-by-one.
   */
  const returnedNames =
    new Set(
      groupedData
        .map((item) => item.name)
        .filter(
          (name): name is string =>
            typeof name === "string" &&
            name.length > 0,
        ),
    );

  const missingMetrics =
    metrics.filter(
      (metric) =>
        !returnedNames.has(metric),
    );

  /*
   * Recover omitted metrics in parallel.
   *
   * A large historical sync can include hundreds of media items. Waiting for
   * every missing metric one-by-one made the Content Analytics sync appear to
   * hang for a very long time. These requests are independent, so execute the
   * small recovery set concurrently for the current media item.
   */
  const recovered =
    (
      await Promise.all(
        missingMetrics.map(
          (metric) =>
            requestMetric(metric),
        ),
      )
    ).flat();

  /*
   * De-duplicate by metric name. Prefer the individually recovered
   * response for a metric if both grouped and individual requests
   * somehow returned it.
   */
  const byName =
    new Map<string, InsightItem>();

  for (const item of groupedData) {
    if (item.name) {
      byName.set(item.name, item);
    }
  }

  for (const item of recovered) {
    if (item.name) {
      byName.set(item.name, item);
    }
  }

  return {
    data: Array.from(
      byName.values(),
    ),
  } satisfies InsightPayload;
}

async function fetchMediaBreakdown(
  mediaId: string,
  token: string,
  metric: string,
  breakdown: string,
): Promise<InsightPayload | null> {
  const params = new URLSearchParams({
    metric,
    metric_type: "total_value",
    breakdown,
    access_token: token,
  });

  return graphOptional<InsightPayload>(
    `${IG_GRAPH_BASE}/${mediaId}/insights?${params.toString()}`,
  );
}

type MediaBreakdownEntry = {
  key: string;
  value: number;
};

function normalizeBreakdownKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function breakdownEntries(
  payload: InsightPayload | null | undefined,
  metricName: string,
): MediaBreakdownEntry[] {
  const item =
    payload?.data?.find(
      (metric) => metric.name === metricName,
    );

  if (!item) return [];

  const entries: MediaBreakdownEntry[] = [];

  for (
    const breakdown of
    item.total_value?.breakdowns ?? []
  ) {
    for (const row of breakdown.results ?? []) {
      const rawKey =
        row.dimension_values?.[0];

      const number =
        nullableNumber(row.value);

      if (!rawKey || number === null) {
        continue;
      }

      entries.push({
        key: normalizeBreakdownKey(rawKey),
        value: number,
      });
    }
  }

  return entries;
}

function findBreakdownValue(
  entries: MediaBreakdownEntry[],
  names: string[],
): number | null {
  const wanted =
    names.map(normalizeBreakdownKey);

  const matches =
    entries.filter((entry) =>
      wanted.includes(entry.key),
    );

  if (!matches.length) return null;

  return matches.reduce(
    (total, row) => total + row.value,
    0,
  );
}

async function fetchMediaInsights(
  mediaId: string,
  token: string,
  isReel: boolean,
) {
  /*
   * Fetch independent insight groups concurrently.
   *
   * The previous implementation waited for core -> totals -> profile -> each
   * breakdown -> Facebook -> Reel metrics in sequence. A 100+ post account
   * could therefore spend minutes in a single Sync request. Running the
   * independent groups together keeps the same data model while making the
   * historical content sync substantially faster.
   */
  const [
    corePayload,
    totalPayload,
    profilePayload,
    profileActivityBreakdownPayload,
    viewFollowBreakdownPayload,
    viewSurfaceBreakdownPayload,
    interactionFollowBreakdownPayload,
    facebookPayload,
    reelPayload,
  ] = await Promise.all([
    fetchMediaMetricGroup(
      mediaId,
      token,
      [
        "reach",
        "views",
        "likes",
        "comments",
        "saved",
        "shares",
        "total_interactions",
      ],
    ),
    fetchMediaMetricGroup(
      mediaId,
      token,
      [
        "total_views",
        "total_likes",
        "total_comments",
      ],
      "total_value",
    ),
    fetchMediaMetricGroup(
      mediaId,
      token,
      [
        "profile_activity",
        "profile_visits",
        "follows",
      ],
    ),
    fetchMediaBreakdown(
      mediaId,
      token,
      "profile_activity",
      "action_type",
    ),
    fetchMediaBreakdown(
      mediaId,
      token,
      "views",
      "follow_type",
    ),
    fetchMediaBreakdown(
      mediaId,
      token,
      "views",
      "surface_type",
    ),
    fetchMediaBreakdown(
      mediaId,
      token,
      "total_interactions",
      "follow_type",
    ),
    fetchMediaMetricGroup(
      mediaId,
      token,
      [
        "facebook_views",
        "crossposted_views",
      ],
      "total_value",
    ),
    isReel
      ? fetchMediaMetricGroup(
        mediaId,
        token,
        [
          "reels_skip_rate",
          "ig_reels_avg_watch_time",
          "ig_reels_video_view_total_time",
        ],
      )
      : Promise.resolve({ data: [] } satisfies InsightPayload),
  ]);

  const metaReach =
    metricNullable(
      corePayload,
      "reach",
    );

  const metaViews =
    metricNullable(
      corePayload,
      "views",
    );

  const metaTotalViews =
    metricNullable(
      totalPayload,
      "total_views",
    );

  const directFacebookViews =
    metricNullable(
      facebookPayload,
      "facebook_views",
    );

  const metaCrosspostedViews =
    metricNullable(
      facebookPayload,
      "crossposted_views",
    );

  /*
   * Prefer Meta's direct facebook_views.
   *
   * If Meta returns a combined total (total_views or crossposted_views) but
   * omits facebook_views, recover the Facebook component from that total.
   * This mirrors Instagram Professional Dashboard presentation:
   * total views = Instagram views + Facebook/cross-posted views.
   */
  const combinedMetaViews =
    metaTotalViews ??
    metaCrosspostedViews;

  const derivedFacebookViews =
    directFacebookViews === null &&
      combinedMetaViews !== null &&
      metaViews !== null &&
      combinedMetaViews >= metaViews
      ? combinedMetaViews - metaViews
      : null;

  const metaFacebookViews =
    directFacebookViews ??
    derivedFacebookViews;


  if (process.env.NODE_ENV !== "production") {
    const facebookNames =
      new Set(
        (facebookPayload.data ?? [])
          .map((item) => item.name)
          .filter(Boolean),
      );

    const stillMissing =
      [
        "facebook_views",
        "crossposted_views",
      ].filter(
        (metric) =>
          !facebookNames.has(metric),
      );

    if (stillMissing.length) {
      console.info(
        "[SocialFlow Meta Missing Media Metrics]",
        JSON.stringify({
          mediaId,
          missing: stillMissing,
        }),
      );
    }
  }

  /*
   * Total Views follows Meta's aggregate first:
   * 1. total_views
   * 2. crossposted_views
   * 3. Instagram + Facebook when both components are available
   */
  const metaDisplayViews =
    metaTotalViews ??
    metaCrosspostedViews ??
    (
      metaViews !== null &&
      metaFacebookViews !== null
        ? metaViews +
          metaFacebookViews
        : null
    );

  const metaLikes =
    metricNullable(
      corePayload,
      "likes",
    );

  const metaTotalLikes =
    metricNullable(
      totalPayload,
      "total_likes",
    );

  const metaComments =
    metricNullable(
      corePayload,
      "comments",
    );

  const metaTotalComments =
    metricNullable(
      totalPayload,
      "total_comments",
    );

  const metaShares =
    metricNullable(
      corePayload,
      "shares",
    );

  const metaSaves =
    metricNullable(
      corePayload,
      "saved",
    );

  const metaTotalInteractions =
    metricNullable(
      corePayload,
      "total_interactions",
    );

  /*
   * Followers / non-followers and view source breakdowns.
   *
   * Meta returns exact counts in total_value.breakdowns when the media type
   * and account support these breakdowns.
   */
  const viewFollowEntries =
    breakdownEntries(
      viewFollowBreakdownPayload,
      "views",
    );

  const interactionFollowEntries =
    breakdownEntries(
      interactionFollowBreakdownPayload,
      "total_interactions",
    );

  const viewSurfaceEntries =
    breakdownEntries(
      viewSurfaceBreakdownPayload,
      "views",
    );

  const metaFollowerViews =
    findBreakdownValue(
      viewFollowEntries,
      [
        "follower",
        "followers",
      ],
    );

  const metaNonFollowerViews =
    findBreakdownValue(
      viewFollowEntries,
      [
        "non_follower",
        "non_followers",
        "nonfollower",
        "nonfollowers",
      ],
    );

  const metaFollowerInteractions =
    findBreakdownValue(
      interactionFollowEntries,
      [
        "follower",
        "followers",
      ],
    );

  const metaNonFollowerInteractions =
    findBreakdownValue(
      interactionFollowEntries,
      [
        "non_follower",
        "non_followers",
        "nonfollower",
        "nonfollowers",
      ],
    );

  const metaFromHome =
    findBreakdownValue(
      viewSurfaceEntries,
      [
        "home",
        "feed",
      ],
    );

  const metaFromProfile =
    findBreakdownValue(
      viewSurfaceEntries,
      [
        "profile",
      ],
    );

  /*
   * Instagram groups remaining returned view surfaces under "Other".
   */
  const otherSurfaceRows =
    viewSurfaceEntries.filter(
      (entry) =>
        ![
          "home",
          "feed",
          "profile",
        ].includes(entry.key),
    );

  const metaFromOther =
    otherSurfaceRows.length
      ? otherSurfaceRows.reduce(
        (sum, row) => sum + row.value,
        0,
      )
      : null;

  /*
   * Profile activity total + exact action_type breakdowns when Meta exposes
   * them. We only map explicit returned action names; no subtraction or
   * estimation is used.
   */
  const profileActionEntries =
    breakdownEntries(
      profileActivityBreakdownPayload,
      "profile_activity",
    );

  const metaProfileActivity =
    metricNullable(
      profileActivityBreakdownPayload,
      "profile_activity",
    ) ??
    metricNullable(
      profilePayload,
      "profile_activity",
    );

  const metaProfileVisits =
    metricNullable(
      profilePayload,
      "profile_visits",
    ) ??
    findBreakdownValue(
      profileActionEntries,
      [
        "profile_visit",
        "profile_visits",
      ],
    );

  const metaFollows =
    metricNullable(
      profilePayload,
      "follows",
    ) ??
    findBreakdownValue(
      profileActionEntries,
      [
        "follow",
        "follows",
      ],
    );

  const metaExternalLinkTaps =
    findBreakdownValue(
      profileActionEntries,
      [
        "bio_link_clicked",
        "external_link_tap",
        "external_link_taps",
        "website_click",
        "website_clicks",
      ],
    );

  const metaBusinessAddressTaps =
    findBreakdownValue(
      profileActionEntries,
      [
        "direction",
        "directions",
        "get_directions",
        "business_address_tap",
        "business_address_taps",
      ],
    );

  /*
   * Development-only raw Meta diagnostics.
   *
   * This is intentionally server-side and is never returned to the browser.
   * On localhost it lets us compare the exact Meta payload for a media ID
   * with the Instagram app without inventing values.
   */
  if (process.env.NODE_ENV !== "production") {
    const compact = (payload: InsightPayload | null | undefined) =>
      (payload?.data ?? []).map((item) => ({
        name: item.name ?? null,
        value:
          item.values?.[0]?.value ??
          item.value ??
          item.total_value?.value ??
          null,
        breakdowns:
          item.total_value?.breakdowns ?? [],
      }));

    console.info(
      "[SocialFlow Meta Media Insights]",
      JSON.stringify(
        {
          mediaId,
          isReel,
          core: compact(corePayload),
          totals: compact(totalPayload),
          profile: compact(profilePayload),
          profileActivityBreakdown:
            compact(profileActivityBreakdownPayload),
          viewFollowBreakdown:
            compact(viewFollowBreakdownPayload),
          viewSurfaceBreakdown:
            compact(viewSurfaceBreakdownPayload),
          interactionFollowBreakdown:
            compact(interactionFollowBreakdownPayload),
          facebook: compact(facebookPayload),
          reel: compact(reelPayload),
        },
        null,
        2,
      ),
    );
  }

  /*
   * Reel performance.
   */
  const metaReelsSkipRate =
    metricNullable(
      reelPayload,
      "reels_skip_rate",
    );

  const avgWatchTimeMs =
    metricNullable(
      reelPayload,
      "ig_reels_avg_watch_time",
    );

  const totalWatchTimeMs =
    metricNullable(
      reelPayload,
      "ig_reels_video_view_total_time",
    );

  return {
    metaReach,

    metaViews,
    metaFacebookViews,
    metaCrosspostedViews,
    metaDisplayViews,
    metaTotalViews,

    metaLikes,
    metaTotalLikes,

    metaComments,
    metaTotalComments,

    metaShares,
    metaSaves,
    metaTotalInteractions,

    /*
     * There is no verified distinct public media "Viewers" or
     * "Accounts engaged" metric in this pipeline, so do not manufacture it.
     */
    metaAccountsEngaged: null,

    metaProfileActivity,
    metaProfileVisits,
    metaFollows,

    metaFollowerViews,
    metaNonFollowerViews,
    metaFollowerInteractions,
    metaNonFollowerInteractions,

    metaFromHome,
    metaFromProfile,
    metaFromOther,

    metaExternalLinkTaps,
    metaBusinessAddressTaps,

    metaReelsSkipRate,
    avgWatchTimeMs,
    totalWatchTimeMs,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let index = 0;
  const run = async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export async function syncInstagramAccountAnalytics(
  accountId: string,
  days = 90,
  maxMedia = 60,
  mediaSince?: Date,
  mediaUntil?: Date,
): Promise<InstagramAnalyticsSyncResult> {
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.platform !== "instagram") {
    return { accountId, handle: account?.handle ?? "Instagram", status: "skipped", accountDays: 0, mediaSynced: 0, error: "Instagram account not found" };
  }
  if (account.status !== "connected" || account.accessToken === "demo-token" || !account.externalUserId) {
    return { accountId, handle: account.handle, status: "skipped", accountDays: 0, mediaSynced: 0, error: "Instagram account is not connected with a real access token" };
  }

  try {
    const token = decryptSecret(account.accessToken);
    const now = new Date();
    const requestedUntil = dayStart(mediaUntil ?? now);
    const requestedSince = dayStart(
      mediaSince ??
        new Date(
          requestedUntil.getTime() -
            (Math.max(1, Math.min(90, days)) - 1) * 86400000,
        ),
    );
    const requestedDays = daysInclusive(requestedSince, requestedUntil);

    // Profile + owned media require only the basic Instagram permission and
    // should still load even if the Insights permission needs to be renewed.
    const [profile, media] = await Promise.all([
      fetchAccountProfile(account.externalUserId, token),
      fetchOwnedMedia(account.externalUserId, token, maxMedia, mediaSince, mediaUntil),
    ]);

    const today = dayStart(now);
    let accountDays = 0;
    let accountTotalsSynced = false;
    let accountTotalsError: string | undefined;
    let insightsPermissionFailure = false;

    if (requestedDays <= 90) {
      try {
        const accountInsights = await fetchAccountInsightsV26(
          account.externalUserId,
          token,
          requestedSince,
          requestedUntil,
        );

        const totals = accountInsights.totals;
        const windowSince = dayStart(requestedSince);
        const windowUntil = dayStart(requestedUntil);

        await db.instagramAccountInsightWindow.upsert({
          where: {
            socialAccountId_since_until: {
              socialAccountId: account.id,
              since: windowSince,
              until: windowUntil,
            },
          },
          update: {
            reach: totals.reach,
            views: totals.views,
            accountsEngaged: totals.accountsEngaged,
            totalInteractions: totals.totalInteractions,
            likes: totals.likes,
            comments: totals.comments,
            shares: totals.shares,
            saves: totals.saves,
            replies: totals.replies,
            reposts: totals.reposts,
            profileLinksTaps: totals.profileLinksTaps,
            follows: totals.follows,
            unfollows: totals.unfollows,
            netFollows: totals.netFollows,
            syncedAt: new Date(),
          },
          create: {
            socialAccountId: account.id,
            since: windowSince,
            until: windowUntil,
            reach: totals.reach,
            views: totals.views,
            accountsEngaged: totals.accountsEngaged,
            totalInteractions: totals.totalInteractions,
            likes: totals.likes,
            comments: totals.comments,
            shares: totals.shares,
            saves: totals.saves,
            replies: totals.replies,
            reposts: totals.reposts,
            profileLinksTaps: totals.profileLinksTaps,
            follows: totals.follows,
            unfollows: totals.unfollows,
            netFollows: totals.netFollows,
            syncedAt: new Date(),
          },
        });

        // Store only the metric that Meta currently exposes as a true daily
        // time series. Do not turn unavailable total_value metrics into zero.
        const series = insightSeries(accountInsights.reachSeries);
        for (const [dateString, values] of series.entries()) {
          const date = dayStart(dateString);
          await db.accountAnalyticsSnapshot.upsert({
            where: { socialAccountId_date: { socialAccountId: account.id, date } },
            update: {
              reach: values.reach ?? 0,
              syncedAt: new Date(),
            },
            create: {
              socialAccountId: account.id,
              date,
              reach: values.reach ?? 0,
              syncedAt: new Date(),
            },
          });
          accountDays += 1;
        }

        accountTotalsSynced = true;
      } catch (error) {
        accountTotalsError =
          error instanceof Error
            ? error.message
            : "Instagram account insights request failed";
        insightsPermissionFailure = isInsightsPermissionError(accountTotalsError);
      }
    } else {
      accountTotalsError =
        "Meta account-level User Insights can only be requested for a window of up to 90 days. Content records are still synced for the selected historical range.";
    }

    // Always keep an observed follower-total snapshot. This is independent of
    // the deprecated follower_count User Insights metric.
    await db.accountAnalyticsSnapshot.upsert({
      where: { socialAccountId_date: { socialAccountId: account.id, date: today } },
      update: { followers: numberValue(profile.followers_count), syncedAt: new Date() },
      create: {
        socialAccountId: account.id,
        date: today,
        followers: numberValue(profile.followers_count),
        syncedAt: new Date(),
      },
    });

    await db.socialAccount.update({
      where: { id: account.id },
      data: {
        followers: numberValue(profile.followers_count),
        avatarUrl: profile.profile_picture_url ?? account.avatarUrl,
        status: "connected",
      },
    });

    /*
     * Persist the media list immediately before the slower per-media Insights
     * enrichment begins. This makes Posts/Reels appear in Content Analytics
     * within seconds instead of leaving the dashboard at 0 until every Meta
     * insight request for the full historical range has completed.
     *
     * Reach/shares/saves and exact Meta fields are enriched below. Basic
     * like/comment counts come from the owned-media response when available.
     */
    await mapWithConcurrency(media, 10, async (item) => {
      const fallbackLikes = numberValue(item.like_count);
      const fallbackComments = numberValue(item.comments_count);
      const publishedAt = item.timestamp ? new Date(item.timestamp) : null;

      await db.instagramMediaInsight.upsert({
        where: {
          socialAccountId_externalMediaId: {
            socialAccountId: account.id,
            externalMediaId: item.id,
          },
        },
        update: {
          caption: item.caption ?? null,
          mediaType: item.media_type ?? null,
          mediaProductType: item.media_product_type ?? null,
          permalink: item.permalink ?? null,
          thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
          publishedAt,
          likes: fallbackLikes,
          comments: fallbackComments,
          totalInteractions: fallbackLikes + fallbackComments,
          syncedAt: new Date(),
        },
        create: {
          socialAccountId: account.id,
          externalMediaId: item.id,
          caption: item.caption ?? null,
          mediaType: item.media_type ?? null,
          mediaProductType: item.media_product_type ?? null,
          permalink: item.permalink ?? null,
          thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
          publishedAt,
          likes: fallbackLikes,
          comments: fallbackComments,
          totalInteractions: fallbackLikes + fallbackComments,
          syncedAt: new Date(),
        },
      });
    });

    if (insightsPermissionFailure) {
      return {
        accountId: account.id,
        handle: account.handle,
        status: "failed",
        accountDays,
        mediaSynced: media.length,
        accountTotalsSynced,
        accountTotalsError,
        needsReconnect: true,
        error:
          `${accountTotalsError}. Reconnect Instagram with instagram_business_manage_insights and generate a new token.`,
      };
    }

    let mediaSynced = 0;

    await mapWithConcurrency(media, 2, async (item) => {
      const isReel =
        (item.media_product_type ?? "").toUpperCase() === "REELS";

      const insights = await fetchMediaInsights(
        item.id,
        token,
        isReel,
      );

      const fallbackLikes =
        numberValue(item.like_count);

      const fallbackComments =
        numberValue(item.comments_count);

      const likes =
        insights.metaTotalLikes ??
        insights.metaLikes ??
        fallbackLikes;

      const comments =
        insights.metaTotalComments ??
        insights.metaComments ??
        fallbackComments;

      const shares =
        insights.metaShares ?? 0;

      const saves =
        insights.metaSaves ?? 0;

      const totalInteractions =
        insights.metaTotalInteractions ??
        (
          likes +
          comments +
          shares +
          saves
        );

      const legacyReach =
        insights.metaReach ?? 0;

      const legacyViews =
        insights.metaDisplayViews ??
        insights.metaViews ??
        0;

      const engagementRate =
        legacyReach > 0
          ? (
            totalInteractions /
            legacyReach
          ) * 100
          : 0;

      const publishedAt =
        item.timestamp
          ? new Date(item.timestamp)
          : null;

      /*
       * Store both legacy SocialFlow fields and the
       * exact nullable Meta insight values.
       */
      await db.instagramMediaInsight.upsert({
        where: {
          socialAccountId_externalMediaId: {
            socialAccountId: account.id,
            externalMediaId: item.id,
          },
        },

        update: {
          caption: item.caption ?? null,
          mediaType: item.media_type ?? null,
          mediaProductType:
            item.media_product_type ?? null,
          permalink: item.permalink ?? null,
          thumbnailUrl:
            item.thumbnail_url ??
            item.media_url ??
            null,
          publishedAt,

          /*
           * Existing SocialFlow fields.
           */
          reach: legacyReach,
          views: legacyViews,
          likes,
          comments,
          shares,
          saves,
          totalInteractions,
          engagementRate,

          avgWatchTimeMs:
            insights.avgWatchTimeMs,

          totalWatchTimeMs:
            insights.totalWatchTimeMs,

          /*
           * Exact Meta fields.
           * null means Meta did not return that metric.
           */
          metaReach:
            insights.metaReach,

          metaViews:
            insights.metaViews,

          metaTotalViews:
            insights.metaTotalViews,

          metaDisplayViews:
            insights.metaDisplayViews,

          metaFacebookViews:
            insights.metaFacebookViews,

          metaCrosspostedViews:
            insights.metaCrosspostedViews,

          metaLikes:
            insights.metaLikes,

          metaTotalLikes:
            insights.metaTotalLikes,

          metaComments:
            insights.metaComments,

          metaTotalComments:
            insights.metaTotalComments,

          metaShares:
            insights.metaShares,

          metaSaves:
            insights.metaSaves,

          metaTotalInteractions:
            insights.metaTotalInteractions,

          metaAccountsEngaged:
            insights.metaAccountsEngaged,

          metaProfileActivity:
            insights.metaProfileActivity,

          metaProfileVisits:
            insights.metaProfileVisits,

          metaFollows:
            insights.metaFollows,

          metaFollowerViews:
            insights.metaFollowerViews,

          metaNonFollowerViews:
            insights.metaNonFollowerViews,

          metaFollowerInteractions:
            insights.metaFollowerInteractions,

          metaNonFollowerInteractions:
            insights.metaNonFollowerInteractions,

          metaFromHome:
            insights.metaFromHome,

          metaFromProfile:
            insights.metaFromProfile,

          metaFromOther:
            insights.metaFromOther,

          metaExternalLinkTaps:
            insights.metaExternalLinkTaps,

          metaBusinessAddressTaps:
            insights.metaBusinessAddressTaps,

          metaReelsSkipRate:
            insights.metaReelsSkipRate,

          syncedAt: new Date(),
        },

        create: {
          socialAccountId: account.id,
          externalMediaId: item.id,

          caption: item.caption ?? null,
          mediaType: item.media_type ?? null,
          mediaProductType:
            item.media_product_type ?? null,
          permalink: item.permalink ?? null,
          thumbnailUrl:
            item.thumbnail_url ??
            item.media_url ??
            null,
          publishedAt,

          /*
           * Existing SocialFlow fields.
           */
          reach: legacyReach,
          views: legacyViews,
          likes,
          comments,
          shares,
          saves,
          totalInteractions,
          engagementRate,

          avgWatchTimeMs:
            insights.avgWatchTimeMs,

          totalWatchTimeMs:
            insights.totalWatchTimeMs,

          /*
           * Exact Meta fields.
           */
          metaReach:
            insights.metaReach,

          metaViews:
            insights.metaViews,

          metaTotalViews:
            insights.metaTotalViews,

          metaDisplayViews:
            insights.metaDisplayViews,

          metaFacebookViews:
            insights.metaFacebookViews,

          metaCrosspostedViews:
            insights.metaCrosspostedViews,

          metaLikes:
            insights.metaLikes,

          metaTotalLikes:
            insights.metaTotalLikes,

          metaComments:
            insights.metaComments,

          metaTotalComments:
            insights.metaTotalComments,

          metaShares:
            insights.metaShares,

          metaSaves:
            insights.metaSaves,

          metaTotalInteractions:
            insights.metaTotalInteractions,

          metaAccountsEngaged:
            insights.metaAccountsEngaged,

          metaProfileActivity:
            insights.metaProfileActivity,

          metaProfileVisits:
            insights.metaProfileVisits,

          metaFollows:
            insights.metaFollows,

          metaFollowerViews:
            insights.metaFollowerViews,

          metaNonFollowerViews:
            insights.metaNonFollowerViews,

          metaFollowerInteractions:
            insights.metaFollowerInteractions,

          metaNonFollowerInteractions:
            insights.metaNonFollowerInteractions,

          metaFromHome:
            insights.metaFromHome,

          metaFromProfile:
            insights.metaFromProfile,

          metaFromOther:
            insights.metaFromOther,

          metaExternalLinkTaps:
            insights.metaExternalLinkTaps,

          metaBusinessAddressTaps:
            insights.metaBusinessAddressTaps,

          metaReelsSkipRate:
            insights.metaReelsSkipRate,

          syncedAt: new Date(),
        },
      });

      /*
       * Keep legacy Analytics rows working for media that
       * was originally published through SocialFlow.
       */
      const target =
        await db.postTarget.findFirst({
          where: {
            socialAccountId: account.id,
            externalId: item.id,
          },
          select: {
            postId: true,
          },
        });

      if (target) {
        await db.analytics.upsert({
          where: {
            postId_socialAccountId_date: {
              postId: target.postId,
              socialAccountId: account.id,
              date: today,
            },
          },

          update: {
            reach: legacyReach,
            impressions: legacyViews,
            likes,
            comments,
            shares,
            saves,
            engagementRate,
          },

          create: {
            postId: target.postId,
            socialAccountId: account.id,
            date: today,
            reach: legacyReach,
            impressions: legacyViews,
            likes,
            comments,
            shares,
            saves,
            engagementRate,
          },
        });
      }

      /*
       * IMPORTANT:
       * This must stay INSIDE the mapWithConcurrency callback.
       */
      mediaSynced += 1;
    });

    return {
      accountId: account.id,
      handle: account.handle,
      status: "synced",
      accountDays,
      mediaSynced,
      accountTotalsSynced,
      accountTotalsError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram analytics sync failed";
    return {
      accountId: account.id,
      handle: account.handle,
      status: "failed",
      accountDays: 0,
      mediaSynced: 0,
      needsReconnect: isInsightsPermissionError(message),
      error: message,
    };
  }
}

/**
 * Backward-compatible cron entry point. It now syncs real account insights and
 * all recent Instagram-owned media, not only posts created inside SocialFlow.
 */
export async function syncInstagramAnalytics(limit = 100, accountId?: string) {
  const accounts = await db.socialAccount.findMany({
    where: {
      ...(accountId ? { id: accountId } : {}),
      platform: "instagram",
      status: "connected",
      accessToken: { not: "demo-token" },
      externalUserId: { not: null },
    },
    select: { id: true },
    take: accountId ? 1 : Math.max(1, Math.min(25, limit)),
  });

  const results: InstagramAnalyticsSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncInstagramAccountAnalytics(account.id, 90, 60));
  }
  return results;
}
