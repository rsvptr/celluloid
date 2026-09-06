import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  BACKUP_APP,
  BACKUP_SCHEMA_VERSION,
  backupEnvelopeSchema,
  backupTitleSchema,
  backupUserSchema,
  mergeBackupTitle,
  planRestoreTitles,
  type BackupEnvelope,
  type BackupEpisode,
  type BackupSeason,
  type BackupShare,
  type BackupSuppression,
  type BackupTag,
  type BackupTitle,
  type BackupWatchEvent,
  type RestoreMode,
  type RestorePlan,
  type RestorePreviewCounts,
} from "@/lib/backup-format";

const titleBackupInclude = {
  seasons: { include: { episodes: true } },
  tags: { include: { tag: true } },
} as const;

type TitleWithRelations = Prisma.TitleGetPayload<{
  include: typeof titleBackupInclude;
}>;

export interface BackupRestorePlan extends Omit<RestorePlan, "counts"> {
  counts: RestorePreviewCounts;
  /** Digest of the deterministic plan plus current state it may overwrite. */
  stateDigest: string;
}

export interface RestoreResult extends RestorePreviewCounts {
  sharesCreated: number;
  sharesSkipped: number;
  eventsCreated: number;
  eventsSkipped: number;
}

function iso(value: Date): string {
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value ? iso(value) : null;
}

