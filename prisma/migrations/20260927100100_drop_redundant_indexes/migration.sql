-- Each of these single- or two-column indexes is a left prefix of a unique
-- index on the same table, and a btree serves lookups on its left prefix, so
-- the unique index already answers every query and foreign-key check these
-- did (including the ON DELETE CASCADE lookups on userId, titleId and
-- seasonId). Dropping them saves maintaining an extra index on every insert,
-- most on Episode. Covering index for each:
--   Suppression_userId_idx       Suppression_userId_matchKey_key ("userId", "matchKey")
--   Title_userId_idx             Title_userId_mediaType_tmdbId_key ("userId", "mediaType", "tmdbId")
--   Title_userId_mediaType_idx   Title_userId_mediaType_tmdbId_key
--   Season_titleId_idx           Season_titleId_seasonNumber_key ("titleId", "seasonNumber")
--   Episode_seasonId_idx         Episode_seasonId_episodeNumber_key ("seasonId", "episodeNumber")
--   Tag_userId_idx               Tag_userId_name_key ("userId", "name")
-- Tag_userId_lower_name_key and the CHECK constraints are untouched.

-- DropIndex
DROP INDEX IF EXISTS "Suppression_userId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Title_userId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Title_userId_mediaType_idx";

-- DropIndex
DROP INDEX IF EXISTS "Season_titleId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Episode_seasonId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Tag_userId_idx";
