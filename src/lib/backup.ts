import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  BACKUP_APP,
  BACKUP_SCHEMA_VERSION,
  backupEnvelopeSchema,
  mergeBackupTitle,
  planRestoreTitles,
  type BackupEnvelope,
  type BackupEpisode,
  type BackupSeason,
  type BackupShare,
  type BackupTag,
  type BackupTitle,
  type BackupWatchEvent,
  type RestoreCounts,
  type RestoreMode,
  type RestorePlan,
} from "@/lib/backup-format";

const titleBackupInclude = {
  seasons: { include: { episodes: true } },
  tags: { include: { tag: true } },
} as const;

type TitleWithRelations = Prisma.TitleGetPayload<{
  include: typeof titleBackupInclude;
}>;

export interface RestoreResult extends RestoreCounts {
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

function snapshotTitle(title: TitleWithRelations): BackupTitle {
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
        overview: season.overview,
        airDate: nullableIso(season.airDate),
        posterPath: season.posterPath,
        episodeCount: season.episodeCount,
        episodes: season.episodes
          .map((episode) => ({
            sourceId: episode.id,
            tmdbId: episode.tmdbId,
            episodeNumber: episode.episodeNumber,
            name: episode.name,
            overview: episode.overview,
            airDate: nullableIso(episode.airDate),
            runtime: episode.runtime,
            stillPath: episode.stillPath,
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
  const [user, titleRows, tagRows, shareRows, watchEventRows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true, watchRegion: true },
    }),
    prisma.title.findMany({
      where: { userId },
      include: titleBackupInclude,
      orderBy: { createdAt: "asc" },
    }),
    prisma.tag.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    prisma.shareList.findMany({
      where: { userId },
      include: { items: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.watchEvent.findMany({
      where: { userId },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  if (!user) throw new Error("Cannot back up a missing user.");

  const backup: BackupEnvelope = {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    user,
    titles: titleRows.map(snapshotTitle),
    tags: tagRows.map((tag) => ({
      sourceId: tag.id,
      name: tag.name,
      color: tag.color,
      createdAt: iso(tag.createdAt),
    })),
    shares: shareRows.map((share) => {
      const titleIds =
        share.scope === "WHOLE_LIBRARY"
          ? []
          : share.items.length > 0
            ? share.items.map((item) => item.titleId)
            : share.titleIds;
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
  };

  return backupEnvelopeSchema.parse(backup);
}

async function currentTitleSnapshots(userId: string): Promise<BackupTitle[]> {
  const rows = await prisma.title.findMany({
    where: { userId },
    include: titleBackupInclude,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(snapshotTitle);
}

export async function analyzeBackupRestore(
  userId: string,
  backup: BackupEnvelope,
  mode: RestoreMode,
): Promise<RestorePlan> {
  return planRestoreTitles(backup.titles, await currentTitleSnapshots(userId), mode);
}

function nullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
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
        watchedEpisodes,
        // Only adopt the row count when rows exist, so a movie-shaped or
        // episodeless title keeps whatever total the merge decided on.
        ...(totalEpisodes > 0 ? { totalEpisodes } : {}),
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
    existing.overview === next.overview &&
    sameDate(existing.airDate, next.airDate) &&
    existing.runtime === next.runtime &&
    existing.stillPath === next.stillPath &&
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
              userId,
              slug: await uniqueShareSlug(tx),
              name: share.name,
              titleIds,
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
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeZone: true, watchRegion: true },
  });
  if (!current) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      timeZone:
        mode === "replace-personal" || current.timeZone === "UTC"
          ? backup.user.timeZone
          : current.timeZone,
      watchRegion:
        mode === "replace-personal" || current.watchRegion === "US"
          ? backup.user.watchRegion
          : current.watchRegion,
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

async function restoreWatchEvents(
  userId: string,
  events: BackupWatchEvent[],
  sourceToLocalTitleId: Map<string, string>,
  sourceToLocalEpisodeId: Map<string, string>,
): Promise<{ eventsCreated: number; eventsSkipped: number }> {
  let eventsCreated = 0;
  let eventsSkipped = 0;
  for (const batch of chunks(events, 50)) {
    const result = await prisma.$transaction(
      async (tx) => {
        let created = 0;
        let skipped = 0;
        for (const event of batch) {
          const titleId = sourceToLocalTitleId.get(event.titleId);
          const episodeId = event.episodeId
            ? sourceToLocalEpisodeId.get(event.episodeId)
            : null;
          if (!titleId || (event.episodeId !== null && !episodeId)) {
            skipped += 1;
            continue;
          }
          const occurredAt = new Date(event.occurredAt);
          const duplicate = await tx.watchEvent.findFirst({
            where: {
              userId,
              titleId,
              episodeId,
              kind: event.kind,
              occurredAt,
              source: event.source,
              note: event.note,
            },
            select: { id: true },
          });
          if (duplicate) {
            skipped += 1;
            continue;
          }
          const occupiedId = await tx.watchEvent.findUnique({
            where: { id: event.sourceId },
            select: { id: true },
          });
          await tx.watchEvent.create({
            data: {
              id: occupiedId ? undefined : event.sourceId,
              userId,
              titleId,
              episodeId,
              kind: event.kind,
              occurredAt,
              source: event.source,
              note: event.note,
              createdAt: new Date(event.createdAt),
            },
          });
          created += 1;
        }
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
  plan: RestorePlan,
): Promise<RestoreResult> {
  await restoreUserPreferences(userId, backup, mode);
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
    restoreShares(userId, backup.shares, sourceToLocalTitleId),
    restoreWatchEvents(
      userId,
      backup.watchEvents,
      sourceToLocalTitleId,
      sourceToLocalEpisodeId,
    ),
  ]);
  return { ...plan.counts, ...shareResult, ...eventResult };
}

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

function backupDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function confirmationPayload(
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  issuedAt: number,
  counts: RestoreCounts,
): string {
  return [
    userId,
    mode,
    backupDigest(bytes),
    issuedAt,
    counts.create,
    counts.update,
    counts.skip,
    counts.conflict,
  ].join(":");
}

export function createRestoreConfirmation(
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  counts: RestoreCounts,
): string {
  const issuedAt = Date.now();
  const payload = confirmationPayload(userId, mode, bytes, issuedAt, counts);
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
  return [
    issuedAt,
    counts.create,
    counts.update,
    counts.skip,
    counts.conflict,
    signature,
  ].join(".");
}

export function verifyRestoreConfirmation(
  token: string,
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  counts: RestoreCounts,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 6) return false;
  const [issuedRaw, createRaw, updateRaw, skipRaw, conflictRaw, signature] = parts;
  const issuedAt = Number(issuedRaw);
  const tokenCounts = {
    create: Number(createRaw),
    update: Number(updateRaw),
    skip: Number(skipRaw),
    conflict: Number(conflictRaw),
  };
  if (
    !Number.isSafeInteger(issuedAt) ||
    Date.now() - issuedAt < 0 ||
    Date.now() - issuedAt > CONFIRMATION_TTL_MS ||
    Object.values(tokenCounts).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    tokenCounts.create !== counts.create ||
    tokenCounts.update !== counts.update ||
    tokenCounts.skip !== counts.skip ||
    tokenCounts.conflict !== counts.conflict
  ) {
    return false;
  }

  const payload = confirmationPayload(userId, mode, bytes, issuedAt, tokenCounts);
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
