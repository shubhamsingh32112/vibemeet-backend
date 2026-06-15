import type { IUser } from './user.model';
import { UserLoginEvent } from './user-login-event.model';

/** Record a consumer app login for admin analytics (role=user only). */
export async function recordConsumerUserLogin(user: Pick<IUser, '_id' | 'role'>): Promise<void> {
  if (user.role !== 'user') return;
  await UserLoginEvent.create({
    userId: user._id,
    role: user.role,
    loggedInAt: new Date(),
  });
}
