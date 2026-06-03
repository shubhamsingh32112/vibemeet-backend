export type ProcessingStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export type ContentModerationStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'flagged'
  | 'under_review'
  | 'age_restricted';

export type VisibilityState = 'public' | 'followers_only' | 'shadow_hidden';

export type ContentClass = 'story' | 'moment';

export type DeletedAccessPolicy = 'retain_existing' | 'fully_remove';

export const PROCESSING_STATUSES: readonly ProcessingStatus[] = [
  'uploading',
  'processing',
  'ready',
  'failed',
] as const;

export const CONTENT_MODERATION_STATUSES: readonly ContentModerationStatus[] = [
  'pending',
  'approved',
  'rejected',
  'flagged',
  'under_review',
  'age_restricted',
] as const;

/** Non-public moderation states (hidden from feeds until resolved). */
export const ESCALATED_MODERATION_STATUSES: readonly ContentModerationStatus[] = [
  'flagged',
  'under_review',
  'age_restricted',
] as const;

export const VISIBILITY_STATES: readonly VisibilityState[] = [
  'public',
  'followers_only',
  'shadow_hidden',
] as const;
