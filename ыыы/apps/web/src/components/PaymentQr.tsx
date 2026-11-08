import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download, LoaderCircle } from 'lucide-react';
import type { PaymentQrTarget } from '../lib/paymentQr';

export default function PaymentQr({ target }: { target: PaymentQrTarget | null }) {
  const url = target?.url ?? null;
  const bankQr = target?.kind === 'sbp';
  const [image, setImage] = useState<{ url: string; data: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setImage(null); setFailed(false);
    if (url) QRCode.toDataURL(url, { width: 768, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#101014', light: '#ffffff' } })
      .then(data => { if (alive) setImage({ url, data }); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [url]);
  const ready = image?.url === url ? image : null;
  return <div className="payment-qr" data-qr-kind={target?.kind}>
    <div className="payment-qr-code">
      {ready ? <img src={ready.data} width="256" height="256" alt={bankQr ? 'QR-код СБП для оплаты этого заказа' : 'QR-код платёжной формы Platega для этого заказа'} /> :
        <div className="payment-qr-wait" role="status">{url && !failed && <LoaderCircle className="checkout-spin" size={28} aria-hidden="true" />}<span>{failed ? 'Не удалось показать QR' : url ? 'Готовим QR-код' : 'QR пока недоступен'}</span></div>}
    </div>
    <p>{ready ? bankQr ? 'Отсканируйте в приложении банка. После оплаты билет появится здесь автоматически.' : 'Наведите камеру телефона: откроется форма Platega, где можно оплатить через СБП. Оставьте эту страницу открытой — билет появится здесь после подтверждения.' : 'Откройте платёжную форму по ссылке ниже. Эта страница продолжит проверять оплату.'}</p>
    {ready && <a className="payment-qr-save" href={ready.data} download="zal-payment-qr.png"><Download size={15} aria-hidden="true" />{bankQr ? 'Сохранить QR для приложения банка' : 'Сохранить QR оплаты'}</a>}
  </div>;
}
