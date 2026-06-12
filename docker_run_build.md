docker build -t app-backend:DDcall .

docker tag app-backend:DDcall 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:DDcall

aws --no-verify-ssl ecr get-login-password --region ap-south-1 ` >> | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com
  
docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:DDcall  