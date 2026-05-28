import { buildGalleryUrls } from '../images/image-url';
import type { ISupportTicketAttachment } from './support.model';

export type SupportAttachmentApi = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  isScreenshot: boolean;
  imageId?: string;
  url?: string;
  dataBase64?: string;
  dataUrl?: string;
};

export function mapSupportAttachmentForApi(
  attachment: ISupportTicketAttachment,
  options?: { includeBase64?: boolean },
): SupportAttachmentApi {
  const includeBase64 = options?.includeBase64 ?? false;
  const base: SupportAttachmentApi = {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    isScreenshot: Boolean(attachment.isScreenshot),
  };

  if (attachment.imageId) {
    base.imageId = attachment.imageId;
    base.url =
      attachment.url ||
      buildGalleryUrls(attachment.imageId).md;
  }

  if (attachment.dataBase64 && attachment.dataBase64.length > 0) {
    if (includeBase64) {
      base.dataBase64 = attachment.dataBase64;
    }
    base.dataUrl = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  }

  return base;
}

export function mapSupportAttachmentsForApi(
  attachments: ISupportTicketAttachment[] | undefined,
  options?: { includeBase64?: boolean },
): SupportAttachmentApi[] {
  return (attachments || []).map((a) => mapSupportAttachmentForApi(a, options));
}
