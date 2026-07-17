import type { PipelineStage } from 'mongoose';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import {
  ADMIN_USER_SEARCH_QUERY_MAX_LEN,
  buildSafeMongoSubstringRegex,
} from '../../utils/mongo-regex';
import { logError } from '../../utils/logger';
import { User } from '../user/user.model';
import { UserLoginEvent } from '../user/user-login-event.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from '../billing/call-history.model';
import { ChatMessageQuota } from '../chat/chat-message-quota.model';
import { ReferralEdge } from '../user/referral-edge.model';
import { parseAdminDateRange, type ParsedDateRange } from './admin-date-range';

const WEBSITE_ATTRIBUTION_TRACKING_START =
  process.env.WEBSITE_ATTRIBUTION_TRACKING_START || '2026-07-17T00:00:00.000Z';

type WebsiteAudience = 'created_on_website' | 'preexisting_then_website' | 'all';
type LoginCohort = 'first_time' | 'relogin' | 'all';
type ActivityKind = 'interactive_login' | 'session_restore' | 'all';

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function pageParams(req: Request): { page: number; limit: number } {
  return {
    page: Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50)),
  };
}

function rejectInvalidRange(range: ParsedDateRange, res: Response): boolean {
  if (!range.invalidReason) return false;
  res.status(400).json({
    success: false,
    error: `Invalid date range: ${range.invalidReason}`,
  });
  return true;
}

function boundedSearch(req: Request, res: Response): string | undefined | null {
  const search = firstString(req.query.query)?.trim();
  if (search && search.length > ADMIN_USER_SEARCH_QUERY_MAX_LEN) {
    res.status(400).json({
      success: false,
      error: `Search query must be at most ${ADMIN_USER_SEARCH_QUERY_MAX_LEN} characters`,
    });
    return null;
  }
  return search || undefined;
}

function parseReferrer(req: Request, res: Response): mongoose.Types.ObjectId | undefined | null {
  const value = firstString(req.query.referrerAgencyId)?.trim();
  if (!value) return undefined;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    res.status(400).json({ success: false, error: 'Invalid referrerAgencyId' });
    return null;
  }
  return new mongoose.Types.ObjectId(value);
}

