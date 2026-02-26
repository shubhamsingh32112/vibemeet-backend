import { Call } from './call.model';

export class VideoRepository {
  async findCallByCallId(callId: string) {
    return Call.findOne({ callId }).lean();
  }
}

