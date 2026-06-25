import mongoose, { Document, Schema } from 'mongoose';

/** Singleton document for optimistic-lock version on preview list reorder. */
export interface IFreePreviewListMeta extends Document {
  _id: mongoose.Types.ObjectId;
  listVersion: number;
  updatedAt: Date;
}

const freePreviewListMetaSchema = new Schema<IFreePreviewListMeta>(
  {
    listVersion: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const FreePreviewListMeta = mongoose.model<IFreePreviewListMeta>(
  'FreePreviewListMeta',
  freePreviewListMetaSchema,
);

const META_ID = new mongoose.Types.ObjectId('000000000001000000000001');

export async function getOrCreateListMeta(): Promise<IFreePreviewListMeta> {
  let meta = await FreePreviewListMeta.findById(META_ID);
  if (!meta) {
    meta = await FreePreviewListMeta.create({ _id: META_ID, listVersion: 0 });
  }
  return meta;
}
