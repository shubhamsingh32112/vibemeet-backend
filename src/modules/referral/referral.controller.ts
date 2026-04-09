import type { Request, Response } from 'express';
import { previewReferralCode, type ApplyReferralCodeErrorCode } from '../user/referral.service';
import { referralUserFacingMessage } from '../../utils/referral-messages';
import { logError } from '../../utils/logger';

function previewHttpStatus(code: ApplyReferralCodeErrorCode): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

/**
 * GET /referral/preview?code= — public, rate-limited; validates code before login.
 */
export const getReferralPreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    const result = await previewReferralCode(raw);
    if (!result.ok) {
      res.status(previewHttpStatus(result.code)).json({
        success: false,
        error: referralUserFacingMessage(result.code),
        errorCode: result.code,
      });
      return;
    }
    res.json({
      success: true,
      data: { code: result.code },
    });
  } catch (error) {
    logError('getReferralPreview failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
