# Local Doc Scanner PWA

A browser-based document scanner that can be installed as an app on a phone, tablet, or desktop.

## Features

- Upload document images
- Capture documents with camera
- Automatically find and crop document area on the device
- Save scans locally on the device using IndexedDB
- Rotate pages left/right
- Choose page layout: Portrait/Vertical or Landscape/Horizontal
- Flip horizontal / flip vertical
- Horizontal and vertical scale controls
- Brightness and contrast controls
- Export scanned pages as PDF
- OCR scanned pages and export text to Excel
- Save processed pages as JPG images
- PWA install button: install to home screen or desktop
- No backend required

## Important privacy note

The image processing, document detection, cropping, rotation, scaling, PDF generation, Excel generation, and scan storage run locally in the browser on the user device.

OCR is performed with Tesseract.js in the browser. Images are not uploaded to your server for OCR. For strict offline OCR, bundle the Tesseract worker/core/language files inside `public/tesseract` and configure the OCR call in `src/App.jsx` to point to those local files.

## Requirements

- Node.js 18+
- HTTPS hosting for camera and PWA install features, or `localhost` during development

## Install locally

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

## Build for upload

```bash
npm run build
```

Upload the generated `dist` folder to your hosting provider.

Good hosting options:

- Netlify
- Vercel
- Firebase Hosting
- GitHub Pages
- Any HTTPS static hosting

## PWA install notes

For the install button to appear:

1. The site must be served over HTTPS or localhost.
2. `manifest.json` must be available.
3. `service-worker.js` must be registered.
4. The app must have valid icons.
5. Browser install support varies.

Android Chrome and desktop Chrome/Edge normally show the install prompt. On iPhone/iPad, use Safari → Share → Add to Home Screen.

## Files included

```text
local-doc-scanner-pwa/
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── README.md
├── public/
│   ├── manifest.json
│   ├── service-worker.js
│   ├── icons/
│   │   ├── icon-192.png
│   │   └── icon-512.png
│   └── tesseract/
│       └── README.txt
└── src/
    ├── App.jsx
    ├── index.css
    └── main.jsx
```
