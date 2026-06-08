import { startImagePipelineWorkers } from '../modules/images/images.bootstrap';
import { logError } from '../utils/logger';

export async function bootstrapImageWorkers(): Promise<void> {
  try {
    await startImagePipelineWorkers();
  } catch (err) {
    logError('Image pipeline workers failed to start', err);
  }
}
