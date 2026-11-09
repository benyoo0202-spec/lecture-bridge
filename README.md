# Lecture Bridge

Live Korean captions for English college lectures. Each student opens the site on their MacBook or iPhone, presses **수업 시작 (Start class)**, and the device's microphone listens to the professor. Every sentence appears in English, then in Korean a second or two later. The site also builds:

- **용어** – key terms with simple Korean explanations
- **요약** – a Korean (and simple English) summary that updates every few minutes
- **복습** – review questions with answers, made when class ends

Everything stays on the student's own device. Nothing is shared between students, and a refresh keeps the captions.

## What you need

1. A free **GitHub** account (to hold the code)
2. A free **Render** account (to put the site online): https://render.com
3. A **Claude API key** from https://console.anthropic.com (Settings → API Keys). Translation is paid per use on your API account; set a monthly spend limit in the console.

## Put it online (about 10 minutes)

1. Create a new GitHub repository and upload every file in this folder (keep the `public` folder).
2. In Render, choose **New → Blueprint**, pick the repository, and click **Apply**. Render reads `render.yaml` and sets everything up.
3. When Render asks for environment variables:
   - `ANTHROPIC_API_KEY` – paste your Claude API key
   - `CLASS_CODE` – a short code like `psy1010`. Students type it once. Leave it empty if you don't want a code, but then anyone who finds the link can use your API key.
4. Wait for the deploy to finish, then open the `https://…onrender.com` link Render gives you and share it with the class.

Render's free plan sleeps after 15 minutes of no use, so the first visit before class can take up to a minute to load. Open the link a few minutes early, or pick a paid plan to avoid this.

## Which browsers work

| Device | Use | Notes |
|---|---|---|
| iPhone / iPad | **Safari** | Settings → General → Keyboard → **Enable Dictation** must be on. Allow the microphone when asked. |
| MacBook | **Chrome** or **Safari** | If no prompt appears: System Settings → Privacy & Security → Microphone → turn on the browser. |
| Windows / Android | **Chrome** or **Edge** | Works the same way. |
| Firefox | Not supported | Firefox has no built-in speech recognition. |

Tips for students:
- Sit where the professor is easy to hear, or put the phone near the front.
- Keep the page open on screen. If the phone locks or you switch apps, listening pauses and restarts when you come back.
- Speech recognition in Safari and Chrome uses Apple's or Google's servers, so the device needs internet.

## Run it on your own computer

You need Node.js 18 or newer.

```
ANTHROPIC_API_KEY=your-key node server.js
```

Then open http://localhost:3000 in Chrome or Safari. (Phones need the HTTPS link from Render; microphones only work on secure sites.)

## Settings you can change (optional environment variables)

| Name | Default | What it does |
|---|---|---|
| `TRANSLATE_MODEL` | `claude-haiku-5-5` | Fast model for line-by-line translation |
| `SUMMARY_MODEL` | `claude-sonnet-5-5` | Model for summaries, key terms and study guides |
| `CLASS_CODE` | (none) | Code students must enter before translation works |
