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
const DEFAULT_OPACITY = 0.22; // tuned so text always stays very readable
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
  const renderTokenRef = useRef("");         // cancel stale renders

  // Core state
  const [pdfBytes, setPdfBytes] = useState(null); // pristine bytes for pdf-lib
  const [pdfDoc, setPdfDoc] = useState(null);
  const [baseScale] = useState(1.25);        // base render scale for pdf.js
  const [zoom, setZoom] = useState(1);       // true zoom (pages re-render at this)

  // Tool state
  const [color, setColor] = useState(COLORS[0]);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS);
  const [eraser, setEraser] = useState(false);

  // Live refs for handlers (avoid stale closures)
  const colorRef = useRef(color);
  const opacityRef = useRef(opacity);
  const thickRef = useRef(thickness);
  const eraserRef = useRef(eraser);

  // ✨ Keep refs in sync with state (this was missing, causing your issue)
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { opacityRef.current = opacity; }, [opacity]);
  useEffect(() => { thickRef.current = thickness; }, [thickness]);
  useEffect(() => { 
    eraserRef.current = eraser; 
    updateOverlayCursors(); 
  }, [eraser]);

  // ===== File open =====
  const onOpen = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const libBytes = bytes.slice();      // keep pristine for pdf-lib
    const viewerBytes = bytes.slice();   // give this to pdf.js (worker may transfer/detach)
    setPdfBytes(libBytes);

    const loading = pdfjsLib.getDocument({ data: viewerBytes });
    const doc = await loading.promise;
    setPdfDoc(doc);
    setTimeout(() => renderAll(doc, baseScale * zoom), 0);
  };

  // Re-render pages at true zoom (crisp quality)
  useEffect(()=>{ 
    if (pdfDoc) renderAll(pdfDoc, baseScale * zoom); 
  }, [pdfDoc, baseScale, zoom]);

  // ===== Render all pages (bitmap + overlay brush) =====
  const renderAll = (doc, scaleVal) => {
    const container = containerRef.current;
    if (!container) return;

    // Keep previous overlays so we can scale strokes into the new size
    const prevOverlays = overlaysRef.current;

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

        // PDF bitmap canvas (HiDPI)
        const pdfCanvas = document.createElement('canvas');
        const pdfCtx = pdfCanvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        pdfCanvas.width = Math.ceil(viewport.width * dpr);
        pdfCanvas.height = Math.ceil(viewport.height * dpr);
        pdfCanvas.style.width = `${viewport.width}px`;
        pdfCanvas.style.height = `${viewport.height}px`;
        pdfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: pdfCtx, viewport }).promise;

        // Overlay brush canvas (HiDPI to match PDF)
        const olCanvas = document.createElement('canvas');
        const dpr2 = window.devicePixelRatio || 1;
        olCanvas.width = Math.ceil(viewport.width * dpr2);
        olCanvas.height = Math.ceil(viewport.height * dpr2);
        olCanvas.style.position = 'absolute';
        olCanvas.style.inset = '0';
        olCanvas.style.width = `${viewport.width}px`;
        olCanvas.style.height = `${viewport.height}px`;
        olCanvas.style.mixBlendMode = 'multiply';
        olCanvas.style.touchAction = 'none';        // prevent touch scrolling while drawing
        const olCtx = olCanvas.getContext('2d');

        const wrap = wrappers[i-1];
        wrap.innerHTML = '';
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        wrap.appendChild(pdfCanvas);
        wrap.appendChild(olCanvas);

        // Preserve existing strokes by scaling previous overlay into the new size
        const prev = prevOverlays[i-1];
        if (prev && prev.width && prev.height) {
          try { 
            olCtx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, olCanvas.width, olCanvas.height); 
          } catch(_) {}
        }

        overlaysRef.current[i-1] = olCanvas;
        attachBrushHandlers(olCanvas);
        // ensure cursor reflects current tool state
        olCanvas.style.cursor = eraserRef.current ? 'not-allowed' : 'crosshair';
      }
    })();
  };

  const updateOverlayCursors = () => {
    Object.values(overlaysRef.current).forEach((c)=>{
      if (!c) return;
      c.style.cursor = eraserRef.current ? 'not-allowed' : 'crosshair';
    });
  };

  // ===== Brush & Eraser (uniform thickness, live tool state) =====
  const attachBrushHandlers = (canvas) => {
    // prevent context-menu from interrupting pointer capture
    canvas.oncontextmenu = (e) => e.preventDefault();

    const ctx = canvas.getContext('2d');
    let drawing = false;
    let last = null;

    const getLocal = (evt) => {
      const r = canvas.getBoundingClientRect();
      // account for CSS size vs canvas pixel size
      const scaleX = canvas.width / r.width;
      const scaleY = canvas.height / r.height;
      return { 
        x: (evt.clientX - r.left) * scaleX, 
        y: (evt.clientY - r.top) * scaleY,
        scaleX
      };
    };

    const strokeTo = (from, to) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Keep visual thickness constant in CSS px
      const pixelRatio = to.scaleX || (window.devicePixelRatio || 1);
      ctx.lineWidth = Math.max(2, thickRef.current * pixelRatio);

      // **Read latest tool state on every segment** so color/eraser changes apply instantly
      const isErasing = !!eraserRef.current;
      const alpha = Math.min(opacityRef.current ?? DEFAULT_OPACITY, 0.25); // cap for readability
      ctx.globalCompositeOperation = isErasing ? 'destination-out' : 'source-over';
      ctx.strokeStyle = isErasing ? 'rgba(0,0,0,1)' : rgbaCss(colorRef.current, alpha);

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

  // ===== Save back to PDF (preview-perfect composite) =====
  const onSave = async () => {
    if (!pdfBytes || !pdfDoc) return;
    const pdf = await PDFDocument.load(pdfBytes);

    // Re-render each page with pdf.js at current overlay size, multiply the overlay,
    // and embed the flattened bitmap -> exported PDF matches the preview.
    for (let i = 0; i < pdf.getPageCount(); i++) {
      const page = pdf.getPage(i);
      const jsPage = await pdfDoc.getPage(i + 1);

      // Render page bitmap at a scale matching the current overlay size
      const baseViewport = jsPage.getViewport({ scale: 1 });
      const ol = overlaysRef.current[i];
      if (!ol) continue;

      const scale = ol.width / Math.max(1, Math.ceil(baseViewport.width));
      const viewport = jsPage.getViewport({ scale: Math.max(0.1, scale) });

      const tmp = document.createElement("canvas");
      tmp.width = Math.ceil(viewport.width);
      tmp.height = Math.ceil(viewport.height);
      const tctx = tmp.getContext("2d");
      await jsPage.render({ canvasContext: tctx, viewport }).promise;

      // Multiply-composite overlay exactly like the preview
      tctx.globalCompositeOperation = "multiply";
      // If overlay size differs by a pixel, stretch to fit to avoid seams
      tctx.drawImage(ol, 0, 0, tmp.width, tmp.height);

      // Embed the flattened bitmap
      const dataUrl = tmp.toDataURL("image/png");
      const png = await pdf.embedPng(dataUrl);
      const { width, height } = page.getSize();
      page.drawImage(png, { x: 0, y: 0, width, height, opacity: 1 });
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
            <button onClick={() => setZoom((z)=>Math.min(4, +(z+0.1).toFixed(2)))} className="px-2 py-1 rounded border bg-white">+</button>
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

      <main className="max-w-6xl mx-auto p-3" style={{ overflowX: 'auto' }}>
        {!pdfDoc && <div className="text-center py-16 text-slate-500">Open a PDF to start highlighting.</div>}
        <div style={{ minWidth: 'fit-content' }}>
          <div ref={containerRef} className="flex flex-col items-start" style={{ display: 'inline-block' }} />
        </div>
      </main>
    </div>
  );
}
