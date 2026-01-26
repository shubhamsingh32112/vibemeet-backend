# Backend Setup for ADB WiFi (192.168.1.42:5555)

## Quick Start

### 1. Start Backend Server

```bash
cd backend
npm install  # First time only
npm run dev
```

You should see:
```
🚀 Server running on port 3000
📡 Listening on all interfaces (0.0.0.0:3000)
📍 Access URLs:
   Local:    http://localhost:3000/health
   Network:  http://192.168.1.42:3000/health
📱 Frontend Configuration:
   Base URL: http://192.168.1.42:3000/api/v1
   ADB:      adb connect 192.168.1.42:5555
✅ Backend is ready to accept connections from your Flutter app
```

### 2. Verify Backend is Accessible

**From your phone's browser**, open:
```
http://192.168.1.42:3000/health
```

You should see:
```json
{
  "status": "ok",
  "timestamp": "2024-01-XX...",
  "server": "Eazy Talks Backend",
  "version": "1.0.0"
}
```

### 3. Connect Flutter App via ADB

```bash
adb connect 192.168.1.42:5555
adb devices  # Verify connection
```

### 4. Run Flutter App

```bash
cd frontend
flutter run
```

## Configuration

### Backend (.env file)

```env
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
PORT=3000
CORS_ORIGIN=*
```

### Frontend (lib/core/constants/app_constants.dart)

```dart
static const String baseUrl = 'http://192.168.1.42:3000/api/v1';
```

## Troubleshooting

### Backend not accessible from phone

1. **Check Windows Firewall:**
   ```powershell
   # Allow port 3000
   netsh advfirewall firewall add rule name="Node.js Backend" dir=in action=allow protocol=TCP localport=3000
   ```

2. **Verify IP Address:**
   ```powershell
   ipconfig
   # Look for IPv4 Address under your active network adapter
   # Should match 192.168.1.42
   ```

3. **Test from phone browser:**
   - Open `http://192.168.1.42:3000/health`
   - If it fails, backend is not accessible

### Connection Refused

- Backend is not running → Start with `npm run dev`
- Wrong IP address → Update both backend logs and frontend constants
- Firewall blocking → Allow port 3000

### CORS Errors

- Backend CORS is set to `*` (allow all) for development
- Should work automatically

## Network Requirements

- ✅ Desktop and phone on same WiFi network
- ✅ Backend listening on `0.0.0.0:3000` (all interfaces)
- ✅ Firewall allows port 3000
- ✅ IP address 192.168.1.42 is correct

## Testing

1. **Test backend health:**
   ```bash
   curl http://192.168.1.42:3000/health
   ```

2. **Test from Flutter app:**
   - Sign in with Google
   - Check console logs for backend sync
   - Should see successful connection

## Logs to Watch

**Backend logs will show:**
- `📥 GET /health from ::ffff:192.168.1.42` - Health check
- `🔐 [AUTH MIDDLEWARE] Verifying Firebase token...` - Auth request
- `✅ [AUTH] Login response sent` - Successful login

**Frontend logs will show:**
- `📡 [AUTH] Sending login request to backend...`
- `📥 [AUTH] Backend response received`
- `✅ [AUTH] Backend sync successful`
