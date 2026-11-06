import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders a connector URI as a scannable code.
 *
 * Drawn to a data URL rather than a canvas so it can be sized by CSS and does
 * not need a ref dance. Error correction is set to M: the URI is long, and a
 * higher level would make the modules too dense to scan comfortably from a
 * laptop screen.
 */
export function QrCode({ value, size = 208 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    void QRCode.toDataURL(value, {
      width: size * 2,
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0c', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center' }}>
        Could not render the QR code. Use the link below instead.
      </div>
    );
  }

  if (dataUrl === null) {
    return <div style={{ width: size, height: size, background: 'var(--surface-raised)' }} />;
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="Scan this with World App to verify"
      style={{ display: 'block' }}
    />
  );
}
