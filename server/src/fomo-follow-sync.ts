import { config } from './config.js';
import {
  addFomoUserTag,
  clearFomoFollowMissing,
  clearFomoFollowMissingForOwner,
  deleteFomoUser,
  findFomoUserByHandleCI,
  findFomoUserByUserId,
  getDb,
  getFomoFollowSync,
  insertFomoUser,
  listFomoFollowMissing,
  listFomoUsers,
  markFomoFollowMissing,
  recordFomoFollowSyncAttempt,
  recordFomoFollowSyncFailure,
  recordFomoFollowSyncSuccess,
  removeFomoUserTag,
  updateFomoUser,
  type FomoUserInput,
  type FomoUserRow,
} from './db.js';
import {
  fetchFomoFollowingPage,
  fetchFomoUserProfile,
  type FomoFollowingResult,
  type FomoFollowingUser,
  type FomoProfileResult,
} from './fomo-api.js';
import { log } from './log.js';
import { enqueueFomoDiscovery } from './fomo-balance-discovery.js';

export const ALITA_FOLLOW_SOURCE = 'alita_follow';
const LEASE_MS = 60_000;

let running = false;

export interface FollowSyncResult {
  ok: boolean;
  skipped: boolean;
  complete: boolean;
  added: number;
  removed: number;
  tagged: number;
  untagged: number;
  deleted: number;
  total: number;
  aborted: string | null;
  error: string | null;
}

export interface FollowSyncDeps {
  fetchPage: (userId: string, lastId?: string) => Promise<FomoFollowingResult>;
  fetchProfile: (userId: string) => Promise<FomoProfileResult>;
}

export interface FollowSyncOptions {
  now?: number;
  deps?: Partial<FollowSyncDeps>;
}

class FollowSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowSyncError';
  }
}

export function fomoUserHasTag(rawTags: string, tag: string): boolean {
  try {
    const value: unknown = JSON.parse(rawTags);
    return Array.isArray(value) && value.includes(tag);
  } catch {
    return false;
  }
}

async function fetchAllFollowing(
  ownerUserId: string,
  fetchPage: FollowSyncDeps['fetchPage'],
  maxPages: number,
): Promise<FomoFollowingUser[]> {
  const users: FomoFollowingUser[] = [];
  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  const seenCursors = new Set<string>();
  let lastId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(ownerUserId, lastId);
    if (!res.ok) throw new FollowSyncError(`fetch_failed:${res.error ?? res.status ?? 'unknown'}`);
    if (res.users.length === 0) return users;
    for (const user of res.users) {
      const handleKey = user.handle.toLocaleLowerCase('en-US');
      if (seenIds.has(user.id) || seenHandles.has(handleKey)) throw new FollowSyncError('duplicate_identity');
      seenIds.add(user.id);
      seenHandles.add(handleKey);
      users.push(user);
    }
    const nextCursor = res.users[res.users.length - 1]?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) throw new FollowSyncError('cursor_loop');
    seenCursors.add(nextCursor);
    lastId = nextCursor;
  }
  throw new FollowSyncError('page_cap');
}

function assertOwnerProfile(result: FomoProfileResult, ownerId: string): number {
  if (!result.ok || result.profile === null) throw new FollowSyncError(`owner_profile:${result.error ?? 'unknown'}`);
  if (result.profile.id !== ownerId || result.profile.following === null || result.profile.private === true) {
    throw new FollowSyncError('owner_profile_incomplete');
  }
  return result.profile.following;
}

function ensureNoIdentityConflicts(live: FomoFollowingUser[]): void {
  const byId = new Map<string, FomoUserRow>();
  const byHandle = new Map<string, FomoUserRow>();
  for (const row of listFomoUsers()) {
    const handleKey = row.handle.toLocaleLowerCase('en-US');
    const sameId = row.user_id ? byId.get(row.user_id) : undefined;
    const sameHandle = byHandle.get(handleKey);
    if ((sameId && sameId.id !== row.id) || (sameHandle && sameHandle.id !== row.id)) {
      throw new FollowSyncError('stored_identity_conflict');
    }
    if (row.user_id) byId.set(row.user_id, row);
    byHandle.set(handleKey, row);
  }
  for (const user of live) {
    const idMatch = byId.get(user.id);
    const handleMatch = byHandle.get(user.handle.toLocaleLowerCase('en-US'));
    if (idMatch && handleMatch && idMatch.id !== handleMatch.id) throw new FollowSyncError('identity_conflict');
    if (handleMatch && handleMatch.user_id && handleMatch.user_id !== user.id) throw new FollowSyncError('identity_conflict');
  }
}

