'use client';

import { useEffect, useRef, useState } from 'react';
import { ScanBarcode } from 'lucide-react';
import { Button, Dialog, Input } from './ui';

/**
 * Lector de códigos de barras con la cámara del móvil. Usa la API nativa
 * BarcodeDetector cuando existe (Chrome Android) y, si no, @zxing/browser.
 * Siempre ofrece escribir el código a mano (cámara denegada, sin HTTPS, etc.).
 * Móntalo solo mientras está abierto ({open && <BarcodeScanner …/>}) para reiniciar su estado.
 */
interface Detector { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: new (o?: { formats: string[] }) => Detector }
}

export function BarcodeScanner({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stop: () => void = () => undefined;
    const done = (code: string) => {
      if (stopped) return;
      stopped = true;
      stop();
      onDetected(code.trim());
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este navegador no permite usar la cámara (se necesita HTTPS). Escribe el código.');
        return;
      }
      try {
        if (window.BarcodeDetector) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          stop = () => stream.getTracks().forEach((t) => t.stop());
          if (stopped) return stop();
          const v = video.current!;
          v.srcObject = stream;
          await v.play();
          const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
          const tick = async () => {
            if (stopped) return;
            const r = await det.detect(v).catch(() => []);
            if (r[0]?.rawValue) done(r[0].rawValue);
            else setTimeout(tick, 250);
          };
          tick();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const controls = await new BrowserMultiFormatReader().decodeFromConstraints({ video: { facingMode: 'environment' } }, video.current!, (res) => {
            if (res) done(res.getText());
          });
          stop = () => controls.stop();
          if (stopped) stop();
        }
      } catch (e) {
        setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Escribe el código.' : 'No se pudo abrir la cámara. Escribe el código.');
      }
    })();
    return () => {
      stopped = true;
      stop();
    };
  }, [open, onDetected]);

  return (
    <Dialog open={open} onClose={onClose} title="Escanear código de barras">
      <div className="flex flex-col gap-3">
        {!error && <video ref={video} className="aspect-video w-full rounded-lg bg-black object-cover" muted playsInline />}
        {error && <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">{error}</p>}
        {/* Sin <form>: el lector se usa dentro de otros formularios y no se pueden anidar */}
        <div className="flex gap-2">
          <Input
            placeholder="O escribe el código"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (manual.trim()) onDetected(manual.trim());
              }
            }}
            inputMode="numeric"
            aria-label="Código de barras"
          />
          <Button type="button" variant="secondary" onClick={() => manual.trim() && onDetected(manual.trim())}>Buscar</Button>
        </div>
      </div>
    </Dialog>
  );
}

export const ScanIcon = ScanBarcode;
