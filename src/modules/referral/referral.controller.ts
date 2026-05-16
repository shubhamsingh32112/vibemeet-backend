import type { Request, Response } from 'express';
import { previewReferralCode, type ApplyReferralCodeErrorCode } from '../user/referral.service';
import { getFirebaseAdmin } from '../../config/firebase';
import { User } from '../user/user.model';
import { referralUserFacingMessage } from '../../utils/referral-messages';
import { logError } from '../../utils/logger';

function previewHttpStatus(code: ApplyReferralCodeErrorCode): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

/**
 * GET /referral/preview?code= — public, rate-limited; validates code before login.
 */
async function loadApplicantFromBearer(req: Request) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const decoded = await getFirebaseAdmin().auth().verifyIdToken(token);
    return await User.findOne({ firebaseUid: decoded.uid });
  } catch {
    return null;
  }
}

export const getReferralPreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    const modeParam = req.query.mode;
    const mode =
      modeParam === 'late_attach'
        ? 'late_attach'
        : modeParam === 'agency_host'
          ? 'agency_host'
          : 'signup';
    let applicant = null;

    if (mode === 'late_attach' || mode === 'agency_host') {
      applicant = await loadApplicantFromBearer(req);
      if (mode === 'agency_host' && !applicant) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
    }

    const result = await previewReferralCode(raw, { mode, applicant });
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
      data: {
        code: result.code,
        ...(result.agencyDisplayName ? { agencyDisplayName: result.agencyDisplayName } : {}),
      },
    });
  } catch (error) {
    logError('getReferralPreview failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