export const getWebsiteUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const range = parseAdminDateRange(req);
    if (rejectInvalidRange(range, res)) return;
    const search = boundedSearch(req, res);
    if (search === null) return;
    const { page, limit } = pageParams(req);
    const rawAudience = firstString(req.query.audience);
    const audience: WebsiteAudience =
      rawAudience === 'preexisting_then_website' || rawAudience === 'all'
        ? rawAudience
        : 'created_on_website';
    const sort =
      firstString(req.query.sort) === 'last_website_login' ? 'last_website_login' : 'website_since';
    const direction = firstString(req.query.direction) === 'asc' ? 1 : -1;

    const filter: Record<string, unknown> = {
      role: 'user',
      websiteAudienceCategory: audience === 'all'
        ? { $in: ['created_on_website', 'preexisting_then_website'] }
        : audience,
    };
    if (range.hasRange) {
      filter.websiteAudienceSince = { $gte: range.from, $lt: range.to };
    }
    if (search) {
      const regex = buildSafeMongoSubstringRegex(search);
      filter.$or = [{ username: regex }, { email: regex }, { phone: regex }];
    }
    const sortField = sort === 'last_website_login' ? 'lastWebsiteLoginAt' : 'websiteAudienceSince';
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(
          'email phone username avatar coins createdAt websiteAudienceCategory websiteAudienceSince firstWebsiteLoginAt lastWebsiteLoginAt',
        )
        .sort({ [sortField]: direction, _id: direction })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        users: users.map((user) => ({
          id: user._id.toString(),
          email: user.email ?? null,
          phone: user.phone ?? null,
          username: user.username ?? null,
          avatar: user.avatar ?? null,
          coins: Number(user.coins) || 0,
          accountCreatedAt: user.createdAt,
          websiteAudienceCategory: user.websiteAudienceCategory,
          websiteAudienceSince: user.websiteAudienceSince,
          firstWebsiteLoginAt: user.firstWebsiteLoginAt ?? null,
          lastWebsiteLoginAt: user.lastWebsiteLoginAt ?? null,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        meta: {
          audience,
          sort,
          direction: direction === 1 ? 'asc' : 'desc',
          range: range.hasRange ? { from: range.from, to: range.to } : null,
          timezone: 'Asia/Kolkata',
          trackingStart: WEBSITE_ATTRIBUTION_TRACKING_START,
          coverage: 'forward_only',
          paginationConsistency:
            'Offset pages may drift while last-login timestamps change; each page is globally sorted with _id as a tie-breaker.',
        },
      },
    });
  } catch (error) {
    logError('getWebsiteUsers', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getUsersLoginAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const range = parseAdminDateRange(req);
    if (rejectInvalidRange(range, res)) return;
    const search = boundedSearch(req, res);
    if (search === null) return;
    const referrerId = parseReferrer(req, res);
    if (referrerId === null) return;
    const { page, limit } = pageParams(req);
    const rawCohort = firstString(req.query.cohort);
    const cohort: LoginCohort =
      rawCohort === 'relogin' || rawCohort === 'all' ? rawCohort : 'first_time';
    const rawActivity = firstString(req.query.activityKind);
    const activityKind: ActivityKind =
      rawActivity === 'interactive_login' || rawActivity === 'session_restore'
        ? rawActivity
        : 'all';
    const rawSort = firstString(req.query.sort);
    const sort = rawSort === 'spent' || rawSort === 'calls' || rawSort === 'coins'
      ? rawSort
      : 'recent';

    const baseMatch: Record<string, unknown> = { role: 'user' };
    if (referrerId) baseMatch.referredBy = referrerId;
    if (search) {
      const regex = buildSafeMongoSubstringRegex(search);
      baseMatch.$or = [{ username: regex }, { email: regex }, { phone: regex }];
    }

    const eventMatch: Record<string, unknown> = {
      $expr: { $eq: ['$userId', '$$userId'] },
    };
    if (range.hasRange) eventMatch.loggedInAt = { $gte: range.from, $lt: range.to };
    if (activityKind !== 'all') eventMatch.eventKind = activityKind;
    if (!range.hasRange && cohort === 'relogin') eventMatch.accountCreated = false;

    const cohortExpr: Record<string, unknown> | undefined = range.hasRange
      ? cohort === 'first_time'
        ? { createdAt: { $gte: range.from, $lt: range.to } }
        : cohort === 'relogin'
          ? { createdAt: { $lt: range.from }, 'authActivity.0': { $exists: true } }
          : {
              $or: [
                { createdAt: { $gte: range.from, $lt: range.to } },
                { createdAt: { $lt: range.from }, 'authActivity.0': { $exists: true } },
              ],
            }
      : cohort === 'relogin'
        ? { 'authActivity.0': { $exists: true } }
        : undefined;

    const pipeline: PipelineStage[] = [
      { $match: baseMatch },
      {
        $lookup: {
          from: UserLoginEvent.collection.name,
          let: { userId: '$_id' },
          pipeline: [
            { $match: eventMatch },
            {
              $project: {
                loggedInAt: 1,
                eventKind: 1,
                accountCreated: 1,
              },
            },
          ],
          as: 'authActivity',
        },
      },
      ...(cohortExpr ? [{ $match: cohortExpr } as PipelineStage.Match] : []),
      {
        $lookup: {
          from: CoinTransaction.collection.name,
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$userId'] },
                    { $eq: ['$status', 'completed'] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                totalSpent: { $sum: { $cond: [{ $eq: ['$type', 'debit'] }, '$coins', 0] } },
                totalCredited: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$coins', 0] } },
                transactionCount: { $sum: { $cond: [{ $eq: ['$type', 'debit'] }, 1, 0] } },
              },
            },
          ],
          as: 'walletStats',
        },
      },
      {
        $lookup: {
          from: CallHistory.collection.name,
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$ownerUserId', '$$userId'] },
                    { $eq: ['$ownerRole', 'user'] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                callCount: { $sum: 1 },
                totalSeconds: { $sum: '$durationSeconds' },
              },
            },
          ],
          as: 'callStats',
        },
      },
      {
        $lookup: {
          from: ChatMessageQuota.collection.name,
          localField: 'firebaseUid',
          foreignField: 'userFirebaseUid',
          as: 'chatStats',
        },
      },
      {
        $lookup: {
          from: ReferralEdge.collection.name,
          localField: '_id',
          foreignField: 'referredUserId',
          as: 'referralEdge',
        },
      },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'referredBy',
          foreignField: '_id',
          as: 'referrer',
        },
      },
      {
        $set: {
          loginCount: { $size: '$authActivity' },
          latestLoginAt: { $max: '$authActivity.loggedInAt' },
          interactiveLoginCount: {
            $size: {
              $filter: {
                input: '$authActivity',
                as: 'event',
                cond: { $eq: ['$$event.eventKind', 'interactive_login'] },
              },
            },
          },
          sessionRestoreCount: {
            $size: {
              $filter: {
                input: '$authActivity',
                as: 'event',
                cond: { $eq: ['$$event.eventKind', 'session_restore'] },
              },
            },
          },
          unknownEventCount: {
            $size: {
              $filter: {
                input: '$authActivity',
                as: 'event',
                cond: { $eq: [{ $type: '$$event.accountCreated' }, 'missing'] },
              },
            },
          },
          wallet: { $ifNull: [{ $first: '$walletStats' }, {}] },
          calls: { $ifNull: [{ $first: '$callStats' }, {}] },
          referrerInfo: { $first: '$referrer' },
          edgeInfo: { $first: '$referralEdge' },
        },
      },
      {
        $set: {
          totalSpent: { $ifNull: ['$wallet.totalSpent', 0] },
          totalCredited: { $ifNull: ['$wallet.totalCredited', 0] },
          transactionCount: { $ifNull: ['$wallet.transactionCount', 0] },
          callCount: { $ifNull: ['$calls.callCount', 0] },
          totalCallMinutes: {
            $round: [{ $divide: [{ $ifNull: ['$calls.totalSeconds', 0] }, 60] }, 2],
          },
          chatChannels: { $size: '$chatStats' },
          freeMessages: { $sum: '$chatStats.freeMessagesSent' },
          paidMessages: { $sum: '$chatStats.paidMessagesSent' },
          cohortSortAt: {
            $ifNull: ['$latestLoginAt', '$createdAt'],
          },
        },
      },
      {
        $sort: {
          ...(sort === 'spent'
            ? { totalSpent: -1 }
            : sort === 'calls'
              ? { callCount: -1 }
              : sort === 'coins'
                ? { coins: -1 }
                : { cohortSortAt: -1 }),
          _id: -1,
        },
      },
      {
        $facet: {
          rows: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                id: { $toString: '$_id' },
                firebaseUid: 1,
                email: { $ifNull: ['$email', null] },
                phone: { $ifNull: ['$phone', null] },
                username: { $ifNull: ['$username', null] },
                avatar: { $ifNull: ['$avatar', null] },
                gender: { $ifNull: ['$gender', null] },
                role: 1,
                coins: 1,
                categories: 1,
                createdAt: 1,
                totalSpent: 1,
                totalCredited: 1,
                transactionCount: 1,
                callCount: 1,
                totalCallMinutes: 1,
                chatChannels: 1,
                freeMessages: 1,
                paidMessages: 1,
                loginCount: 1,
                latestLoginAt: 1,
                interactiveLoginCount: 1,
                sessionRestoreCount: 1,
                referralCodeUsed: '$edgeInfo.referralCodeUsed',
                referredByUserId: {
                  $cond: ['$referredBy', { $toString: '$referredBy' }, null],
                },
                referrerLabel: {
                  $ifNull: [
                    '$referrerInfo.displayName',
                    { $ifNull: ['$referrerInfo.email', '$referrerInfo.username'] },
                  ],
                },
                referrerIsAgency: { $eq: ['$referrerInfo.role', 'agency'] },
                isCreator: { $eq: ['$role', 'creator'] },
              },
            },
          ],
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                classifiedEventCount: {
                  $sum: { $subtract: ['$loginCount', '$unknownEventCount'] },
                },
                unknownEventCount: { $sum: '$unknownEventCount' },
              },
            },
          ],
        },
      },
    ];

    const [result] = await User.aggregate<{
      rows: unknown[];
      summary: Array<{
        total: number;
        classifiedEventCount: number;
        unknownEventCount: number;
      }>;
    }>(pipeline).allowDiskUse(true);
    const summary = result?.summary[0] ?? {
      total: 0,
      classifiedEventCount: 0,
      unknownEventCount: 0,
    };

    res.json({
      success: true,
      data: {
        users: result?.rows ?? [],
        total: summary.total,
        page,
        limit,
        totalPages: Math.ceil(summary.total / limit),
        meta: {
          effectiveFilters: { cohort, activityKind, sort },
          range: range.hasRange ? { from: range.from, to: range.to } : null,
          timezone: 'Asia/Kolkata',
          trackingStart: WEBSITE_ATTRIBUTION_TRACKING_START,
          coverage: 'forward_only_for_event_classification',
          classifiedEventCount: summary.classifiedEventCount,
          unknownEventCount: summary.unknownEventCount,
          authSyncCaveat:
            'Login events are backend auth synchronizations. Only eventKind=interactive_login is an explicit interactive-login claim.',
          paginationConsistency:
            'Offset pages may drift while activity changes; each page is globally sorted with _id as a tie-breaker.',
        },
      },
    });
  } catch (error) {
    logError('getUsersLoginAnalytics', error as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
