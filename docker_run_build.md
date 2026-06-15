docker build -t app-backend:recents0 .

docker tag app-backend:recents0 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:recents0

aws --no-verify-ssl ecr get-login-password --region ap-south-1 ` | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com
  
docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:recents0 