import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Camera,
  CheckCircle2,
  Copy,
  Crop,
  FileSpreadsheet,
  FileText,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import jscanify from "jscanify";

const DB_NAME = "doc-scanner-local-db";
const DB_VERSION = 1;
const STORE_NAME = "scans";

function openScannerDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePagesToDeviceStorage(pages) {
  const db = await openScannerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    pages.forEach((page) => store.put(page));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function loadPagesFromDeviceStorage() {
  const db = await openScannerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearDeviceStorage() {
  const db = await openScannerDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

async function saveBlobToDevice(blob, filename, acceptTypes = []) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: acceptTypes });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clampScale(value) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(50, Math.min(220, value));
}

function normalizePage(page) {
  const legacyScale = Number.isFinite(page.scale) ? page.scale : 100;
  return {
    ...page,
    rotation: Number.isFinite(page.rotation) ? page.rotation : 0,
    scaleX: clampScale(Number.isFinite(page.scaleX) ? page.scaleX : legacyScale),
    scaleY: clampScale(Number.isFinite(page.scaleY) ? page.scaleY : legacyScale),
    flipX: Boolean(page.flipX),
    flipY: Boolean(page.flipY),
    pageOrientation: page.pageOrientation === "landscape" ? "landscape" : "portrait",
    autoDetected: Boolean(page.autoDetected),
  };
}

function getOrientationFromImageSize(width, height) {
  return width > height ? "landscape" : "portrait";
}

async function getImageSize(src) {
  const img = await loadImage(src);
  return { width: img.width, height: img.height };
}

async function findDocumentOnDevice(src) {
  const img = await loadImage(src);
  const maxDimension = 1100;
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const luminance = new Uint8Array(width * height);

  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    luminance[pixel] = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
  }

  const borderSamples = [];
  const sampleStep = Math.max(8, Math.floor(Math.min(width, height) / 80));
  for (let x = 0; x < width; x += sampleStep) {
    borderSamples.push(luminance[x]);
    borderSamples.push(luminance[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y += sampleStep) {
    borderSamples.push(luminance[y * width]);
    borderSamples.push(luminance[y * width + width - 1]);
  }
  const borderAverage = borderSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, borderSamples.length);

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;
  const edgeThreshold = 36;
  const backgroundThreshold = 30;
  const scanStep = 2;
  const insetX = Math.floor(width * 0.03);
  const insetY = Math.floor(height * 0.03);

  for (let y = insetY; y < height - insetY - 1; y += scanStep) {
    for (let x = insetX; x < width - insetX - 1; x += scanStep) {
      const pixel = y * width + x;
      const luma = luminance[pixel];
      const gx = Math.abs(luma - luminance[y * width + x + 1]);
      const gy = Math.abs(luma - luminance[(y + 1) * width + x]);
      const edge = gx + gy;
      const differsFromBorder = Math.abs(luma - borderAverage);
      const looksLikePaper = borderAverage < 175 ? luma > borderAverage + 22 : differsFromBorder > backgroundThreshold;

      if (edge > edgeThreshold || looksLikePaper) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hits += 1;
      }
    }
  }

  const foundWidth = maxX - minX;
  const foundHeight = maxY - minY;
  const foundArea = foundWidth * foundHeight;
  const imageArea = width * height;
  const isLikelyDocument =
    hits > 120 &&
    foundWidth > width * 0.22 &&
    foundHeight > height * 0.22 &&
    foundArea > imageArea * 0.08 &&
    foundArea < imageArea * 0.98;

  if (!isLikelyDocument) {
    return {
      src,
      found: false,
      orientation: getOrientationFromImageSize(img.width, img.height),
      confidence: 0,
    };
  }

  const marginX = Math.round(foundWidth * 0.035);
  const marginY = Math.round(foundHeight * 0.035);
  const cropX = Math.max(0, Math.round((minX - marginX) / scale));
  const cropY = Math.max(0, Math.round((minY - marginY) / scale));
  const cropWidth = Math.min(img.width - cropX, Math.round((foundWidth + marginX * 2) / scale));
  const cropHeight = Math.min(img.height - cropY, Math.round((foundHeight + marginY * 2) / scale));

  const output = document.createElement("canvas");
  output.width = cropWidth;
  output.height = cropHeight;
  const outputCtx = output.getContext("2d");
  outputCtx.fillStyle = "white";
  outputCtx.fillRect(0, 0, cropWidth, cropHeight);
  outputCtx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return {
    src: output.toDataURL("image/jpeg", 0.96),
    found: true,
    orientation: getOrientationFromImageSize(cropWidth, cropHeight),
    confidence: Math.round(Math.min(99, Math.max(1, (foundArea / imageArea) * 100))),
  };
}

