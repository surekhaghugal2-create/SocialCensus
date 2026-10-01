# SocialCensus Instagram Analytics v26 Fix

This patch fixes the Instagram record/analytics pipeline for the current Instagram API with Instagram Login.

## What was wrong

1. Account analytics mixed legacy metrics (`profile_views`, old follower handling) with the current v26 metric set.
2. Most current account metrics are `metric_type=total_value`, but the old parser only read `values[]`. Valid Meta responses therefore appeared as `0`.
3. Range reach was calculated by summing daily reach. Reach is non-additive, so that can over-count unique accounts.
4. A token could be saved as "connected" even when it could not read Insights.
5. Content enrichment was slow because many independent media insight requests ran sequentially.
6. The production PostgreSQL Prisma schema did not contain the same exact Meta media fields as the local SQLite schema.

## Fixed workflow

- Account totals use the current v26 total-value metrics: reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, reposts and profile_links_taps.
- Daily chart uses Meta's reach time series.
- Follower growth uses `follows_and_unfollows` with the `follow_type` breakdown (`FOLLOWER - NON_FOLLOWER`).
- Exact selected-range totals are stored in `InstagramAccountInsightWindow` instead of fabricated by summing daily rows.
- `profile_views` is no longer requested. The account card now shows Profile link taps when Meta returns it.
- New token connections verify Insights access before the account is saved.
- Existing tokens without Insights permission now produce a clear reconnect/permission error instead of a successful sync full of zeros.
- Media rows are stored immediately and insight groups are fetched concurrently.

## Apply on Windows

Copy the patch files over your existing `social-census` project, keeping your existing `.env` and `db/custom.db`.

Then run:

```powershell
Ctrl + C
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Open `http://localhost:3002`.

Test with one account and a 30-day range first:

`Analytics -> select @bim_mantra -> 30 days -> Sync Instagram`

If SocialCensus reports that Insights permission is missing, generate a NEW Meta token after granting `instagram_business_manage_insights`, then reconnect the account. Do not reuse a token minted before that permission was granted.

## Data limits

Meta account-level User Insights are limited to recent history (up to 90 days). SocialCensus can retain its own stored records for longer after they have been synced. Media-level records can also be retained locally after sync.
