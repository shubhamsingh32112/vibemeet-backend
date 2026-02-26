import { User } from '../user/user.model';

export class AdminRepository {
  async findUserByFirebaseUid(firebaseUid: string) {
    return User.findOne({ firebaseUid }).lean();
  }
}

