import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const COLORS = ["#ffeb3b", "#ffd54f", "#ffe082", "#ffcc80", "#ffab91", "#f48fb1", "#f8bbd0", "#ce93d8", "#b39ddb", "#90caf9", "#80cbc4", "#a5d6a7", "#c5e1a5", "#b2dfdb", "#cfd8dc"];
const DEFAULT_OPACITY = 0.35;
const DEFAULT_THICKNESS = 14;

const hexToRgb01 = (hex) => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const v = parseInt(full, 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return { r01: r / 255, g01: g / 255, b01: b / 255 };
};
const rgbaCss = (hex, a) => {
  const { r01, g01, b01 } = hexToRgb01(hex);
  return `rgba(${Math.round(r01 * 255)}, ${Math.round(g01 * 255)}, ${Math.round(b01 * 255)}, ${a})`;
};

export default function PDFHighlighterApp() {
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const overlaysRef = useRef({});
  const renderTokenRef = useRef("");

  const [pdfBytes, setPdfBytes] = useState(null);
  const [doc, setDoc] = useState(null);
  const [scale, setScale] = useState(1.25);
  const [activeColor, setActiveColor] = useState(COLORS[0]);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS);
  const [eraser, setEraser] = useState(false);
  const [highlights, setHighlights] = useState({});

  const colorRef = useRef(activeColor);
  const opacityRef = useRef(opacity);
  const thickRef = useRef(thickness);
  const eraserRef = useRef(eraser);
  const highlightsRef = useRef(highlights);

  useEffect(() => { colorRef.current = activeColor; }, [activeColor]);
  useEffect(() => { opacityRef.current = opacity; }, [opacity]);
  useEffect(() => { thickRef.current = thickness; }, [thickness]);
  useEffect(() => { eraserRef.current = eraser; updateOverlayCursors(); }, [eraser]);
  useEffect(() => { highlightsRef.current = highlights; repaintAllOverlays(); }, [highlights]);

  const onOpen = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const libBytes = bytes.slice();
    const viewerBytes = bytes.slice();
    setPdfBytes(libBytes);
    setHighlights({});
    const loading = pdfjsLib.getDocument({ data: viewerBytes });
    const pdf = await loading.promise;
    setDoc(pdf);
    setTimeout(() => renderAll(pdf, scale), 0);
  };

  useEffect(() => { if (doc) renderAll(doc, scale); }, [doc, scale]);

  const renderAll = (pdf, scaleVal) => {
    const container = containerRef.current;
    if (!container) return;
    const token = Math.random().toString(36).slice(2);
    renderTokenRef.current = token;
    container.innerHTML = "";
    overlaysRef.current = {};

    (async () => {
      const wrappers = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const wrap = document.createElement("div");
        wrap.style.position = "relative";
        wrap.style.marginBottom = "12px";
        wrap.style.background = "#fff";
        container.appendChild(wrap);
        wrappers.push(wrap);
      }

      for (let i = 1; i <= pdf.numPages; i++) {
        if (renderTokenRef.current !== token) return;
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: scaleVal });
        const canvas = document.createElement("canvas");
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport }).promise;

        const overlay = document.createElement("div");
        overlay.style.position = "absolute";
        overlay.style.inset = "0";
        overlay.style.userSelect = "none";
        overlay.style.cursor = eraserRef.current ? "not-allowed" : "crosshair";
        overlay.__viewport = viewport;
        overlay.__pageIndex = i - 1;

        const wrap = wrappers[i - 1];
        wrap.innerHTML = "";
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        wrap.appendChild(canvas);
        wrap.appendChild(overlay);
        overlaysRef.current[i - 1] = overlay;
        attachOverlayHandlers(overlay);
        drawPage(overlay);
      }
    })();
  };

  const updateOverlayCursors = () => {
    Object.values(overlaysRef.current).forEach((ov) => {
      if (ov) ov.style.cursor = eraserRef.current ? "not-allowed" : "crosshair";
    });
  };

  const attachOverlayHandlers = (overlay) => {
    let isDrawing = false;
    let start = null;
    let tempBox = null;
    const getLocal = (evt) => {
      const r = overlay.getBoundingClientRect();
      return { x: evt.clientX - r.left, y: evt.clientY - r.top };
    };

    overlay.onpointerdown = (e) => {
      overlay.setPointerCapture(e.pointerId);
      const { x, y } = getLocal(e);
      if (eraserRef.current) {
        const vp = overlay.__viewport;
        const pageIndex = overlay.__pageIndex;
        const list = highlightsRef.current[pageIndex] || [];
        const hit = list.findIndex((hl) => {
          const px = hl.x * vp.width, py = hl.y * vp.height;
          const pw = hl.w * vp.width, ph = hl.h * vp.height;
          return x >= px && x <= px + pw && y >= py && y <= py + ph;
        });
        if (hit !== -1) {
          setHighlights((prev) => {
            const next = { ...prev };
            const arr = [...(next[pageIndex] || [])];
            arr.splice(hit, 1);
            next[pageIndex] = arr;
            return next;
          });
        }
        return;
      }
      isDrawing = true;
      start = { x, y };
      tempBox = document.createElement("div");
      tempBox.style.position = "absolute";
      tempBox.style.pointerEvents = "none";
      tempBox.style.background = rgbaCss(colorRef.current, opacityRef.current);
      tempBox.style.border = `1px dashed ${colorRef.current}`;
      overlay.appendChild(tempBox);
    };

    overlay.onpointermove = (e) => {
      if (!isDrawing || !start || !tempBox) return;
      const { x, y } = getLocal(e);
      const w = Math.abs(x - start.x);
      const h = Math.abs(y - start.y) || thickRef.current;
      const x0 = Math.min(x, start.x);
      const y0 = Math.min(y, start.y);
      Object.assign(tempBox.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px` });
    };

    const commit = () => {
      if (!isDrawing || !start || !tempBox) return;
      const pageIndex = overlay.__pageIndex;
      const vp = overlay.__viewport;
      const left = parseFloat(tempBox.style.left || "0");
      const top = parseFloat(tempBox.style.top || "0");
      const width = parseFloat(tempBox.style.width || "0");
      const height = parseFloat(tempBox.style.height || "0");
      tempBox.remove();
      tempBox = null;
      if (width < 3 || height < 3) { isDrawing = false; start = null; return; }
      const norm = { id: Math.random().toString(36).slice(2), x: left / vp.width, y: top / vp.height, w: width / vp.width, h: height / vp.height, color: colorRef.current, opacity: opacityRef.current };
      setHighlights((prev) => {
        const next = { ...prev, [pageIndex]: [...(prev[pageIndex] || []), norm] };
        drawPageWithData(overlay, next[pageIndex]);
        return next;
      });
      isDrawing = false;
      start = null;
    };

    overlay.onpointerup = commit;
    overlay.onpointerleave = () => { if (isDrawing) commit(); };
  };

  const drawPageWithData = (overlay, list) => {
    overlay.innerHTML = "";
    const vp = overlay.__viewport;
    (list || []).forEach((hl) => {
      const d = document.createElement("div");
      d.style.position = "absolute";
      d.style.left = `${hl.x * vp.width}px`;
      d.style.top = `${hl.y * vp.height}px`;
      d.style.width = `${hl.w * vp.width}px`;
      d.style.height = `${hl.h * vp.height}px`;
      d.style.background = rgbaCss(hl.color, hl.opacity ?? opacityRef.current);
      overlay.appendChild(d);
    });
  };

  const drawPage = (overlay) => {
    const pageIndex = overlay.__pageIndex;
    const list = highlightsRef.current[pageIndex] || [];
    drawPageWithData(overlay, list);
  };

  const repaintAllOverlays = () => {
    Object.values(overlaysRef.current).forEach((ov) => ov && drawPage(ov));
  };

  const onSave = async () => {
    if (!pdfBytes) return;
    const pdf = await PDFDocument.load(pdfBytes);
    for (let i = 0; i < pdf.getPageCount(); i++) {
      const page = pdf.getPage(i);
      const { width, height } = page.getSize();
      const list = highlightsRef.current[i] || [];
      list.forEach((hl) => {
        const { r01, g01, b01 } = hexToRgb01(hl.color);
        const W = hl.w * width;
        const H = hl.h * height;
        const X = hl.x * width;
        const Y = height - (hl.y * height + H);
        page.drawRectangle({ x: X, y: Y, width: W, height: H, color: rgb(r01, g01, b01), opacity: hl.opacity ?? opacityRef.current });
      });
    }
    const out = await pdf.save();
    const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "annotated.pdf";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-3 py-2 flex flex-wrap items-center gap-3">
          <input ref={fileInputRef} type="file" accept="application/pdf" onChange={onOpen} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 rounded border bg-white shadow-sm">Open PDF</button>
          <div className="flex items-center gap-2">
            <button onClick={() => setScale((s) => Math.max(0.5, s - 0.1))} className="px-2 py-1 rounded border bg-white">-</button>
            <div className="px-2 text-sm tabular-nums">{scale.toFixed(2)}x</div>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.1))} className="px-2 py-1 rounded border bg-white">+</button>
          </div>
          <div className="flex items-center gap-2">
            {COLORS.map((c) => (
              <button key={c} onClick={() => { setActiveColor(c); setEraser(false); }} title={c} className={`w-6 h-6 rounded-full border ${activeColor === c ? "ring-2 ring-slate-800" : ""}`} style={{ background: c }} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">Opacity</span>
            <input type="range" min={0.1} max={0.9} step={0.05} value={opacity} onChange={(e) => setOpacity(parseFloat(e.target.value))} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">Thickness</span>
            <input type="range" min={6} max={40} step={1} value={thickness} onChange={(e) => setThickness(parseInt(e.target.value))} />
            <span className="text-sm w-8 text-center">{thickness}px</span>
          </div>
          <button onClick={() => setEraser((v) => !v)} className={`px-3 py-1.5 rounded border ${eraser ? "bg-rose-50 border-rose-300" : "bg-white"}`}>{eraser ? "Eraser: ON" : "Eraser"}</button>
          <div className="ml-auto">
            <button onClick={onSave} disabled={!pdfBytes} className="px-3 py-1.5 rounded border bg-emerald-600 text-white disabled:opacity-50">Save as PDF</button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-3">
        {!doc && <div className="text-center py-16 text-slate-500">Open a PDF to start highlighting.</div>}
        <div ref={containerRef} className="flex flex-col items-start"></div>
      </main>
    </div>
  );
}