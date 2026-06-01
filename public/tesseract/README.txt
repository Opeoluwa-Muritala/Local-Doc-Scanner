Optional strict-offline OCR files
=================================

The app uses Tesseract.js to process OCR in the browser, on the device CPU.
Images are not uploaded to your server for OCR.

For strict offline use after installation, place local Tesseract.js worker/core/language files here and configure src/App.jsx TESSERACT_OPTIONS.
Typical files are:

- worker.min.js
- tesseract-core.wasm.js
- tesseract-core.wasm
- eng.traineddata.gz

If you do not bundle these files, Tesseract.js may download its OCR engine/language data the first time OCR is used, depending on the installed package version and build setup.
