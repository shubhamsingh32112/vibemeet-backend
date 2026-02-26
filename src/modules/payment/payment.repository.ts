import { User } from '../user/user.model';

export class PaymentRepository {
  async findUserByFirebaseUid(firebaseUid: string) {
    return User.findOne({ firebaseUid }).lean();
  }
}