function AppButton({ children, variant = "primary", disabled = false, className = "", ...props }) {
  const base =
    "inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-slate-950 text-white hover:bg-slate-800",
    secondary: "bg-slate-100 text-slate-950 hover:bg-slate-200",
    outline: "border border-slate-300 bg-white text-slate-950 hover:bg-slate-50",
  };

  return (
    <button disabled={disabled} className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

function RangeControl({ label, value, min, max, onChange, suffix = "%", icon }) {
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm">
        <span className="inline-flex items-center gap-1">
          {icon}
          {label}
        </span>
        <span>
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-slate-950"
      />
    </div>
  );
}

export default function App() {
  const [pages, setPages] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [brightness, setBrightness] = useState(106);
  const [contrast, setContrast] = useState(132);
  const [mode, setMode] = useState("scan");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [autoFindDocument, setAutoFindDocument] = useState(true);
  const [isFindingDocument, setIsFindingDocument] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isSavingImage, setIsSavingImage] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [status, setStatus] = useState("Ready. Your scans stay on this device.");
  const [hasLoadedLocalPages, setHasLoadedLocalPages] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [canInstallApp, setCanInstallApp] = useState(false);
  const [isStandaloneApp, setIsStandaloneApp] = useState(
    window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true
  );

  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const filterStyle = useMemo(() => {
    if (mode === "original") return "none";
    if (mode === "bw") return `grayscale(1) contrast(${contrast + 45}%) brightness(${brightness}%)`;
    return `grayscale(0.9) contrast(${contrast}%) brightness(${brightness}%) saturate(0.85)`;
  }, [mode, brightness, contrast]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setCanInstallApp(true);
      setStatus("This scanner can be installed as an app on this device.");
    };

    const onAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setCanInstallApp(false);
      setIsStandaloneApp(true);
      setStatus("Scanner app installed on this device.");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    loadPagesFromDeviceStorage()
      .then((storedPages) => {
        if (!isMounted) return;
        const normalizedPages = storedPages.map(normalizePage);
        setPages(normalizedPages);
        setStatus(
          normalizedPages.length
            ? `Loaded ${normalizedPages.length} saved page${normalizedPages.length === 1 ? "" : "s"} from this device.`
            : "Ready. Your scans stay on this device."
        );
      })
      .catch(() => setStatus("Local device storage is not available in this browser."))
      .finally(() => isMounted && setHasLoadedLocalPages(true));

    return () => {
      isMounted = false;
      if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedLocalPages) return;
    savePagesToDeviceStorage(pages)
      .then(() => {
        setStatus(
          pages.length
            ? `Saved ${pages.length} page${pages.length === 1 ? "" : "s"} locally on this device.`
            : "All local scans cleared from this device."
        );
      })
      .catch(() => setStatus("Unable to save locally. Export still works with downloads."));
  }, [pages, hasLoadedLocalPages]);

  const buildPageFromSource = async (src, name, forceAutoFind = false) => {
    let finalSrc = src;
    let autoDetected = false;
    let pageOrientation = "portrait";

    if (forceAutoFind || autoFindDocument) {
      const detection = await findDocumentOnDevice(src);
      finalSrc = detection.src;
      autoDetected = detection.found;
      pageOrientation = detection.orientation;
      setStatus(
        detection.found
          ? `Document found and cropped on this device. Confidence: ${detection.confidence}%.`
          : "No clear document edge found. Original image kept on this device."
      );
    } else {
      const size = await getImageSize(src);
      pageOrientation = getOrientationFromImageSize(size.width, size.height);
    }

    return {
      id: crypto.randomUUID(),
      name,
      src: finalSrc,
      createdAt: new Date().toLocaleString(),
      rotation: 0,
      scaleX: 100,
      scaleY: 100,
      flipX: false,
      flipY: false,
      pageOrientation,
      autoDetected,
    };
  };

  const addFiles = async (files) => {
    const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;

    setIsFindingDocument(true);
    setStatus("Finding document areas from selected images on this device...");

    try {
      const nextPages = [];
      for (const file of imageFiles) {
        const src = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        const page = await buildPageFromSource(src, file.name || `scan-${Date.now()}.jpg`);
        nextPages.push(page);
      }

      setPages((current) => [...current, ...nextPages]);
      setOcrText("");
    } finally {
      setIsFindingDocument(false);
    }
  };

  const onDrop = async (event) => {
    event.preventDefault();
    setIsDragging(false);
    await addFiles(event.dataTransfer.files);
  };

  const updatePageTransform = (id, updates) => {
    setPages((current) => current.map((page) => (page.id === id ? normalizePage({ ...page, ...updates }) : page)));
    setOcrText("");
  };

  const rotatePage = (id, degrees) => {
    setPages((current) =>
      current.map((page) =>
        page.id === id
          ? normalizePage({ ...page, rotation: (((page.rotation || 0) + degrees) % 360 + 360) % 360 })
          : page
      )
    );
    setOcrText("");
  };

  const toggleFlip = (id, axis) => {
    setPages((current) =>
      current.map((page) => {
        if (page.id !== id) return page;
        const normalized = normalizePage(page);
        return normalizePage({
          ...normalized,
          flipX: axis === "x" ? !normalized.flipX : normalized.flipX,
          flipY: axis === "y" ? !normalized.flipY : normalized.flipY,
        });
      })
    );
    setOcrText("");
  };

  const setPageOrientation = (id, pageOrientation) => updatePageTransform(id, { pageOrientation });

  const resetPageTransform = (id) => {
    updatePageTransform(id, {
      rotation: 0,
      scaleX: 100,
      scaleY: 100,
      flipX: false,
      flipY: false,
      pageOrientation: "portrait",
    });
  };

  const removePage = (id) => {
    setPages((current) => current.filter((page) => page.id !== id));
    setOcrText("");
  };

  const clearAll = async () => {
    setPages([]);
    setOcrText("");
    await clearDeviceStorage();
    setStatus("All scans removed from this device.");
  };

  const startCamera = async () => {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 2560 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 100);
    } catch {
      setCameraError("Camera access was blocked, or this browser/device does not support camera capture.");
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const rawSrc = canvas.toDataURL("image/jpeg", 0.95);

    setIsFindingDocument(true);
    setStatus("Camera image captured. Finding document edge on this device...");

    try {
      const page = await buildPageFromSource(rawSrc, `camera-scan-${pages.length + 1}.jpg`, true);
      setPages((current) => [...current, page]);
      setOcrText("");
    } finally {
      setIsFindingDocument(false);
    }
  };

  const autoFindExistingPage = async (id) => {
    const target = pages.find((page) => page.id === id);
    if (!target) return;

    setIsFindingDocument(true);
    setStatus("Finding document area on this page using this device...");
    try {
      const detection = await findDocumentOnDevice(target.src);
      setPages((current) =>
        current.map((page) =>
          page.id === id
            ? normalizePage({
                ...page,
                src: detection.src,
                autoDetected: detection.found,
                pageOrientation: detection.orientation,
                rotation: 0,
                scaleX: 100,
                scaleY: 100,
                flipX: false,
                flipY: false,
              })
            : page
        )
      );
      setStatus(
        detection.found
          ? `Document found and cropped on this device. Confidence: ${detection.confidence}%.`
          : "No clear document edge found. Original image kept."
      );
      setOcrText("");
    } finally {
      setIsFindingDocument(false);
    }
  };

  const processPageImage = (page) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const normalizedPage = normalizePage(page);
        const rotation = (((normalizedPage.rotation || 0) % 360) + 360) % 360;
        const horizontalScale = clampScale(normalizedPage.scaleX) / 100;
        const verticalScale = clampScale(normalizedPage.scaleY) / 100;
        const flipHorizontal = normalizedPage.flipX ? -1 : 1;
        const flipVertical = normalizedPage.flipY ? -1 : 1;
        const maxDimension = 1800;
        const baseScale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const sourceWidth = Math.round(img.width * baseScale);
        const sourceHeight = Math.round(img.height * baseScale);
        const isQuarterTurn = rotation === 90 || rotation === 270;
        const canvasWidth = isQuarterTurn ? sourceHeight : sourceWidth;
        const canvasHeight = isQuarterTurn ? sourceWidth : sourceHeight;
        const canvas = document.createElement("canvas");
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext("2d");

        ctx.filter = filterStyle;
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(horizontalScale * flipHorizontal, verticalScale * flipVertical);
        ctx.drawImage(img, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
        resolve(canvas.toDataURL("image/jpeg", 0.94));
      };
      img.onerror = reject;
      img.src = page.src;
    });

  const exportPdf = async () => {
    if (!pages.length) return;
    setIsExportingPdf(true);
    setStatus("Creating PDF on this device...");

    try {
      const { jsPDF } = await import("jspdf");
      let pdf = null;
      const margin = 8;

      for (let index = 0; index < pages.length; index += 1) {
        const page = normalizePage(pages[index]);
        const orientation = page.pageOrientation === "landscape" ? "l" : "p";

        if (!pdf) pdf = new jsPDF({ orientation, unit: "mm", format: "a4" });
        else pdf.addPage("a4", orientation);

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const processed = await processPageImage(page);
        const image = new Image();
        await new Promise((resolve) => {
          image.onload = resolve;
          image.src = processed;
        });

        const ratio = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height);
        const width = image.width * ratio;
        const height = image.height * ratio;
        const x = (pageWidth - width) / 2;
        const y = (pageHeight - height) / 2;
        pdf.addImage(processed, "JPEG", x, y, width, height);
      }

      if (!pdf) return;
      const blob = pdf.output("blob");
      await saveBlobToDevice(blob, "scanned-document.pdf", [
        { description: "PDF document", accept: { "application/pdf": [".pdf"] } },
      ]);
      setStatus("PDF saved to this device with all page processing applied locally.");
    } catch {
      setStatus("PDF export failed. Try fewer pages or smaller images.");
    } finally {
      setIsExportingPdf(false);
    }
  };

  const exportExcel = async () => {
    if (!pages.length) return;
    setIsExportingExcel(true);
    setOcrText("");
    setStatus("Running OCR on this device. No image is uploaded to a server...");

    try {
      const Tesseract = await import("tesseract.js");
      const XLSX = await import("xlsx");
      const rows = [
        ["Page", "Line", "Page Orientation", "Auto Detected", "Rotation", "Horizontal Scale", "Vertical Scale", "Flip H", "Flip V", "Extracted Text"],
      ];
      const collected = [];

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const page = normalizePage(pages[pageIndex]);
        setStatus(`OCR reading page ${pageIndex + 1} of ${pages.length} on this device...`);
        const processed = await processPageImage(page);
        const result = await Tesseract.recognize(processed, "eng", { logger: () => {} });
        const text = result?.data?.text || "";
        collected.push(
          `--- Page ${pageIndex + 1} | ${page.pageOrientation === "landscape" ? "Landscape/Horizontal" : "Portrait/Vertical"} | Auto document ${page.autoDetected ? "Yes" : "No"} | Rotation ${page.rotation}° | H ${page.scaleX}% | V ${page.scaleY}% | Flip H ${page.flipX ? "Yes" : "No"} | Flip V ${page.flipY ? "Yes" : "No"} ---\n${text.trim()}`
        );

        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

        if (!lines.length) {
          rows.push([
            pageIndex + 1,
            1,
            page.pageOrientation === "landscape" ? "Landscape/Horizontal" : "Portrait/Vertical",
            page.autoDetected ? "Yes" : "No",
            `${page.rotation}°`,
            `${page.scaleX}%`,
            `${page.scaleY}%`,
            page.flipX ? "Yes" : "No",
            page.flipY ? "Yes" : "No",
            "",
          ]);
        }

        lines.forEach((line, lineIndex) =>
          rows.push([
            pageIndex + 1,
            lineIndex + 1,
            page.pageOrientation === "landscape" ? "Landscape/Horizontal" : "Portrait/Vertical",
            page.autoDetected ? "Yes" : "No",
            `${page.rotation}°`,
            `${page.scaleX}%`,
            `${page.scaleY}%`,
            page.flipX ? "Yes" : "No",
            page.flipY ? "Yes" : "No",
            line,
          ])
        );
      }

      const finalText = collected.join("\n\n");
      setOcrText(finalText);

      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      worksheet["!cols"] = [
        { wch: 8 },
        { wch: 8 },
        { wch: 22 },
        { wch: 14 },
        { wch: 12 },
        { wch: 18 },
        { wch: 16 },
        { wch: 8 },
        { wch: 8 },
        { wch: 90 },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "OCR Text");
      const workbookArray = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
      const blob = new Blob([workbookArray], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      await saveBlobToDevice(blob, "scanned-document-text.xlsx", [
        {
          description: "Excel workbook",
          accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] },
        },
      ]);
      setStatus("Excel file saved. OCR and spreadsheet generation were processed on this device.");
    } catch {
      setStatus("Excel OCR export failed. For strict offline use, bundle the Tesseract language files with the app and try again.");
    } finally {
      setIsExportingExcel(false);
    }
  };

  const saveCurrentImages = async () => {
    if (!pages.length) return;
    setIsSavingImage(true);
    setStatus("Saving scanned image pages to this device...");

    try {
      for (let index = 0; index < pages.length; index += 1) {
        const processed = await processPageImage(pages[index]);
        const blob = dataUrlToBlob(processed);
        await saveBlobToDevice(blob, `scanned-page-${index + 1}.jpg`, [
          { description: "JPEG image", accept: { "image/jpeg": [".jpg", ".jpeg"] } },
        ]);
      }
      setStatus("Scanned image pages saved to this device with all processing applied locally.");
    } catch {
      setStatus("Image save failed. Try saving as PDF instead.");
    } finally {
      setIsSavingImage(false);
    }
  };

  const copyOcrText = async () => {
    if (!ocrText) return;
    await navigator.clipboard.writeText(ocrText);
    setStatus("OCR text copied to clipboard.");
  };

  const installAppOnDevice = async () => {
    if (isStandaloneApp) {
      setStatus("Scanner is already installed as an app on this device.");
      return;
    }

    if (!deferredInstallPrompt) {
      setStatus("Install prompt is not available yet. Use the browser menu and choose Install app/Add to Home Screen.");
      return;
    }

    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === "accepted") setStatus("Installing scanner app on this device...");
    else setStatus("App installation was cancelled.");
    setDeferredInstallPrompt(null);
    setCanInstallApp(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-6 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
              <ShieldCheck className="h-4 w-4" />
              100% On-device scanner
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Image to PDF or Excel scanner</h1>
            <p className="mt-3 max-w-2xl text-base text-slate-600 md:text-lg">
              Use the camera to capture a document, find and crop the document area on the device, then export to PDF or OCR Excel without uploading images to a server.
            </p>
          </div>

          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-3xl font-bold">{pages.length}</p>
                <p className="text-xs text-slate-500">Pages</p>
              </div>
              <div>
                <p className="text-3xl font-bold">PDF</p>
                <p className="text-xs text-slate-500">Save</p>
              </div>
              <div>
                <p className="text-3xl font-bold">XLSX</p>
                <p className="text-xs text-slate-500">OCR</p>
              </div>
            </div>
            <AppButton className="mt-4 w-full" variant={isStandaloneApp ? "secondary" : "primary"} onClick={installAppOnDevice}>
              <Smartphone className="mr-2 h-4 w-4" />
              {isStandaloneApp ? "Installed on device" : canInstallApp ? "Install app" : "Install / Add to Home Screen"}
            </AppButton>
            <p className="mt-2 text-center text-xs text-slate-500">Installable PWA over HTTPS or localhost.</p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[390px_1fr]">
        <section className="space-y-6">
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">Add document images</h2>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={`rounded-2xl border-2 border-dashed p-6 text-center transition ${
                isDragging ? "border-slate-900 bg-slate-100" : "border-slate-300 bg-white"
              }`}
            >
              <Upload className="mx-auto mb-3 h-10 w-10 text-slate-500" />
              <p className="font-medium">Drop document photos here</p>
              <p className="mt-1 text-sm text-slate-500">JPG, PNG, HEIC-converted browser images, or camera captures</p>
              <AppButton className="mt-4" onClick={() => fileInputRef.current?.click()} disabled={isFindingDocument}>
                {isFindingDocument ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
                Choose images
              </AppButton>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => addFiles(event.target.files || [])}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {!cameraOpen ? (
                <AppButton variant="secondary" onClick={startCamera}>
                  <Camera className="mr-2 h-4 w-4" />
                  Open camera
                </AppButton>
              ) : (
                <AppButton variant="secondary" onClick={stopCamera}>
                  <X className="mr-2 h-4 w-4" />
                  Close camera
                </AppButton>
              )}
              <AppButton variant="outline" onClick={clearAll} disabled={!pages.length}>
                <Trash2 className="mr-2 h-4 w-4" />
                Clear scans
              </AppButton>
            </div>

            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={autoFindDocument}
                onChange={(event) => setAutoFindDocument(event.target.checked)}
                className="mt-1 accent-slate-950"
              />
              <span>
                <span className="font-semibold">Auto-find document on device</span>
                <br />
                Camera captures always try to detect and crop the document before saving. Uploaded images can use the same local processor when enabled.
              </span>
            </label>

            {cameraError && <p className="mt-3 text-sm text-red-600">{cameraError}</p>}
          </div>

          <AnimatePresence>
            {cameraOpen && (
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
                <div className="rounded-2xl border bg-white p-5 shadow-sm">
                  <h2 className="mb-4 text-xl font-semibold">Camera scanner</h2>
                  <video ref={videoRef} autoPlay playsInline className="aspect-[3/4] w-full rounded-2xl bg-black object-cover" />
                  <AppButton className="mt-4 w-full" onClick={capturePhoto} disabled={isFindingDocument}>
                    {isFindingDocument ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                    Capture and find document
                  </AppButton>
                  <p className="mt-3 text-sm text-slate-500">After capture, your device processor detects the document area and crops it before saving.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">Enhancement</h2>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["scan", "Scan"],
                ["bw", "B/W"],
                ["original", "Original"],
              ].map(([value, label]) => (
                <AppButton key={value} variant={mode === value ? "primary" : "outline"} onClick={() => setMode(value)}>
                  {label}
                </AppButton>
              ))}
            </div>

            <div className="mt-5 space-y-5">
              <RangeControl label="Brightness" value={brightness} min={80} max={140} onChange={setBrightness} />
              <RangeControl label="Contrast" value={contrast} min={90} max={210} onChange={setContrast} />
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">Save / Export</h2>
            <div className="grid gap-3">
              <AppButton onClick={exportPdf} disabled={!pages.length || isExportingPdf || isFindingDocument}>
                {isExportingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                Save as PDF
              </AppButton>

              <AppButton variant="secondary" onClick={exportExcel} disabled={!pages.length || isExportingExcel || isFindingDocument}>
                {isExportingExcel ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                OCR and save Excel
              </AppButton>

              <AppButton variant="outline" onClick={saveCurrentImages} disabled={!pages.length || isSavingImage || isFindingDocument}>
                {isSavingImage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save page images
              </AppButton>
            </div>

            <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
              <div className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <p>{status}</p>
              </div>
              <p className="mt-2">Capture, document detection, cropping, filters, rotation, scaling, OCR, PDF creation, Excel creation, and local saving are handled in the browser on this device.</p>
              <div className="mt-3 rounded-xl border bg-white p-3">
                <p className="font-semibold text-slate-800">Install as app</p>
                <p className="mt-1 text-xs text-slate-500">Android/Chrome or desktop Chrome/Edge: press Install app when available. iPhone/iPad: Safari Share → Add to Home Screen.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold">Preview pages</h2>
                <p className="text-sm text-slate-500">Choose page layout, rotate, flip, scale, or re-run local document detection.</p>
              </div>
              <AppButton
                variant="outline"
                onClick={() => {
                  setBrightness(106);
                  setContrast(132);
                  setMode("scan");
                  setPages((current) =>
                    current.map((page) =>
                      normalizePage({ ...page, rotation: 0, scaleX: 100, scaleY: 100, flipX: false, flipY: false, pageOrientation: "portrait" })
                    )
                  );
                  setOcrText("");
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Reset all
              </AppButton>
            </div>

            {!pages.length ? (
              <div className="flex min-h-[460px] flex-col items-center justify-center rounded-2xl border bg-white p-8 text-center">
                <ScanLine className="mb-4 h-14 w-14 text-slate-300" />
                <h3 className="text-lg font-semibold">No pages yet</h3>
                <p className="mt-2 max-w-md text-sm text-slate-500">Upload document images or use your camera. The app will find document edges locally, save scans locally, and export to PDF, Excel, or image files.</p>
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence>
                  {pages.map((rawPage, index) => {
                    const page = normalizePage(rawPage);
                    const cssScaleX = (page.flipX ? -1 : 1) * (page.scaleX / 100);
                    const cssScaleY = (page.flipY ? -1 : 1) * (page.scaleY / 100);

                    return (
                      <motion.div key={page.id} layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} className="overflow-hidden rounded-2xl border bg-white shadow-sm">
                        <div className="relative overflow-hidden bg-slate-100 p-3">
                          <div className={`flex ${page.pageOrientation === "landscape" ? "aspect-[4/3]" : "aspect-[3/4]"} items-center justify-center overflow-hidden rounded-xl bg-white`}>
                            <img
                              src={page.src}
                              alt={page.name}
                              className="max-h-full max-w-full object-contain transition-transform duration-200"
                              style={{ filter: filterStyle, transform: `rotate(${page.rotation}deg) scaleX(${cssScaleX}) scaleY(${cssScaleY})`, transformOrigin: "center center" }}
                            />
                          </div>
                          <div className="absolute left-5 top-5 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold shadow-sm">Page {index + 1}</div>
                          {page.autoDetected && <div className="absolute right-5 top-5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm">Auto-cropped</div>}
                        </div>

                        <div className="space-y-4 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{page.name}</p>
                              <p className="text-xs text-slate-500">
                                {page.createdAt} • {page.pageOrientation === "landscape" ? "Landscape" : "Portrait"} • {page.rotation}° • H {page.scaleX}% • V {page.scaleY}%
                                {page.flipX ? " • Flip H" : ""}
                                {page.flipY ? " • Flip V" : ""}
                              </p>
                            </div>
                            <button className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-red-600" onClick={() => removePage(page.id)} aria-label={`Remove page ${index + 1}`}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>

                          <AppButton variant="secondary" className="w-full" onClick={() => autoFindExistingPage(page.id)} disabled={isFindingDocument}>
                            {isFindingDocument ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Crop className="mr-2 h-4 w-4" />}
                            Find document area
                          </AppButton>

                          <div className="grid grid-cols-2 gap-2">
                            <AppButton variant={page.pageOrientation === "portrait" ? "primary" : "outline"} className="px-2" onClick={() => setPageOrientation(page.id, "portrait")}>
                              <ArrowUpDown className="mr-1 h-4 w-4" />
                              Vertical
                            </AppButton>
                            <AppButton variant={page.pageOrientation === "landscape" ? "primary" : "outline"} className="px-2" onClick={() => setPageOrientation(page.id, "landscape")}>
                              <ArrowLeftRight className="mr-1 h-4 w-4" />
                              Horizontal
                            </AppButton>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <AppButton variant="outline" className="px-2" onClick={() => rotatePage(page.id, -90)}>
                              <RotateCcw className="mr-1 h-4 w-4" />
                              Left
                            </AppButton>
                            <AppButton variant="outline" className="px-2" onClick={() => rotatePage(page.id, 90)}>
                              <RotateCw className="mr-1 h-4 w-4" />
                              Right
                            </AppButton>
                            <AppButton variant="secondary" className="px-2" onClick={() => resetPageTransform(page.id)}>
                              Reset
                            </AppButton>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <AppButton variant={page.flipX ? "primary" : "outline"} className="px-2" onClick={() => toggleFlip(page.id, "x")}>
                              <ArrowLeftRight className="mr-1 h-4 w-4" />
                              Flip H
                            </AppButton>
                            <AppButton variant={page.flipY ? "primary" : "outline"} className="px-2" onClick={() => toggleFlip(page.id, "y")}>
                              <ArrowUpDown className="mr-1 h-4 w-4" />
                              Flip V
                            </AppButton>
                          </div>

                          <div className="space-y-4 rounded-2xl bg-slate-50 p-3">
                            <RangeControl label="Horizontal scale" value={page.scaleX} min={50} max={220} onChange={(value) => updatePageTransform(page.id, { scaleX: value })} icon={<ArrowLeftRight className="h-4 w-4" />} />
                            <RangeControl label="Vertical scale" value={page.scaleY} min={50} max={220} onChange={(value) => updatePageTransform(page.id, { scaleY: value })} icon={<ArrowUpDown className="h-4 w-4" />} />
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>

          {ocrText && (
            <div className="rounded-2xl border bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">OCR result</h2>
                  <p className="text-sm text-slate-500">Text extracted from the scanned pages locally on this device.</p>
                </div>
                <AppButton variant="outline" onClick={copyOcrText}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy text
                </AppButton>
              </div>
              <pre className="max-h-96 overflow-auto rounded-2xl bg-slate-950 p-4 text-sm leading-6 text-slate-50">{ocrText}</pre>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
