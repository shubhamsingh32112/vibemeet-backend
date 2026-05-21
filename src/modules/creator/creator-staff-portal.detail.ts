import mongoose from 'mongoose';
import { Creator, type ICreator } from './creator.model';
import { User, type IUser } from '../user/user.model';
import { buildCreatorMediaPayload, buildUserMediaPayload } from './creator-staff-portal.payload';

export type StaffCreatorDetailDoc = {
  creator: ReturnType<typeof buildCreatorMediaPayload> & {
    id: string;
    userId: string;
    name: string;
    about: string;
    categories: string[];
    price: number;
    age?: number;
    location?: string;
    earningsCoins: number;
    isOnline: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  user: ReturnType<typeof buildUserMediaPayload> & {
    id: string;
    username?: string;
    email?: string;
    phone?: string;
    coins?: number;
    profileRevision?: number;
  };
};

export async function loadStaffCreatorDetailById(
  creatorId: string
): Promise<{ doc: StaffCreatorDetailDoc; creator: mongoose.Document & ICreator } | null> {
  if (!mongoose.isValidObjectId(creatorId)) return null;

  const creatorDoc = await Creator.findById(creatorId);
  if (!creatorDoc) return null;

  const user = await User.findById(creatorDoc.userId).lean();
  if (!user) return null;

  const media = buildCreatorMediaPayload(creatorDoc);
  const userMedia = buildUserMediaPayload(user as unknown as IUser);

  return {
    creator: creatorDoc,
    doc: {
      creator: {
        id: creatorDoc._id.toString(),
        userId: creatorDoc.userId.toString(),
        name: creatorDoc.name,
        about: creatorDoc.about ?? '',
        categories: creatorDoc.categories ?? [],
        price: creatorDoc.price,
        age: creatorDoc.age,
        location: creatorDoc.location,
        earningsCoins: creatorDoc.earningsCoins ?? 0,
        isOnline: creatorDoc.isOnline ?? false,
        createdAt: creatorDoc.createdAt,
        updatedAt: creatorDoc.updatedAt,
        ...media,
      },
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        phone: user.phone,
        coins: user.coins,
        profileRevision: user.profileRevision,
        ...userMedia,
      },
    },
  };
}
