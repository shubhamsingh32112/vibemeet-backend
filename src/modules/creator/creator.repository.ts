import { User } from '../user/user.model';

export class CreatorRepository {
  async findUserByFirebaseUid(firebaseUid: string) {
    return User.findOne({ firebaseUid }).lean();
  }
}

