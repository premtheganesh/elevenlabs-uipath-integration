# ElevenLabs + UiPath Middleware

This middleware solves the async response issue between ElevenLabs and UiPath API Workflows.

## What it does

1. Receives webhooks from ElevenLabs
2. Forwards to UiPath webhook
3. Waits for UiPath to process (5 seconds)
4. Fetches actual result from UiPath Orchestrator API
5. Returns clean JSON to ElevenLabs

## Setup Instructions

### Step 1: Configure Your Credentials

Open `elevenlabs-uipath-middleware.js` and replace these values:

```javascript
const CONFIG = {
  CLIENT_ID: 'YOUR_CLIENT_ID_HERE',        // Your UiPath Client ID
  CLIENT_SECRET: 'YOUR_CLIENT_SECRET_HERE' // Your UiPath Client Secret
};
```

### Step 2: Deploy to Vercel (FREE)

1. **Install Vercel CLI:**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel --prod
   ```

4. **You'll get URLs like:**
   - `https://your-project.vercel.app/check-availability`
   - `https://your-project.vercel.app/book-appointment`

### Step 3: Update ElevenLabs Tools

In ElevenLabs agent settings:

**check_availability tool:**
- Change URL from: `https://cloud.uipath.com/leaniar/.../webhooks/...`
- To: `https://your-project.vercel.app/check-availability`

**book_appointment tool:**
- Change URL from: `https://cloud.uipath.com/leaniar/.../webhooks/...`
- To: `https://your-project.vercel.app/book-appointment`

### Step 4: Test!

Make a test call to your ElevenLabs agent and verify:
1. It calls your middleware
2. Middleware calls UiPath
3. Returns proper response with `available: true/false`

## Testing Locally

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

Test with curl:
```bash
curl -X POST http://localhost:3000/check-availability \
  -H "Content-Type: application/json" \
  -d '{"date":"10-02-2026","time":"14:00","duration":"30"}'
```

## Troubleshooting

**OAuth Error:**
- Check CLIENT_ID and CLIENT_SECRET are correct
- Verify scopes include OR.Jobs and OR.Jobs.Read

**No job found:**
- Increase WAIT_TIME_MS in config
- Check process names match exactly

**Wrong data returned:**
- Verify process names: 'check_availability' and 'book_appointment'
- Check Output format in UiPath workflows

## Environment Variables (Optional)

For security, you can use environment variables instead of hardcoding credentials:

```bash
CLIENT_ID=xxx CLIENT_SECRET=xxx node elevenlabs-uipath-middleware.js
```

Then in code:
```javascript
CLIENT_ID: process.env.CLIENT_ID || 'YOUR_CLIENT_ID_HERE'
```
