import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// ===== Config =====
const COLORS = [
  "#ffeb3b", "#ffd54f", "#ffe082", "#ffcc80", "#ffab91",
  "#f48fb1", "#f8bbd0", "#ce93d8", "#b39ddb", "#90caf9",
  "#80cbc4", "#a5d6a7", "#c5e1a5", "#b2dfdb", "#cfd8dc",
];
const DEFAULT_OPACITY = 0.22; // tuned so text always stays very readable // looks like a real highlighter
const DEFAULT_THICKNESS = 18;

// Helper: rgba css from hex + alpha
const rgbaCss = (hex, a) => {
  const h = hex.replace('#','');
  const v = parseInt(h.length===3 ? h.split('').map(c=>c+c).join('') : h, 16);
  const r = (v>>16)&255, g=(v>>8)&255, b=v&255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

export default function PDFHighlighterApp() {
  const containerRef = useRef(null);         // wraps all pages
  const fileInputRef = useRef(null);
  const overlaysRef = useRef({});            // pageIndex -> overlay <canvas>
  const renderTokenRef = useRef("");        // cancel stale renders

  // Core state
  const [pdfBytes, setPdfBytes] = useState(null); // pristine bytes for pdf-lib
  const [pdfDoc, setPdfDoc] = useState(null);
  const [baseScale] = useState(1.25);        // fixed render scale for pdf.js
  const [zoom, setZoom] = useState(1);       // visual zoom via CSS transform

  // Tool state
  const [color, setColor] = useState(COLORS[0]);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY); // UI value; we still clamp internally
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS);
  const [eraser, setEraser] = useState(false);

  // Live refs for handlers (avoid stale closures)
  const colorRef = useRef(color);
  const opacityRef = useRef(opacity);
  const thickRef = useRef(thickness);
  const eraserRef = useRef(eraser);
  useEffect(()=>{ colorRef.current = color; },[color]);
  useEffect(()=>{ opacityRef.current = opacity; },[opacity]);
  useEffect(()=>{ thickRef.current = thickness; },[thickness]);
  useEffect(()=>{ eraserRef.current = eraser; updateOverlayCursors(); },[eraser]);

  // Keep CSS zoom in sync
  useEffect(()=>{
    if (containerRef.current) {
      containerRef.current.style.transformOrigin = 'top left';
      containerRef.current.style.transform = `scale(${zoom})`;
    }
  },[zoom]);

  // ===== File open =====
  const onOpen = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const libBytes = bytes.slice();      // keep pristine for pdf-lib
    const viewerBytes = bytes.slice();   // give this to pdf.js
    setPdfBytes(libBytes);

    const loading = pdfjsLib.getDocument({ data: viewerBytes });
    const doc = await loading.promise;
    setPdfDoc(doc);
    setTimeout(() => renderAll(doc, baseScale), 0);
  };

  useEffect(()=>{ if (pdfDoc) renderAll(pdfDoc, baseScale); }, [pdfDoc, baseScale]);

  // ===== Render all pages (bitmap + overlay brush) =====
  const renderAll = (doc, scaleVal) => {
    const container = containerRef.current;
    if (!container) return;

    const token = Math.random().toString(36).slice(2);
    renderTokenRef.current = token;
    container.innerHTML = '';
    overlaysRef.current = {};

    (async ()=>{
      // Pre-create wrappers to lock DOM order
      const wrappers = [];
      for (let i=1; i<=doc.numPages; i++){
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.marginBottom = '12px';
        wrap.style.background = '#fff';
        wrap.style.boxShadow = '0 0 0 1px #e5e7eb';
        container.appendChild(wrap);
        wrappers.push(wrap);
      }

      for (let i=1; i<=doc.numPages; i++){
        if (renderTokenRef.current !== token) return; // cancel if outdated
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: scaleVal });

        // PDF bitmap canvas
        const pdfCanvas = document.createElement('canvas');
        const pdfCtx = pdfCanvas.getContext('2d');
        pdfCanvas.width = Math.ceil(viewport.width);
        pdfCanvas.height = Math.ceil(viewport.height);
        pdfCanvas.style.width = `${viewport.width}px`;
        pdfCanvas.style.height = `${viewport.height}px`;
        await page.render({ canvasContext: pdfCtx, viewport }).promise;

        // Overlay brush canvas
        const olCanvas = document.createElement('canvas');
        const olCtx = olCanvas.getContext('2d');
        olCanvas.width = pdfCanvas.width;
        olCanvas.height = pdfCanvas.height;
        olCanvas.style.position = 'absolute';
        olCanvas.style.inset = '0';
        olCanvas.style.width = `${viewport.width}px`;
        olCanvas.style.height = `${viewport.height}px`;
        // Key: blend like a real highlighter so text always shows through
        olCanvas.style.mixBlendMode = 'multiply';

        const wrap = wrappers[i-1];
        wrap.innerHTML = '';
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        wrap.appendChild(pdfCanvas);
        wrap.appendChild(olCanvas);

        overlaysRef.current[i-1] = olCanvas;
        attachBrushHandlers(olCanvas);
      }
    })();
  };

  const updateOverlayCursors = () => {
    Object.values(overlaysRef.current).forEach((c)=>{
      if (c) c.style.cursor = eraserRef.current ? 'not-allowed' : 'crosshair';
    });
  };

  // ===== Brush & Eraser =====
  const attachBrushHandlers = (canvas) => {
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let last = null;

    const getLocal = (evt) => {
      const r = canvas.getBoundingClientRect();
      // account for CSS scaling
      const scaleX = canvas.width / r.width;
      const scaleY = canvas.height / r.height;
      return { x: (evt.clientX - r.left) * scaleX, y: (evt.clientY - r.top) * scaleY };
    };

    const strokeTo = (from, to) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, thickRef.current); // keep a minimum for smoothness
      const alpha = Math.min(opacityRef.current ?? DEFAULT_OPACITY, 0.25); // hard cap to keep text readable
      if (eraserRef.current) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = rgbaCss(colorRef.current, alpha);
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    };

    canvas.onpointerdown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      last = getLocal(e);
    };
    canvas.onpointermove = (e) => {
      if (!drawing || !last) return;
      const p = getLocal(e);
      strokeTo(last, p);
      last = p;
    };
    const stop = () => { drawing = false; last = null; };
    canvas.onpointerup = stop;
    canvas.onpointerleave = stop;
  };

  // ===== Save back to PDF (overlay as transparent PNG per page) =====
  const onSave = async () => {
    if (!pdfBytes) return;
    const pdf = await PDFDocument.load(pdfBytes);

    // Goal: make the exported PDF look exactly like the on-screen preview (multiply blend).
    // Approach: re-render each page with pdf.js to a bitmap, then multiply-composite the
    // brush overlay on top in a temporary canvas, and embed that flattened image.
    // This trades selectable text for perfect visual parity with the preview.

    if (!pdfDoc) {
      // Fallback to previous behavior if pdfDoc is unavailable
      for (let i = 0; i < pdf.getPageCount(); i++) {
        const page = pdf.getPage(i);
        const { width, height } = page.getSize();
        const ol = overlaysRef.current[i];
        if (!ol) continue;
        const dataUrl = ol.toDataURL('image/png');
        const png = await pdf.embedPng(dataUrl);
        page.drawImage(png, { x: 0, y: 0, width, height, opacity: 1 });
      }
    } else {
      for (let i = 0; i < pdf.getPageCount(); i++) {
        const page = pdf.getPage(i);
        const jsPage = await pdfDoc.getPage(i + 1);

        // Determine a viewport scale that matches our overlay canvas size
        const baseViewport = jsPage.getViewport({ scale: 1 });
        const ol = overlaysRef.current[i];
        if (!ol) continue;
        const scale = ol.width / Math.ceil(baseViewport.width || 1);
        const viewport = jsPage.getViewport({ scale: Math.max(0.1, scale) });

        // Render the PDF page bitmap at the chosen scale
        const tmp = document.createElement('canvas');
        tmp.width = Math.ceil(viewport.width);
        tmp.height = Math.ceil(viewport.height);
        const tctx = tmp.getContext('2d');
        await jsPage.render({ canvasContext: tctx, viewport }).promise;

        // Multiply-composite the overlay exactly like the preview
        tctx.globalCompositeOperation = 'multiply';
        // If overlay size differs by a pixel, stretch to fit to avoid seams
        tctx.drawImage(ol, 0, 0, tmp.width, tmp.height);

        // Embed the flattened bitmap
        const dataUrl = tmp.toDataURL('image/png');
        const png = await pdf.embedPng(dataUrl);
        const { width, height } = page.getSize();
        page.drawImage(png, { x: 0, y: 0, width, height, opacity: 1 });
      }
    }

    const out = await pdf.save();
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'annotated.pdf'; a.click();
    URL.revokeObjectURL(url);
  };

  // ===== UI =====
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-3 py-2 flex flex-wrap items-center gap-3">
          <input ref={fileInputRef} type="file" accept="application/pdf" onChange={onOpen} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 rounded border bg-white shadow-sm">Open PDF</button>

          <div className="flex items-center gap-2">
            <button onClick={() => setZoom((z)=>Math.max(0.5, +(z-0.1).toFixed(2)))} className="px-2 py-1 rounded border bg-white">-</button>
            <div className="px-2 text-sm tabular-nums">{zoom.toFixed(2)}x</div>
            <button onClick={() => setZoom((z)=>Math.min(3, +(z+0.1).toFixed(2)))} className="px-2 py-1 rounded border bg-white">+</button>
          </div>

          <div className="flex items-center gap-2">
            {COLORS.map((c) => (
              <button key={c} onClick={() => { setColor(c); setEraser(false); }} title={c}
                className={`w-6 h-6 rounded-full border ${color === c ? 'ring-2 ring-slate-800' : ''}`} style={{ background: c }} />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm">Opacity</span>
            <input type="range" min={0.1} max={0.25} step={0.01} value={Math.min(opacity, 0.25)} onChange={(e)=>setOpacity(parseFloat(e.target.value))} />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm">Thickness</span>
            <input type="range" min={6} max={48} step={1} value={thickness} onChange={(e)=>setThickness(parseInt(e.target.value))} />
            <span className="text-sm w-8 text-center">{thickness}px</span>
          </div>

          <button onClick={()=>setEraser((v)=>!v)} className={`px-3 py-1.5 rounded border ${eraser ? 'bg-rose-50 border-rose-300' : 'bg-white'}`}>{eraser ? 'Eraser: ON' : 'Eraser'}</button>

          <div className="ml-auto">
            <button onClick={onSave} disabled={!pdfBytes} className="px-3 py-1.5 rounded border bg-emerald-600 text-white disabled:opacity-50">Save as PDF</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-3">
        {!pdfDoc && <div className="text-center py-16 text-slate-500">Open a PDF to start highlighting.</div>}
        <div ref={containerRef} className="flex flex-col items-start" style={{ transformOrigin: 'top left', transform: `scale(${zoom})` }} />
      </main>
    </div>
  );
}