function tagNameKey(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function snapshotTitle(
  title: TitleWithRelations,
  includeDerivedEpisodeMetadata = true,
): BackupTitle {
  return {
    sourceId: title.id,
    tmdbId: title.tmdbId,
    mediaType: title.mediaType,
    name: title.name,
    originalName: title.originalName,
    overview: title.overview,
    releaseDate: nullableIso(title.releaseDate),
    posterPath: title.posterPath,
    backdropPath: title.backdropPath,
    language: title.language,
    tmdbRating: title.tmdbRating,
    runtime: title.runtime,
    genres: [...title.genres],
    status: title.status,
    rating: title.rating,
    notes: title.notes,
    watchedAt: nullableIso(title.watchedAt),
    favorite: title.favorite,
    totalSeasons: title.totalSeasons,
    totalEpisodes: title.totalEpisodes,
    watchedEpisodes: title.watchedEpisodes,
    source: title.source,
    deletedAt: nullableIso(title.deletedAt),
    createdAt: iso(title.createdAt),
    updatedAt: iso(title.updatedAt),
    seasons: title.seasons
      .map((season) => ({
        sourceId: season.id,
        tmdbId: season.tmdbId,
        seasonNumber: season.seasonNumber,
        name: season.name,
        ...(includeDerivedEpisodeMetadata ? { overview: season.overview } : {}),
        airDate: nullableIso(season.airDate),
        posterPath: season.posterPath,
        episodeCount: season.episodeCount,
        episodes: season.episodes
          .map((episode) => ({
            sourceId: episode.id,
            tmdbId: episode.tmdbId,
            episodeNumber: episode.episodeNumber,
            name: episode.name,
            ...(includeDerivedEpisodeMetadata
              ? {
                  overview: episode.overview,
                  stillPath: episode.stillPath,
                }
              : {}),
            airDate: nullableIso(episode.airDate),
            runtime: episode.runtime,
            watched: episode.watched,
            watchedAt: nullableIso(episode.watchedAt),
          }))
          .sort((a, b) => a.episodeNumber - b.episodeNumber),
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber),
    tags: title.tags
      .map((join) => join.tag.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

export async function createBackupEnvelope(userId: string): Promise<BackupEnvelope> {
  return prisma.$transaction(
    async (tx) => {
      // The first read establishes the REPEATABLE READ snapshot. Stamp it
      // immediately afterwards rather than after a potentially long export.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          timeZone: true,
          watchRegion: true,
          myProviders: true,
          recommendModel: true,
        },
      });
      if (!user) throw new Error("Cannot back up a missing user.");
      const exportedAt = new Date().toISOString();
      // These reads may be grouped for latency, but they all use this transaction
      // client and therefore the same snapshot established above.
      const [titleRows, tagRows, shareRows, watchEventRows, suppressionRows] =
        await Promise.all([
          tx.title.findMany({
            where: { userId },
            include: titleBackupInclude,
            orderBy: { createdAt: "asc" },
          }),
          tx.tag.findMany({ where: { userId }, orderBy: { name: "asc" } }),
          tx.shareList.findMany({
            where: { userId },
            include: { items: { orderBy: { position: "asc" } } },
            orderBy: { createdAt: "asc" },
          }),
          tx.watchEvent.findMany({
            where: { userId },
            orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
          }),
          tx.suppression.findMany({
            where: { userId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
        ]);

      const ownedTitleIds = new Set(titleRows.map((title) => title.id));
      const backup: BackupEnvelope = {
        app: BACKUP_APP,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt,
        user: backupUserSchema.parse(user),
        // Season/episode prose and stills are TMDB-derived and can be refreshed
        // by metadata sync. Omitting them keeps new v2 exports materially leaner.
        titles: titleRows.map((title) => snapshotTitle(title, false)),
        tags: tagRows.map((tag) => ({
          sourceId: tag.id,
          name: tag.name,
          color: tag.color,
          createdAt: iso(tag.createdAt),
        })),
        shares: shareRows.map((share) => {
          const seenTitleIds = new Set<string>();
          const candidateTitleIds =
            share.scope === "WHOLE_LIBRARY"
              ? []
              : share.items.length > 0
                ? share.items.map((item) => item.titleId)
                : share.titleIds;
          // A legacy array can outlive its last title because it has no foreign
          // keys. Resolve it against this export's repeatable-read title
          // snapshot, then normalize order/positions without changing scope.
          const titleIds = candidateTitleIds.filter((titleId) => {
            if (!ownedTitleIds.has(titleId) || seenTitleIds.has(titleId)) return false;
            seenTitleIds.add(titleId);
            return true;
          });
          return {
            sourceId: share.id,
            name: share.name,
            titleIds,
            includeNotes: share.includeNotes,
            includeWatchlist: share.includeWatchlist,
            scope: share.scope,
            expiresAt: nullableIso(share.expiresAt),
            revokedAt: nullableIso(share.revokedAt),
            items: titleIds.map((titleId, index) => ({ titleId, position: index + 1 })),
            createdAt: iso(share.createdAt),
          };
        }),
        watchEvents: watchEventRows.map((event): BackupWatchEvent => ({
          sourceId: event.id,
          titleId: event.titleId,
          episodeId: event.episodeId,
          kind: event.kind,
          occurredAt: iso(event.occurredAt),
          source: event.source,
          note: event.note,
          createdAt: iso(event.createdAt),
        })),
        suppressions: suppressionRows.map((suppression): BackupSuppression => ({
          sourceId: suppression.id,
          matchKey: suppression.matchKey,
          tmdbId: suppression.tmdbId,
          mediaType: suppression.mediaType,
          name: suppression.name,
          year: suppression.year,
          reason: suppression.reason,
          createdAt: iso(suppression.createdAt),
        })),
      };

      return backupEnvelopeSchema.parse(backup);
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 45_000,
    },
  );
}

async function currentTitleSnapshots(userId: string): Promise<BackupTitle[]> {
  const rows = await prisma.title.findMany({
    where: { userId },
    include: titleBackupInclude,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((title) => snapshotTitle(title));
}

function restorePlanStateDigest(plan: RestorePlan, currentState: unknown): string {
  const planFingerprint = plan.items.map((item) => ({
    action: item.action,
    incomingSourceId: item.incoming.sourceId,
    ...("existingId" in item ? { existingId: item.existingId } : {}),
    ...(item.action === "update" ? { merged: item.merged } : {}),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ plan: planFingerprint, currentState }))
    .digest("base64url");
}

export async function analyzeBackupRestore(
  userId: string,
  backup: BackupEnvelope,
  mode: RestoreMode,
): Promise<BackupRestorePlan> {
  const [titles, suppressions, watchEvents, user, tags] = await Promise.all([
    currentTitleSnapshots(userId),
    prisma.suppression.findMany({
      where: { userId },
      select: {
        id: true,
        matchKey: true,
        tmdbId: true,
        mediaType: true,
        name: true,
        year: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.watchEvent.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        titleId: true,
        episodeId: true,
        kind: true,
        occurredAt: true,
        source: true,
        note: true,
        createdAt: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        timeZone: true,
        watchRegion: true,
        myProviders: true,
        recommendModel: true,
      },
    }),
    prisma.tag.findMany({
      where: { userId },
      select: { id: true, name: true, color: true, createdAt: true },
    }),
  ]);
  const titlePlan = planRestoreTitles(backup.titles, titles, mode);
  const eventsCreate = countWatchEventsToCreate(
    userId,
    backup.watchEvents,
    titlePlan,
    titles,
    watchEvents,
  );
  const currentByMatchKey = new Map(
    suppressions.map((suppression) => [suppression.matchKey, suppression]),
  );
  let suppressionsCreate = 0;
  let suppressionsUpdate = 0;
  let suppressionsSkip = 0;
  for (const incoming of backup.suppressions ?? []) {
    const current = currentByMatchKey.get(incoming.matchKey);
    if (!current) suppressionsCreate += 1;
    else if (mode === "replace-personal" && !sameSuppression(current, incoming)) {
      suppressionsUpdate += 1;
    } else suppressionsSkip += 1;
  }
  const providerPreferenceIncluded = backup.user.myProviders === undefined ? 0 : 1;
  const providerPreferenceUpdate =
    user &&
    backup.user.myProviders !== undefined &&
    mode === "replace-personal" &&
    !sameNumberIds(user.myProviders, backup.user.myProviders)
      ? 1
      : 0;
  const recommendModelPreferenceIncluded =
    backup.user.recommendModel === undefined ? 0 : 1;
  const recommendModelPreferenceUpdate =
    user &&
    backup.user.recommendModel !== undefined &&
    mode === "replace-personal" &&
    user.recommendModel !== backup.user.recommendModel
      ? 1
      : 0;
  const stateDigest = restorePlanStateDigest(titlePlan, {
    titles: [...titles].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    suppressions: suppressions
      .map((suppression) => ({
        ...suppression,
        createdAt: suppression.createdAt.toISOString(),
      }))
      .sort((left, right) =>
        left.matchKey.localeCompare(right.matchKey) || left.id.localeCompare(right.id),
      ),
    watchEvents: watchEvents
      .map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    user: user
      ? {
          timeZone: user.timeZone,
          watchRegion: user.watchRegion,
          myProviders: [...user.myProviders],
          recommendModel: user.recommendModel,
        }
      : null,
    tags: tags
      .map((tag) => ({ ...tag, createdAt: tag.createdAt.toISOString() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });

  return {
    ...titlePlan,
    stateDigest,
    counts: {
      ...titlePlan.counts,
      eventsCreate,
      suppressionsCreate,
      suppressionsUpdate,
      suppressionsSkip,
      providerSelections: backup.user.myProviders?.length ?? 0,
      providerPreferenceIncluded,
      providerPreferenceUpdate,
      recommendModelPreferenceIncluded,
      recommendModelPreferenceUpdate,
    },
  };
}

function nullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function suppressionScalars(suppression: BackupSuppression) {
  return {
    matchKey: suppression.matchKey,
    tmdbId: suppression.tmdbId,
    mediaType: suppression.mediaType,
    name: suppression.name,
    year: suppression.year,
    reason: suppression.reason,
    createdAt: new Date(suppression.createdAt),
  };
}

function sameSuppression(
  current: {
    matchKey: string;
    tmdbId: number | null;
    mediaType: BackupSuppression["mediaType"];
    name: string;
    year: number | null;
    reason: BackupSuppression["reason"];
    createdAt: Date;
  },
  incoming: BackupSuppression,
): boolean {
  return (
    current.matchKey === incoming.matchKey &&
    current.tmdbId === incoming.tmdbId &&
    current.mediaType === incoming.mediaType &&
    current.name === incoming.name &&
    current.year === incoming.year &&
    current.reason === incoming.reason &&
    current.createdAt.getTime() === new Date(incoming.createdAt).getTime()
  );
}

function titleScalars(title: BackupTitle) {
  return {
    tmdbId: title.tmdbId,
    mediaType: title.mediaType,
    name: title.name,
    originalName: title.originalName,
    overview: title.overview,
    releaseDate: nullableDate(title.releaseDate),
    posterPath: title.posterPath,
    backdropPath: title.backdropPath,
    language: title.language,
    tmdbRating: title.tmdbRating,
    runtime: title.runtime,
    genres: title.genres,
    status: title.status,
    rating: title.rating,
    notes: title.notes,
    watchedAt: nullableDate(title.watchedAt),
    favorite: title.favorite,
    totalSeasons: title.totalSeasons,
    totalEpisodes: title.totalEpisodes,
    watchedEpisodes: title.watchedEpisodes,
    source: title.source,
    deletedAt: nullableDate(title.deletedAt),
  };
}

function seasonScalars(season: BackupSeason) {
  return {
    tmdbId: season.tmdbId,
    seasonNumber: season.seasonNumber,
    name: season.name,
    overview: season.overview,
    airDate: nullableDate(season.airDate),
    posterPath: season.posterPath,
    episodeCount: season.episodeCount,
  };
}

function episodeScalars(episode: BackupEpisode) {
  return {
    tmdbId: episode.tmdbId,
    episodeNumber: episode.episodeNumber,
    name: episode.name,
    overview: episode.overview,
    airDate: nullableDate(episode.airDate),
    runtime: episode.runtime,
    stillPath: episode.stillPath,
    watched: episode.watched,
    watchedAt: nullableDate(episode.watchedAt),
  };
}

async function restoreTags(
  userId: string,
  tags: BackupTag[],
  mode: RestoreMode,
) {
  for (const tag of tags) {
    let existing = await prisma.tag.findFirst({
      where: { userId, name: { equals: tag.name, mode: "insensitive" } },
    });
    if (!existing) {
      try {
        existing = await prisma.tag.create({
          data: {
            userId,
            name: tag.name,
            color: tag.color,
            createdAt: new Date(tag.createdAt),
          },
        });
      } catch (error) {
        if (
          error === null ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        // A concurrent restore may win the case-insensitive unique-index race.
        // Re-read and reuse its canonical casing; only suppress the error when
        // the colliding row now demonstrably exists for this owner.
        existing = await prisma.tag.findFirst({
          where: { userId, name: { equals: tag.name, mode: "insensitive" } },
        });
        if (!existing) throw error;
      }
    }

    const color =
      mode === "replace-personal" ? tag.color : (existing.color ?? tag.color);
    if (color !== existing.color) {
      await prisma.tag.update({ where: { id: existing.id }, data: { color } });
    }
  }
}

async function restoreSuppressions(
  userId: string,
  suppressions: BackupSuppression[],
  mode: RestoreMode,
): Promise<Pick<
  RestorePreviewCounts,
  "suppressionsCreate" | "suppressionsUpdate" | "suppressionsSkip"
>> {
  let suppressionsCreate = 0;
  let suppressionsUpdate = 0;
  let suppressionsSkip = 0;

  // Suppressions are keyed by owner + matchKey, not by their exported id. That
  // is the durable identity used by the recommendation engine and it also
  // avoids a source-id collision when restoring into a database that already
  // contains another owner's rows.
  for (const suppression of suppressions) {
    let existing = await prisma.suppression.findUnique({
      where: { userId_matchKey: { userId, matchKey: suppression.matchKey } },
    });
    if (!existing) {
      try {
        await prisma.suppression.create({
          data: { userId, ...suppressionScalars(suppression) },
        });
        suppressionsCreate += 1;
        continue;
      } catch (error) {
        if (
          error === null ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        // A concurrent restore may win the unique-key race. Re-read and reuse
        // that row; suppress only when the owner/matchKey collision now exists.
        existing = await prisma.suppression.findUnique({
          where: { userId_matchKey: { userId, matchKey: suppression.matchKey } },
        });
        if (!existing) throw error;
      }
    }

    if (mode === "replace-personal" && !sameSuppression(existing, suppression)) {
      await prisma.suppression.update({
        where: { id: existing.id },
        data: suppressionScalars(suppression),
      });
      suppressionsUpdate += 1;
    } else {
      suppressionsSkip += 1;
    }
  }

  return { suppressionsCreate, suppressionsUpdate, suppressionsSkip };
}

async function createTitle(
  tx: Prisma.TransactionClient,
  userId: string,
  title: BackupTitle,
  tagIdsByName: Map<string, string>,
): Promise<string> {
  const occupiedId = await tx.title.findUnique({
    where: { id: title.sourceId },
    select: { id: true },
  });
  const created = await tx.title.create({
    data: {
      id: occupiedId ? undefined : title.sourceId,
      userId,
      ...titleScalars(title),
      createdAt: new Date(title.createdAt),
      updatedAt: new Date(title.updatedAt),
    },
    select: { id: true },
  });

  const tagIds = title.tags
    .map((name) => tagIdsByName.get(tagNameKey(name)))
    .filter((id): id is string => Boolean(id));
  if (tagIds.length > 0) {
    await tx.titleTag.createMany({
      data: tagIds.map((tagId) => ({ titleId: created.id, tagId })),
      skipDuplicates: true,
    });
  }

  for (const season of title.seasons) {
    const createdSeason = await tx.season.create({
      data: { titleId: created.id, ...seasonScalars(season) },
      select: { id: true },
    });
    if (season.episodes.length > 0) {
      await tx.episode.createMany({
        data: season.episodes.map((episode) => ({
          seasonId: createdSeason.id,
          ...episodeScalars(episode),
          // See the restore path: a recovered episode is not a newly aired one,
          // so it must not trip the "New episodes" badge.
          discoveredAt: new Date(title.createdAt),
        })),
      });
    }
  }

  return created.id;
}

async function updateTitle(
  tx: Prisma.TransactionClient,
  userId: string,
  titleId: string,
  incoming: BackupTitle,
  mode: RestoreMode,
  tagIdsByName: Map<string, string>,
): Promise<string> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
  if (!locked[0]) return createTitle(tx, userId, incoming, tagIdsByName);

  const current = await tx.title.findUnique({
    where: { id: titleId },
    include: titleBackupInclude,
  });
  if (!current) return createTitle(tx, userId, incoming, tagIdsByName);

  const merged = mergeBackupTitle(snapshotTitle(current), incoming, mode);
  await tx.title.update({
    where: { id: current.id },
    data: titleScalars(merged),
  });

  await tx.titleTag.deleteMany({ where: { titleId: current.id } });
  const tagIds = merged.tags
    .map((name) => tagIdsByName.get(tagNameKey(name)))
    .filter((id): id is string => Boolean(id));
  if (tagIds.length > 0) {
    await tx.titleTag.createMany({
      data: tagIds.map((tagId) => ({ titleId: current.id, tagId })),
      skipDuplicates: true,
    });
  }

  // Season/episode reconciliation is SET-BASED. The previous implementation did
  // two sequential round trips per episode (a findUnique then an update/create),
  // so a 450-episode show cost ~900 queries and a full library restore ran to
  // tens of thousands — comfortably past this route's maxDuration, which killed
  // the request mid-write with no resume cursor. Now: one read for all seasons,
  // one read for all episodes, a single createMany for what's missing, and an
  // update only for rows whose scalars actually differ. Restoring a backup onto
  // an unchanged library issues almost no writes at all.
  const existingSeasons = await tx.season.findMany({
    where: { titleId: current.id },
    select: { id: true, seasonNumber: true },
  });
  const seasonIdByNumber = new Map(
    existingSeasons.map((season) => [season.seasonNumber, season.id]),
  );

  for (const season of merged.seasons) {
    const existingId = seasonIdByNumber.get(season.seasonNumber);
    if (existingId) {
      await tx.season.update({ where: { id: existingId }, data: seasonScalars(season) });
    } else {
      const createdSeason = await tx.season.create({
        data: { titleId: current.id, ...seasonScalars(season) },
        select: { id: true },
      });
      seasonIdByNumber.set(season.seasonNumber, createdSeason.id);
    }
  }

  const existingEpisodes = await tx.episode.findMany({
    where: { season: { titleId: current.id } },
    select: {
      id: true,
      seasonId: true,
      tmdbId: true,
      episodeNumber: true,
      name: true,
      overview: true,
      airDate: true,
      runtime: true,
      stillPath: true,
      watched: true,
      watchedAt: true,
    },
  });
  const episodeByKey = new Map(
    existingEpisodes.map((episode) => [
      `${episode.seasonId}:${episode.episodeNumber}`,
      episode,
    ]),
  );

  const episodeCreates: Prisma.EpisodeCreateManyInput[] = [];
  for (const season of merged.seasons) {
    const seasonId = seasonIdByNumber.get(season.seasonNumber);
    if (!seasonId) continue; // unreachable: every merged season was upserted above
    for (const episode of season.episodes) {
      const scalars = episodeScalars(episode);
      const existingEpisode = episodeByKey.get(`${seasonId}:${episode.episodeNumber}`);
      if (!existingEpisode) {
        episodeCreates.push({
          seasonId,
          ...scalars,
          // Don't let a restore fire the "New episodes" badge. discoveredAt means
          // "TMDB gained this episode since you last looked", which a restore is
          // not — so materialize recovered rows as old as the title itself
          // rather than taking the schema's now() default.
          discoveredAt: new Date(merged.createdAt),
        });
      } else if (!sameEpisodeScalars(existingEpisode, scalars)) {
        await tx.episode.update({ where: { id: existingEpisode.id }, data: scalars });
      }
    }
  }
  if (episodeCreates.length > 0) {
    await tx.episode.createMany({ data: episodeCreates, skipDuplicates: true });
  }

  if (merged.mediaType === "TV") {
    // Re-derive BOTH counters from the rows that now exist. mergeBackupTitle
    // already computes them, but recounting here keeps the denormalized cache
    // authoritative even if a concurrent write slipped in under the row lock.
    const [watchedEpisodes, totalEpisodes] = await Promise.all([
      tx.episode.count({ where: { season: { titleId: current.id }, watched: true } }),
      tx.episode.count({ where: { season: { titleId: current.id } } }),
    ]);
    await tx.title.update({
      where: { id: current.id },
      data: {
        // Counter-only TV imports legitimately have progress without materialized
        // Episode rows. In that state the merge's counters are the only durable
        // source, so a zero-row recount must not erase watchedEpisodes.
        ...(totalEpisodes > 0 ? { watchedEpisodes, totalEpisodes } : {}),
      },
    });
  }

  return current.id;
}

/**
 * True when a stored episode row already matches the scalars a restore would
 * write, so the update can be skipped. Dates are compared by instant (the row
 * holds Date objects, the backup yields freshly parsed ones).
 */
function sameEpisodeScalars(
  existing: {
    tmdbId: number | null;
    name: string | null;
    overview: string | null;
    airDate: Date | null;
    runtime: number | null;
    stillPath: string | null;
    watched: boolean;
    watchedAt: Date | null;
  },
  next: ReturnType<typeof episodeScalars>,
): boolean {
  const sameDate = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();
  return (
    existing.tmdbId === next.tmdbId &&
    existing.name === next.name &&
    (next.overview === undefined || existing.overview === next.overview) &&
    sameDate(existing.airDate, next.airDate) &&
    existing.runtime === next.runtime &&
    (next.stillPath === undefined || existing.stillPath === next.stillPath) &&
    existing.watched === next.watched &&
    sameDate(existing.watchedAt, next.watchedAt)
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumberIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function uniqueShareSlug(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = randomBytes(12).toString("base64url");
    const exists = await tx.shareList.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!exists) return slug;
  }
  throw new Error("Could not generate a unique restored share link.");
}

async function restoreShares(
  userId: string,
  shares: BackupShare[],
  sourceToLocalTitleId: Map<string, string>,
  mode: RestoreMode,
): Promise<{ sharesCreated: number; sharesSkipped: number }> {
  let sharesCreated = 0;
  let sharesSkipped = 0;

  for (const batch of chunks(shares, 25)) {
    const batchResult = await prisma.$transaction(
      async (tx) => {
        let created = 0;
        let skipped = 0;
        for (const share of batch) {
          const titleIds = [...share.items]
            .sort((left, right) => left.position - right.position)
            .map((item) => sourceToLocalTitleId.get(item.titleId))
            .filter((id): id is string => Boolean(id));
          if (titleIds.length !== share.items.length) {
            skipped += 1;
            continue;
          }

          const occupied = await tx.shareList.findUnique({
            where: { id: share.sourceId },
            select: { id: true, userId: true },
          });
          if (occupied?.userId === userId) {
            if (mode === "replace-personal") {
              await tx.shareList.update({
                where: { id: occupied.id },
                data: {
                  name: share.name,
                  // ShareListItem is authoritative. Clearing the legacy array
                  // prevents an intentionally empty selection from later being
                  // interpreted as an unmigrated whole-library share.
                  titleIds: [],
                  includeNotes: share.includeNotes,
                  includeWatchlist: share.includeWatchlist,
                  scope: share.scope,
                  expiresAt: nullableDate(share.expiresAt),
                  revokedAt: nullableDate(share.revokedAt),
                  createdAt: new Date(share.createdAt),
                },
              });
              await tx.shareListItem.deleteMany({
                where: { shareListId: occupied.id },
              });
              if (titleIds.length > 0) {
                await tx.shareListItem.createMany({
                  data: titleIds.map((titleId, index) => ({
                    shareListId: occupied.id,
                    titleId,
                    position: index + 1,
                  })),
                });
              }
            }
            skipped += 1;
            continue;
          }

          const candidates = await tx.shareList.findMany({
            where: {
              userId,
              name: share.name,
              includeNotes: share.includeNotes,
              includeWatchlist: share.includeWatchlist,
              scope: share.scope,
              expiresAt: nullableDate(share.expiresAt),
              revokedAt: nullableDate(share.revokedAt),
              createdAt: new Date(share.createdAt),
            },
            include: { items: { orderBy: { position: "asc" } } },
          });
          if (
            candidates.some((candidate) =>
              sameIds(
                candidate.items.map((item) => item.titleId),
                titleIds,
              ),
            )
          ) {
            skipped += 1;
            continue;
          }

          const restoredShare = await tx.shareList.create({
            data: {
              id: occupied ? undefined : share.sourceId,
              userId,
              slug: await uniqueShareSlug(tx),
              name: share.name,
              titleIds: [],
              includeNotes: share.includeNotes,
              includeWatchlist: share.includeWatchlist,
              scope: share.scope,
              expiresAt: nullableDate(share.expiresAt),
              revokedAt: nullableDate(share.revokedAt),
              createdAt: new Date(share.createdAt),
            },
            select: { id: true },
          });
          if (titleIds.length > 0) {
            await tx.shareListItem.createMany({
              data: titleIds.map((titleId, index) => ({
                shareListId: restoredShare.id,
                titleId,
                position: index + 1,
              })),
            });
          }
          created += 1;
        }
        return { created, skipped };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    sharesCreated += batchResult.created;
    sharesSkipped += batchResult.skipped;
  }

  return { sharesCreated, sharesSkipped };
}

async function restoreUserPreferences(
  userId: string,
  backup: BackupEnvelope,
  mode: RestoreMode,
) {
  if (mode !== "replace-personal") return;
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!current) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      timeZone: backup.user.timeZone,
      watchRegion: backup.user.watchRegion,
      ...(backup.user.myProviders !== undefined
        ? { myProviders: backup.user.myProviders }
        : {}),
      ...(backup.user.recommendModel !== undefined
        ? { recommendModel: backup.user.recommendModel }
        : {}),
    },
  });
}

async function mapRestoredEpisodes(
  backup: BackupEnvelope,
  sourceToLocalTitleId: Map<string, string>,
): Promise<Map<string, string>> {
  const localToSource = new Map<string, string>();
  for (const [sourceId, localId] of sourceToLocalTitleId) localToSource.set(localId, sourceId);
  const sourceTitles = new Map(backup.titles.map((title) => [title.sourceId, title]));
  const episodeIds = new Map<string, string>();

  for (const localIds of chunks([...localToSource.keys()], 100)) {
    const rows = await prisma.title.findMany({
      where: { id: { in: localIds } },
      include: { seasons: { include: { episodes: true } } },
    });
    for (const row of rows) {
      const sourceTitle = sourceTitles.get(localToSource.get(row.id) ?? "");
      if (!sourceTitle) continue;
      const localSeasons = new Map(row.seasons.map((season) => [season.seasonNumber, season]));
      for (const sourceSeason of sourceTitle.seasons) {
        const localSeason = localSeasons.get(sourceSeason.seasonNumber);
        if (!localSeason) continue;
        const localEpisodes = new Map(
          localSeason.episodes.map((episode) => [episode.episodeNumber, episode.id]),
        );
        for (const sourceEpisode of sourceSeason.episodes) {
          const localEpisodeId = localEpisodes.get(sourceEpisode.episodeNumber);
          if (localEpisodeId) episodeIds.set(sourceEpisode.sourceId, localEpisodeId);
        }
      }
    }
  }
  return episodeIds;
}

function watchEventDedupKey(event: {
  titleId: string;
  episodeId: string | null;
  kind: BackupWatchEvent["kind"];
  occurredAt: Date;
  source: BackupWatchEvent["source"];
  note: string | null;
}): string {
  return JSON.stringify([
    event.titleId,
    event.episodeId,
    event.kind,
    event.occurredAt.toISOString(),
    event.source,
    event.note,
  ]);
}

type StoredWatchEvent = {
  id: string;
  userId: string;
  titleId: string;
  episodeId: string | null;
  kind: BackupWatchEvent["kind"];
  occurredAt: Date;
  source: BackupWatchEvent["source"];
  note: string | null;
  createdAt: Date;
};

/**
 * Build the identities apply will use closely enough to preview event creates.
 * Existing episodes keep their database ids; rows that will be materialized by
 * restore use collision-proof plan-local markers because no current event can
 * already reference them.
 */
function plannedEventIdentityMaps(
  plan: RestorePlan,
  existingTitles: BackupTitle[],
): {
  titleIds: Map<string, string>;
  episodeIds: Map<string, string>;
} {
  const existingById = new Map(existingTitles.map((title) => [title.sourceId, title]));
  const titleIds = new Map<string, string>();
  const episodeIds = new Map<string, string>();

  for (const item of plan.items) {
    if (item.action === "conflict") continue;
    const localTitleId =
      item.action === "create"
        ? `\0restore-title:${item.incoming.sourceId}`
        : item.existingId;
    titleIds.set(item.incoming.sourceId, localTitleId);

    const existing =
      item.action === "create" ? undefined : existingById.get(item.existingId);
    const existingSeasons = new Map(
      existing?.seasons.map((season) => [season.seasonNumber, season]) ?? [],
    );
    for (const incomingSeason of item.incoming.seasons) {
      const existingSeason = existingSeasons.get(incomingSeason.seasonNumber);
      const existingEpisodes = new Map(
        existingSeason?.episodes.map((episode) => [episode.episodeNumber, episode]) ?? [],
      );
      for (const incomingEpisode of incomingSeason.episodes) {
        episodeIds.set(
          incomingEpisode.sourceId,
          existingEpisodes.get(incomingEpisode.episodeNumber)?.sourceId ??
            `\0restore-episode:${incomingEpisode.sourceId}`,
        );
      }
    }
  }

  return { titleIds, episodeIds };
}

function countWatchEventsToCreate(
  userId: string,
  events: BackupWatchEvent[],
  plan: RestorePlan,
  existingTitles: BackupTitle[],
  currentEvents: StoredWatchEvent[],
): number {
  const identities = plannedEventIdentityMaps(plan, existingTitles);
  const currentById = new Map(currentEvents.map((event) => [event.id, event]));
  const seenKeys = new Set(currentEvents.map(watchEventDedupKey));
  let creates = 0;

  for (const event of events) {
    const titleId = identities.titleIds.get(event.titleId);
    const episodeId = event.episodeId
      ? identities.episodeIds.get(event.episodeId)
      : null;
    if (!titleId || (event.episodeId !== null && !episodeId)) continue;

    const occupied = currentById.get(event.sourceId);
    if (occupied?.userId === userId && occupied.titleId === titleId) continue;

    const candidate = {
      titleId,
      episodeId: episodeId ?? null,
      kind: event.kind,
      occurredAt: new Date(event.occurredAt),
      source: event.source,
      note: event.note,
    };
    const key = watchEventDedupKey(candidate);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    creates += 1;
  }

  return creates;
}

async function restoreWatchEvents(
  userId: string,
  events: BackupWatchEvent[],
  sourceToLocalTitleId: Map<string, string>,
  sourceToLocalEpisodeId: Map<string, string>,
  mode: RestoreMode,
): Promise<{ eventsCreated: number; eventsSkipped: number }> {
  let eventsCreated = 0;
  let eventsSkipped = 0;
  for (const batch of chunks(events, 50)) {
    const candidates: Array<{
      sourceId: string;
      data: {
        userId: string;
        titleId: string;
        episodeId: string | null;
        kind: BackupWatchEvent["kind"];
        occurredAt: Date;
        source: BackupWatchEvent["source"];
        note: string | null;
        createdAt: Date;
      };
    }> = [];
    for (const event of batch) {
      const titleId = sourceToLocalTitleId.get(event.titleId);
      const episodeId = event.episodeId
        ? sourceToLocalEpisodeId.get(event.episodeId)
        : null;
      if (!titleId || (event.episodeId !== null && !episodeId)) {
        eventsSkipped += 1;
        continue;
      }
      candidates.push({
        sourceId: event.sourceId,
        data: {
          userId,
          titleId,
          episodeId: episodeId ?? null,
          kind: event.kind,
          occurredAt: new Date(event.occurredAt),
          source: event.source,
          note: event.note,
          createdAt: new Date(event.createdAt),
        },
      });
    }
    if (candidates.length === 0) continue;

    const result = await prisma.$transaction(
      async (tx) => {
        // Two reads for the whole chunk: one for the semantic dedup tuple and
        // one for source-id occupancy. The previous path ran both plus a create
        // for every event, making the query count grow at 3N.
        const [existingRows, occupiedRows] = await Promise.all([
          tx.watchEvent.findMany({
            where: {
              userId,
              OR: candidates.map(({ data }) => ({
                titleId: data.titleId,
                episodeId: data.episodeId,
                kind: data.kind,
                occurredAt: data.occurredAt,
                source: data.source,
                note: data.note,
              })),
            },
            select: {
              titleId: true,
              episodeId: true,
              kind: true,
              occurredAt: true,
              source: true,
              note: true,
            },
          }),
          tx.watchEvent.findMany({
            where: { id: { in: candidates.map((candidate) => candidate.sourceId) } },
            select: { id: true, userId: true, titleId: true },
          }),
        ]);
        const seenKeys = new Set(existingRows.map(watchEventDedupKey));
        const occupiedById = new Map(occupiedRows.map((row) => [row.id, row]));
        const creates: Prisma.WatchEventCreateManyInput[] = [];
        let skipped = 0;
        for (const candidate of candidates) {
          const occupied = occupiedById.get(candidate.sourceId);
          if (
            occupied?.userId === userId &&
            occupied.titleId === candidate.data.titleId
          ) {
            if (mode === "replace-personal") {
              await tx.watchEvent.update({
                where: { id: occupied.id },
                data: {
                  episodeId: candidate.data.episodeId,
                  kind: candidate.data.kind,
                  occurredAt: candidate.data.occurredAt,
                  source: candidate.data.source,
                  note: candidate.data.note,
                  createdAt: candidate.data.createdAt,
                },
              });
              seenKeys.add(watchEventDedupKey(candidate.data));
            }
            skipped += 1;
            continue;
          }
          const key = watchEventDedupKey(candidate.data);
          // Also suppress duplicate tuples within this batch. The old sequential
          // loop observed its own earlier create on the next duplicate probe.
          if (seenKeys.has(key)) {
            skipped += 1;
            continue;
          }
          seenKeys.add(key);
          creates.push({
            ...candidate.data,
            id: occupied ? undefined : candidate.sourceId,
          });
        }
        const created = creates.length > 0
          ? (await tx.watchEvent.createMany({ data: creates })).count
          : 0;
        return { created, skipped };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    eventsCreated += result.created;
    eventsSkipped += result.skipped;
  }
  return { eventsCreated, eventsSkipped };
}

export async function restoreBackup(
  userId: string,
  backup: BackupEnvelope,
  mode: RestoreMode,
  plan: BackupRestorePlan,
): Promise<RestoreResult> {
  // Validate every title row before any preference, suppression, tag or title
  // write begins. The route already builds this plan during preview/apply; this
  // guard also protects direct callers and keeps partial restores avoidable.
  for (const item of plan.items) {
    if (item.action === "create") backupTitleSchema.parse(item.incoming);
    if (item.action === "update") backupTitleSchema.parse(item.merged);
  }
  await restoreUserPreferences(userId, backup, mode);
  const suppressionResult = await restoreSuppressions(
    userId,
    backup.suppressions ?? [],
    mode,
  );
  for (const tagBatch of chunks(backup.tags, 100)) {
    await restoreTags(userId, tagBatch, mode);
  }
  const tagRows = await prisma.tag.findMany({
    where: { userId },
    select: { id: true, name: true },
  });
  const tagIdsByName = new Map(
    tagRows.map((tag) => [tagNameKey(tag.name), tag.id]),
  );
  const sourceToLocalTitleId = new Map<string, string>();

  for (const item of plan.items) {
    if (item.action === "skip" || item.action === "update") {
      sourceToLocalTitleId.set(item.incoming.sourceId, item.existingId);
    }
  }

  const writableItems = plan.items.filter(
    (item) => item.action === "create" || item.action === "update",
  );
  for (const batch of chunks(writableItems, 10)) {
    const mapped = await prisma.$transaction(
      async (tx) => {
        const ids: Array<[string, string]> = [];
        for (const item of batch) {
          const localId =
            item.action === "create"
              ? await createTitle(tx, userId, item.incoming, tagIdsByName)
              : await updateTitle(
                  tx,
                  userId,
                  item.existingId,
                  item.incoming,
                  mode,
                  tagIdsByName,
                );
          ids.push([item.incoming.sourceId, localId]);
        }
        return ids;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    for (const [sourceId, localId] of mapped) {
      sourceToLocalTitleId.set(sourceId, localId);
    }
  }

  const sourceToLocalEpisodeId = await mapRestoredEpisodes(backup, sourceToLocalTitleId);
  const [shareResult, eventResult] = await Promise.all([
    restoreShares(userId, backup.shares, sourceToLocalTitleId, mode),
    restoreWatchEvents(
      userId,
      backup.watchEvents,
      sourceToLocalTitleId,
      sourceToLocalEpisodeId,
      mode,
    ),
  ]);
  return {
    ...plan.counts,
    ...suppressionResult,
    ...shareResult,
    ...eventResult,
  };
}

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
const RESTORE_COUNT_KEYS = [
  "create",
  "update",
  "skip",
  "conflict",
  "eventsCreate",
  "suppressionsCreate",
  "suppressionsUpdate",
  "suppressionsSkip",
  "providerSelections",
  "providerPreferenceIncluded",
  "providerPreferenceUpdate",
  "recommendModelPreferenceIncluded",
  "recommendModelPreferenceUpdate",
] as const satisfies readonly (keyof RestorePreviewCounts)[];

function restoreCountValues(counts: RestorePreviewCounts): number[] {
  return RESTORE_COUNT_KEYS.map((key) => counts[key]);
}

function backupDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function confirmationPayload(
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  issuedAt: number,
  counts: RestorePreviewCounts,
  stateDigest: string,
): string {
  return [
    userId,
    mode,
    backupDigest(bytes),
    stateDigest,
    issuedAt,
    ...restoreCountValues(counts),
  ].join(":");
}

export function createRestoreConfirmation(
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  counts: RestorePreviewCounts,
  stateDigest: string,
): string {
  const issuedAt = Date.now();
  const payload = confirmationPayload(
    userId,
    mode,
    bytes,
    issuedAt,
    counts,
    stateDigest,
  );
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
  return [issuedAt, ...restoreCountValues(counts), signature].join(".");
}

export function verifyRestoreConfirmation(
  token: string,
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  counts: RestorePreviewCounts,
  stateDigest: string,
): boolean {
  const parts = token.split(".");
  if (parts.length !== RESTORE_COUNT_KEYS.length + 2) return false;
  const [issuedRaw, ...countParts] = parts;
  const signature = countParts.pop();
  if (!signature) return false;
  const issuedAt = Number(issuedRaw);
  const tokenCountValues = countParts.map(Number);
  const tokenCounts = Object.fromEntries(
    RESTORE_COUNT_KEYS.map((key, index) => [key, tokenCountValues[index]]),
  ) as unknown as RestorePreviewCounts;
  if (
    !Number.isSafeInteger(issuedAt) ||
    Date.now() - issuedAt < 0 ||
    Date.now() - issuedAt > CONFIRMATION_TTL_MS ||
    tokenCountValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    RESTORE_COUNT_KEYS.some((key) => tokenCounts[key] !== counts[key])
  ) {
    return false;
  }

  const payload = confirmationPayload(
    userId,
    mode,
    bytes,
    issuedAt,
    tokenCounts,
    stateDigest,
  );
  const expected = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(payload)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
