# Plant Weather Alert Worker — Setup

## One-time setup

### 1. Install Wrangler and log in
```bash
cd worker
npm install
npx wrangler login
```

### 2. Create a KV namespace
```bash
npx wrangler kv namespace create PUSH_SUBS
```
Copy the `id` from the output and paste it into `wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set VAPID secrets (run these in the worker/ directory)
```bash
npx wrangler secret put VAPID_PUBLIC_KEY
# paste: BMOLBUndm290cPZNaP0gngcnjJTSxDmWePMz3ZjRcIrmJ5_s89JX9ThXv4m3zWwLa_sLedKCXxUBUtUSA_oPPdg

npx wrangler secret put VAPID_PRIVATE_KEY
# paste: MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglrrfVcw3OMe7IQ7wwVP4LUPIxoTrDb-RQHvhlXizlpehRANCAATDiwVJ3ZtvdHD2TWj9IJ4HJ4yU0sQ5lnjzM92Y0XCK5ief7PPSV_U4V7-Jt81sC2v7C3nSgl8VAVLVEgP6Dz3Y
```

### 4. Deploy
```bash
npx wrangler deploy
```
The output will show your worker URL, e.g.:
`https://plant-weather-alerts.<your-subdomain>.workers.dev`

### 5. Update index.html
In index.html, replace `REPLACE_WITH_YOUR_SUBDOMAIN` in the `WORKER_URL` constant with your actual subdomain.

### 6. Test it
Visit: `https://plant-weather-alerts.<your-subdomain>.workers.dev/trigger`
You should get a push notification on your phone within a few seconds (as long as notifications are enabled in the app).

## How it works
- Cron fires at 7 AM Mountain Time (13:00 and 14:00 UTC to cover MDT/MST)
- Calls Open-Meteo for Denver weather (free, no API key)
- Sends a Web Push notification if:
  - Temp < 55°F (Calamansi safe minimum)
  - Temp < 45°F (Herb pot safe minimum)
  - Any precipitation detected
  - Wind gusts > 35 mph
- Push subscription is stored in Workers KV (free tier: 100k reads/day)