function applyLiveUser(user: FomoFollowingUser, tag: string, additions: FomoUserRow[]): 'added' | 'tagged' | 'unchanged' {
  let row = findFomoUserByUserId(user.id);
  if (row) {
    if (row.source === ALITA_FOLLOW_SOURCE && row.handle !== user.handle) {
      row = updateFomoUser(row.id, { handle: user.handle }) ?? row;
    }
    return addFomoUserTag(row.id, tag) ? 'tagged' : 'unchanged';
  }

  row = findFomoUserByHandleCI(user.handle);
  if (row) {
    const patch: Partial<FomoUserInput> = {};
    if (!row.user_id) patch.user_id = user.id;
    if (row.source === ALITA_FOLLOW_SOURCE && row.handle !== user.handle) patch.handle = user.handle;
    if (Object.keys(patch).length > 0) row = updateFomoUser(row.id, patch) ?? row;
    if (patch.user_id !== undefined) additions.push(row);
    return addFomoUserTag(row.id, tag) ? 'tagged' : 'unchanged';
  }

  additions.push(insertFomoUser({ handle: user.handle, user_id: user.id, name: user.displayName, source: ALITA_FOLLOW_SOURCE, tags: [tag] }));
  return 'added';
}

export async function runAlitaFollowSync(options: FollowSyncOptions = {}): Promise<FollowSyncResult> {
  const startedAt = options.now ?? Date.now();
  const empty: FollowSyncResult = {
    ok: true, skipped: false, complete: false, added: 0, removed: 0, tagged: 0, untagged: 0,
    deleted: 0, total: 0, aborted: null, error: null,
  };
  if (!config.showFomo || !config.fomoAlitaSync || config.fomoProdUrl === '') return { ...empty, skipped: true };
  if (running) return { ...empty, skipped: true, aborted: 'already_running' };

  const ownerId = config.fomoAlitaUserId;
  const ownerHandle = config.fomoAlitaHandle;
  const tag = config.fomoAlitaTag;
  const state = getFomoFollowSync(ownerId);
  if (state?.last_attempt_at != null && startedAt - state.last_attempt_at < LEASE_MS) {
    return { ...empty, skipped: true, aborted: 'lease' };
  }

  running = true;
  recordFomoFollowSyncAttempt(ownerId, ownerHandle, startedAt);
  try {
    const deps: FollowSyncDeps = { fetchPage: fetchFomoFollowingPage, fetchProfile: fetchFomoUserProfile, ...options.deps };
    const beforeCount = assertOwnerProfile(await deps.fetchProfile(ownerId), ownerId);
    const live = await fetchAllFollowing(ownerId, deps.fetchPage, config.fomoAlitaMaxPages);
    const afterCount = assertOwnerProfile(await deps.fetchProfile(ownerId), ownerId);
    const complete = beforeCount === afterCount && live.length === afterCount;

    ensureNoIdentityConflicts(live);
    const previous = listFomoUsers().filter((user) => user.source === ALITA_FOLLOW_SOURCE || fomoUserHasTag(user.tags, tag));
    const liveIds = new Set(live.map((user) => user.id));
    const missingCandidates = previous.filter((user) => user.user_id && !liveIds.has(user.user_id));
    const pending = listFomoFollowMissing(ownerId);
    let added = 0;
    let tagged = 0;
    let untagged = 0;
    let deleted = 0;
    let removed = 0;
    const additions: FomoUserRow[] = [];

    const tx = getDb().transaction(() => {
      if (!complete) clearFomoFollowMissingForOwner(ownerId);
      for (const user of live) {
        const result = applyLiveUser(user, tag, additions);
        if (result === 'added') added++;
        if (result === 'tagged') tagged++;
        if (complete) clearFomoFollowMissing(ownerId, user.id);
      }

      if (complete) {
        for (const user of missingCandidates) {
          const firstMissingAt = pending.get(user.user_id as string);
          if (firstMissingAt === undefined) {
            markFomoFollowMissing(ownerId, user.user_id as string, startedAt);
            continue;
          }
          if (startedAt - firstMissingAt < config.fomoAlitaPollMs) continue;
          if (removeFomoUserTag(user.id, tag)) untagged++;
          clearFomoFollowMissing(ownerId, user.user_id as string);
          if (user.source === ALITA_FOLLOW_SOURCE) {
            deleteFomoUser(user.id);
            deleted++;
          }
          removed++;
        }
      }
      recordFomoFollowSyncSuccess(ownerId, startedAt, live.length, complete);
    });
    tx();
    for (const user of additions) enqueueFomoDiscovery(user);

    const aborted = complete ? null : 'incomplete_snapshot';
    log.info(`[fomo-follow-sync] ok complete=${complete} added=${added} removed=${removed} tagged=${tagged} untagged=${untagged} deleted=${deleted} total=${live.length} durationMs=${Date.now() - startedAt}`);
    return { ...empty, ok: true, complete, added, removed, tagged, untagged, deleted, total: live.length, aborted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getDb().transaction(() => clearFomoFollowMissingForOwner(ownerId))();
    recordFomoFollowSyncFailure(ownerId, startedAt, message);
    log.warn('[fomo-follow-sync] failed', { error: message });
    return { ...empty, ok: false, aborted: message, error: message };
  } finally {
    running = false;
  }
}
