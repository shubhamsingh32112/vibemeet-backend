import type { Request, Response } from 'express';
import { assertAdmin } from '../../middlewares/staff.middleware';
import { replayDomainEvent } from './domain-event.service';

export const postReplayDomainEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const { eventId } = req.params;
    if (!eventId?.trim()) {
      res.status(400).json({ success: false, error: 'eventId required' });
      return;
    }
    const ok = await replayDomainEvent(eventId.trim());
    if (!ok) {
      res.status(404).json({ success: false, error: 'Domain event not found' });
      return;
    }
    res.json({ success: true, data: { eventId: eventId.trim(), status: 'pending' } });
  } catch (error) {
    console.error('postReplayDomainEvent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
