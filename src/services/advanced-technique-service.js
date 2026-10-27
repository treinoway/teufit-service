import { AppError } from '../errors/app-error.js';
import { buildError } from '../helpers/training-validators.js';
import { selectionFromLinks } from '../helpers/advanced-technique-refs.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
  AdvancedTechniqueLimits,
} from '../constants/advanced-technique.js';

const SYSTEM_FIRST_THEN_NAME = [{ trainerId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }];

// Builds a domain AppError for the advanced technique feature.
function buildTechniqueError(httpStatus, error, messageCode, message) {
  return new AppError({ httpStatus, error, messageCode, message, details: {} });
}

// Resolves the trainer id for a user or throws the standard missing-profile error.
async function resolveTrainerId(db, userId) {
  const trainer = await db.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) throw buildError('TRAINER_PROFILE_MISSING', 'Trainer profile not found', 404);
  return trainer.id;
}

// Maps a technique row to the public item shape.
function toTechniqueItem(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    videoUrl: row.videoUrl,
    gifUrl: row.gifUrl,
    isSystem: row.trainerId === null,
    trainerId: row.trainerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Where clause for techniques visible to a trainer: system ones plus their own, never soft-deleted.
function buildVisibleWhere(trainerId) {
  return { deletedAt: null, OR: [{ trainerId: null }, { trainerId }] };
}

// Loads a technique visible to the trainer or throws 404 (missing, soft-deleted or another trainer's).
async function loadVisibleTechnique(db, trainerId, techniqueId) {
  const row = await db.advancedTechnique.findUnique({ where: { id: techniqueId } });
  const isVisible = row && !row.deletedAt && (row.trainerId === null || row.trainerId === trainerId);
  if (!isVisible) {
    throw buildTechniqueError(
      404,
      AdvancedTechniqueErrorCode.NOT_FOUND,
      AdvancedTechniqueMessageCode.NOT_FOUND,
      'Advanced technique not found',
    );
  }
  return row;
}

// Loads a technique the trainer owns or throws 404 / 403 (system techniques are read-only).
async function loadOwnedTechnique(db, trainerId, techniqueId) {
  const row = await loadVisibleTechnique(db, trainerId, techniqueId);
  if (row.trainerId === null) {
    throw buildTechniqueError(
      403,
      AdvancedTechniqueErrorCode.FORBIDDEN,
      AdvancedTechniqueMessageCode.FORBIDDEN,
      'System advanced techniques cannot be changed',
    );
  }
  return row;
}

// Normalizes page and limit query values to safe integers.
function resolvePaging(filters) {
  const page = Math.max(1, parseInt(filters.page ?? 1, 10));
  const limit = Math.min(
    AdvancedTechniqueLimits.MAX_PAGE_SIZE,
    Math.max(1, parseInt(filters.limit ?? AdvancedTechniqueLimits.DEFAULT_PAGE_SIZE, 10)),
  );
  return { page, limit };
}

/**
 * Lists system techniques plus the trainer's own, with search and pagination.
 * @param {object} db - Prisma client
 * @param {string} userId - Trainer user id
 * @param {object} filters - { q, page, limit }
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function listAdvancedTechniques(db, userId, filters = {}) {
  const trainerId = await resolveTrainerId(db, userId);
  const { page, limit } = resolvePaging(filters);
  const where = {
    ...buildVisibleWhere(trainerId),
    ...(filters.q && { name: { contains: filters.q, mode: 'insensitive' } }),
  };

  const [rows, total] = await Promise.all([
    db.advancedTechnique.findMany({ where, orderBy: SYSTEM_FIRST_THEN_NAME, skip: (page - 1) * limit, take: limit }),
    db.advancedTechnique.count({ where }),
  ]);

  return { data: rows.map(toTechniqueItem), total, page, limit };
}

/**
 * Returns one technique visible to the trainer.
 * @param {object} db - Prisma client
 * @param {string} userId - Trainer user id
 * @param {string} techniqueId - Technique id
 * @returns {Promise<object>}
 */
export async function getAdvancedTechniqueById(db, userId, techniqueId) {
  const trainerId = await resolveTrainerId(db, userId);
  return toTechniqueItem(await loadVisibleTechnique(db, trainerId, techniqueId));
}

/**
 * Creates a technique owned by the trainer.
 * @param {object} db - Prisma client
 * @param {string} userId - Trainer user id
 * @param {object} data - { name, description, videoUrl?, gifUrl? }
 * @returns {Promise<object>}
 */
export async function createAdvancedTechnique(db, userId, data) {
  const trainerId = await resolveTrainerId(db, userId);
  const created = await db.advancedTechnique.create({
    data: {
      trainerId,
      name: data.name.trim(),
      description: data.description.trim(),
      videoUrl: data.videoUrl || null,
      gifUrl: data.gifUrl || null,
    },
  });
  return toTechniqueItem(created);
}

// Builds a partial update payload from only the provided fields.
function buildUpdateData(data) {
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.description !== undefined) updateData.description = data.description.trim();
  if (data.videoUrl !== undefined) updateData.videoUrl = data.videoUrl;
  if (data.gifUrl !== undefined) updateData.gifUrl = data.gifUrl;
  return updateData;
}

