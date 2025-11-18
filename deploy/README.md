# Deployment steps for plus.eblusha.org

These files are prefilled for your project and domain.

## 1) Copy repo to server
```
sudo mkdir -p /opt/eblusha-plus && sudo chown -R $USER:$USER /opt/eblusha-plus
cd /opt/eblusha-plus
# push your local commits, then on server:
git clone YOUR_REPO_URL .
```

## 2) Start Postgres
```
cd /opt/eblusha-plus/deploy
docker compose up -d
```

## 3) Create .env (production)
Create `/opt/eblusha-plus/.env` based on below template (values already tailored):
```
NODE_ENV=production
PORT=4000
APP_ORIGIN=https://plus.eblusha.org
DATABASE_URL=postgresql://eblusha:S3cure_DB_Pass@127.0.0.1:5432/eblusha?schema=public
JWT_SECRET=replace_with_long_random_hex_64
JWT_REFRESH_SECRET=replace_with_long_random_hex_64
LIVEKIT_URL=wss://voice.eblusha.org
LIVEKIT_API_KEY=myapp
LIVEKIT_API_SECRET=YOUR_LIVEKIT_SECRET
```

## 4) Build backend and run migrations
```
cd /opt/eblusha-plus
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
```

## 5) Systemd service
```
sudo cp deploy/eblusha.service /etc/systemd/system/eblusha.service
sudo systemctl daemon-reload
sudo systemctl enable --now eblusha
sudo journalctl -u eblusha -f
```

## 6) Frontend build and publish
```
cd /opt/eblusha-plus/frontend
npm ci
npm run build
sudo mkdir -p /var/www/plus.eblusha.org
sudo rsync -a dist/ /var/www/plus.eblusha.org/
```

## 7) Nginx
```
sudo cp /opt/eblusha-plus/deploy/nginx-plus.eblusha.org.conf /etc/nginx/sites-available/plus.eblusha.org
sudo ln -sf /etc/nginx/sites-available/plus.eblusha.org /etc/nginx/sites-enabled/plus.eblusha.org
sudo nginx -t && sudo systemctl reload nginx
```

## 8) HTTPS
```
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d plus.eblusha.org --redirect --agree-tos -m you@example.com -n
```


