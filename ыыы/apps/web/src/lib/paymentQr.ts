export interface PaymentQrTarget { url: string; kind: 'sbp' | 'payment-link' }

function safeUrl(value: string | null | undefined, host: string): string | null {
  if (!value || value.length > 2048 || /[\s\x00-\x1f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === host && !url.username &&
      !url.password && !url.port && !url.hash && url.pathname.length > 1 ? value : null;
  } catch { return null; }
}

/** A form QR is explicitly labelled as such; only NSPK URIs are bank payment codes. */
export function paymentQrTarget(bankUrl: string | null | undefined, formUrl: string | null | undefined): PaymentQrTarget | null {
  const bank = safeUrl(bankUrl, 'qr.nspk.ru');
  if (bank) return { url: bank, kind: 'sbp' };
  const form = safeUrl(formUrl, 'pay.platega.io');
  return form ? { url: form, kind: 'payment-link' } : null;
}
