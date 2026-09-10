# PipeCounter Web

Progressive Web App for counting pipe ends from photos.  
Works on iPhone, Android, and desktop — no app store needed.

## Deploy to GitHub Pages

1. Create a new repository at https://github.com/new  
   Name it `pipecounter` (or anything you like). Keep it **Public**.

2. Open a terminal in this folder and run:

```bash
git init
git add .
git commit -m "Initial PipeCounter web app"
git remote add origin https://github.com/YOUR_USERNAME/pipecounter.git
git push -u origin main
```

3. On GitHub → your repo → **Settings** → **Pages**  
   Source: **Deploy from a branch** → Branch: `main` → Folder: `/ (root)` → Save.

4. Wait ~1 minute. Your app will be live at:  
   `https://YOUR_USERNAME.github.io/pipecounter/`

## Install on iPhone

1. Open the link in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** button (box with arrow).
3. Tap **"Add to Home Screen"**.
4. The app icon appears on your home screen — works offline after first load.

## Install on Android

1. Open the link in **Chrome**.
2. Tap the menu (⋮) → **"Add to Home Screen"** or **"Install App"**.

## Notes

- The AI model (25 MB) downloads once on first visit and is stored offline.
- Detection runs entirely on-device — no data is sent anywhere.
- Keep the screen on during scanning — iOS does not allow background JS execution.
  Go to **Settings → Display & Brightness → Auto-Lock → Never** on the job site
  if scans take a long time.
