// 文件详情里的 PDF 阅读：逐页铺开、随弹窗宽度缩放、文字可选。react-pdf 与 pdf.js 只在打开 PDF 时按需加载
import 'react-pdf/dist/Page/TextLayer.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

// 与 files.ts 生成缩略图用同一份 pdf.js 与 worker
pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;

/** 打开 PDF 后在应用内阅读；读不出来时显示 fallback（首页缩略图 + 在新标签页打开） */
export default function PdfView({ url, placeholder, fallback }: { url: string; placeholder: ReactNode; fallback: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [failed]);
  if (failed) return fallback;
  return (
    <div ref={box} className="fp-pdf">
      <Document
        file={url}
        loading={placeholder}
        error={placeholder}
        onLoadSuccess={(doc) => setPages(doc.numPages)}
        onLoadError={() => setFailed(true)}
        onSourceError={() => setFailed(true)}
      >
        {width > 0 &&
          Array.from({ length: pages }, (_, i) => (
            <Page
              key={i}
              pageNumber={i + 1}
              width={width}
              className="fp-page"
              renderAnnotationLayer={false}
              loading={<div className="fp-page-loading" />}
              error={<div className="fp-page-loading" />}
            />
          ))}
      </Document>
    </div>
  );
}
