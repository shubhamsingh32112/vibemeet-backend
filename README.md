# Eazy Talks Backend

Node.js/TypeScript backend API for Eazy Talks mobile app.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with:
```
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_PRIVATE_KEY=your_firebase_private_key
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
PORT=3000
CORS_ORIGIN=*
```

3. Run in development:
```bash
npm run dev
```

4. Build for production:
```bash
npm run build
npm start
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Login with Firebase token
- `POST /api/v1/auth/logout` - Logout

### User
- `GET /api/v1/user/me` - Get current user profile

All authenticated endpoints require `Authorization: Bearer <firebase_id_token>` header.
