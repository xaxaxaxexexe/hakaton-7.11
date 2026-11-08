export const money = (amount: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
export const sessionDate = (iso: string, timezone = 'Europe/Moscow') => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(new Date(iso));
export const sessionTime = (iso: string, timezone = 'Europe/Moscow') => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(iso));
export const seatLabel = (row: number, number: number, type = 'standard') => 'Ряд ' + row + ' · ' + (type === 'sofa' ? 'ложа ' : 'место ') + number;
