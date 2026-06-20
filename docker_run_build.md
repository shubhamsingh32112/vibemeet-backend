# Backend Docker build & deploy (moments upload fix)

After pulling these changes, rebuild and redeploy so production stops using the old
Cloudflare API `/blob` path for image commit.

```bash
cd backend
npm run build

# Pick a unique tag, e.g. upload-fix-20260620
export BUILD_ID=DioUploadFix

docker build -t app-backend:DioUploadFix .

docker tag app-backend:DioUploadFix 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:DioUploadFix

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:DioUploadFix
```

Then update the ECS task definition image tag to `$BUILD_ID` and force a new deployment.

**Smoke test after deploy**
1. Creator uploads a moment photo — expect `POST /moments` 201 and log `image asset committed` (no `download_image_bytes: HTTP 403`).
2. Creator uploads a moment video — expect upload-status poll to reach `ready` without webhook, then `POST /moments` 201.

No new APK is required for the backend fixes. The optional "Processing video…" status text needs a new app build.