/**
 * Updates an own technique (system techniques are forbidden).
 * @param {object} db - Prisma client
 * @param {string} userId - Trainer user id
 * @param {string} techniqueId - Technique id
 * @param {object} data - Fields to change
 * @returns {Promise<object>}
 */
export async function updateAdvancedTechnique(db, userId, techniqueId, data) {
  const trainerId = await resolveTrainerId(db, userId);
  await loadOwnedTechnique(db, trainerId, techniqueId);
  const updated = await db.advancedTechnique.update({
    where: { id: techniqueId },
    data: buildUpdateData(data),
  });
  return toTechniqueItem(updated);
}

/**
 * Soft-deletes an own technique (existing exercise links keep resolving).
 * @param {object} db - Prisma client
 * @param {string} userId - Trainer user id
 * @param {string} techniqueId - Technique id
 * @returns {Promise<object>}
 */
export async function deleteAdvancedTechnique(db, userId, techniqueId) {
  const trainerId = await resolveTrainerId(db, userId);
  await loadOwnedTechnique(db, trainerId, techniqueId);
  const deleted = await db.advancedTechnique.update({
    where: { id: techniqueId },
    data: { deletedAt: new Date() },
  });
  return toTechniqueItem(deleted);
}

// Loads the set of technique ids (among the given ones) that are visible to the trainer.
async function loadVisibleIdSet(db, trainerId, ids) {
  if (ids.length === 0) return new Set();
  const visible = await db.advancedTechnique.findMany({
    where: { id: { in: ids }, ...buildVisibleWhere(trainerId) },
    select: { id: true },
  });
  return new Set(visible.map((row) => row.id));
}

// Builds the 400 error thrown when a selection references an unusable technique.
function invalidSelectionError() {
  return buildTechniqueError(
    400,
    AdvancedTechniqueErrorCode.INVALID_SELECTION,
    AdvancedTechniqueMessageCode.INVALID_SELECTION,
    'One or more selected advanced techniques are invalid',
  );
}

// Maps ordered ids to link rows using the array index as execution order.
function toOrderedSelection(ids) {
  return ids.map((advancedTechniqueId, order) => ({ advancedTechniqueId, order }));
}

/**
 * Validates several id lists with a single query; each list becomes an ordered selection.
 * @param {object} db - Prisma client or transaction client
 * @param {string} trainerId - Trainer id
 * @param {(string[]|undefined)[]} idLists - Technique ids per exercise, in execution order
 * @returns {Promise<{ advancedTechniqueId: string, order: number }[][]>}
 */
export async function resolveAdvancedTechniqueSelectionBatch(db, trainerId, idLists) {
  const requestedIds = [...new Set(idLists.flatMap((ids) => ids ?? []))];
  const visibleIds = await loadVisibleIdSet(db, trainerId, requestedIds);
  if (requestedIds.some((id) => !visibleIds.has(id))) throw invalidSelectionError();
  return idLists.map((ids) => toOrderedSelection(ids ?? []));
}

/**
 * Validates visibility of the selected technique ids and maps them to ordered link rows.
 * @param {object} db - Prisma client or transaction client
 * @param {string} trainerId - Trainer id
 * @param {string[]|undefined} ids - Technique ids in the desired execution order
 * @returns {Promise<{ advancedTechniqueId: string, order: number }[]>}
 */
export async function resolveAdvancedTechniqueSelection(db, trainerId, ids) {
  const [selection] = await resolveAdvancedTechniqueSelectionBatch(db, trainerId, [ids]);
  return selection;
}

/**
 * Copies several link lists, keeping only techniques still visible to the trainer, re-indexed.
 * @param {object} db - Prisma client or transaction client
 * @param {string} trainerId - Trainer id
 * @param {object[][]} linkLists - Link rows of each source (template / junction)
 * @returns {Promise<{ advancedTechniqueId: string, order: number }[][]>}
 */
export async function inheritSelectionBatch(db, trainerId, linkLists) {
  const inherited = linkLists.map(selectionFromLinks);
  const allIds = [...new Set(inherited.flatMap((items) => items.map((item) => item.advancedTechniqueId)))];
  const visibleIds = await loadVisibleIdSet(db, trainerId, allIds);
  return inherited.map((items) =>
    items
      .filter((item) => visibleIds.has(item.advancedTechniqueId))
      .map((item, order) => ({ ...item, order })),
  );
}

/**
 * Resolves a copy's selection: explicit ids win (even empty), otherwise inherit the visible source links.
 * @param {object} db - Prisma client or transaction client
 * @param {string} trainerId - Trainer id
 * @param {string[]|undefined} requestedIds - Ids sent by the client, undefined when the key was omitted
 * @param {object[]} sourceLinks - Link rows of the source (template/junction) to inherit from
 * @returns {Promise<{ advancedTechniqueId: string, order: number }[]>}
 */
export async function resolveSelectionOrInherit(db, trainerId, requestedIds, sourceLinks) {
  if (requestedIds !== undefined) return resolveAdvancedTechniqueSelection(db, trainerId, requestedIds);
  const [selection] = await inheritSelectionBatch(db, trainerId, [sourceLinks]);
  return selection;
}
