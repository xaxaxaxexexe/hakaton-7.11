"""Dev-only Sandbox SBP UI & confirmation endpoints (`/__mock/*`).

NEVER registered when `PAYMENT_PROVIDER=platega` or `APP_ENV=production`.
Exercises the real database reconciliation & ticket issuance flow locally without real charges.
"""
from __future__ import annotations

import html
from urllib.parse import parse_qs, urlencode

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.dependencies import AppContainer, extract_bearer_token, get_container
from app.domain.enums import ProviderPaymentStatus
from app.domain.models import Order
from app.errors import not_found_error, unauthorized_error
from app.providers.sandbox import SandboxPaymentProvider

sandbox_router = APIRouter(prefix="/__mock", tags=["Local Sandbox"])


def _verify_sandbox_access(container: AppContainer, order_id: str, token: str | None) -> None:
    if not token:
        raise unauthorized_error("Отсутствует токен доступа к заказу в песочнице.")
    rec = container.booking_repo.get_order_record(order_id)
    if rec is None:
        raise not_found_error("Заказ не найден.")
    if not container.token_manager.verify_order_access_token(order_id, rec.token_nonce, token):
        raise unauthorized_error("Неверный токен заказа в песочнице.")


@sandbox_router.get("/pay/{order_id}", response_class=HTMLResponse)
async def render_sandbox_payment_page(
    order_id: str,
    token: str = Query(default=""),
    container: AppContainer = Depends(get_container),
) -> HTMLResponse:
    _verify_sandbox_access(container, order_id, token)
    rec = container.booking_repo.get_order_record(order_id)
    assert rec is not None
    order = rec.order
    rub_str = f"{order.total_minor // 100} ₽"
    esc_order_id = html.escape(order.id)
    esc_short = html.escape(order.id[:8].upper())
    esc_token = html.escape(token)
    return_unpaid = html.escape(
        f"{container.settings.public_app_url}/payment/return?"
        + urlencode({"order": order.id, "paid": "1"})
    )

    page = f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>СБП Демо-шлюз · SEKTOR</title>
  <style>
    :root {{ color-scheme: dark; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      background: radial-gradient(circle at top, #231f1a 0%, #151511 65%);
      color: #F6F3E9; font-family: system-ui, -apple-system, sans-serif;
    }}
    .card {{
      width: min(460px, 100%); background: #1d1c17; border: 1px solid rgba(246, 243, 233, 0.14);
      border-radius: 20px; padding: 28px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    }}
    .badge {{
      display: inline-flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em;
      text-transform: uppercase; color: #f7b955; background: rgba(247, 185, 85, 0.12);
      padding: 6px 10px; border-radius: 999px; margin-bottom: 16px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 24px; font-weight: 600; }}
    p {{ margin: 0 0 20px; color: rgba(246, 243, 233, 0.72); line-height: 1.5; font-size: 14px; }}
    .meta {{
      background: rgba(255, 255, 255, 0.04); border-radius: 14px; padding: 16px; margin-bottom: 20px;
      display: flex; justify-content: space-between; align-items: baseline;
    }}
    .meta span {{ font-size: 13px; color: rgba(246, 243, 233, 0.65); }}
    .meta strong {{ font-size: 26px; color: #F6F3E9; }}
    form {{ display: grid; gap: 10px; }}
    button, .ghost-link {{
      width: 100%; border-radius: 12px; padding: 14px 16px; font-size: 15px; font-weight: 600;
      cursor: pointer; border: none; text-align: center; text-decoration: none; transition: opacity .15s;
    }}
    button:hover, .ghost-link:hover {{ opacity: 0.92; }}
    .btn-pay {{ background: #FF4F1F; color: #fff; }}
    .btn-cancel {{ background: rgba(246, 243, 233, 0.1); color: #F6F3E9; }}
    .ghost-link {{
      display: block; margin-top: 10px; font-size: 13px; font-weight: 500;
      background: transparent; border: 1px dashed rgba(246, 243, 233, 0.22); color: rgba(246, 243, 233, 0.78);
    }}
  </style>
</head>
<body>
  <main class="card">
    <div class="badge">Демо-режим СБП · деньги не списываются</div>
    <h1>Оплата заказа № {esc_short}</h1>
    <p>Локальная песочница имитирует ответ платёжного провайдера. Сервер проверит статус транзакции и выпустит настоящий билет в SQLite.</p>
    <div class="meta">
      <span>К оплате без комиссии</span>
      <strong>{rub_str}</strong>
    </div>
    <form method="post" action="/__mock/pay/{esc_order_id}">
      <input type="hidden" name="token" value="{esc_token}">
      <button class="btn-pay" type="submit" name="outcome" value="CONFIRMED">Подтвердить оплату СБП</button>
      <button class="btn-cancel" type="submit" name="outcome" value="CANCELED">Отменить платёж в банке</button>
    </form>
    <a class="ghost-link" href="{return_unpaid}">Вернуться без оплаты (проверка защиты ?paid=1)</a>
  </main>
</body>
</html>"""
    return HTMLResponse(
        content=page,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@sandbox_router.post("/pay/{order_id}")
async def submit_sandbox_payment_form(
    order_id: str,
    request: Request,
    container: AppContainer = Depends(get_container),
) -> RedirectResponse:
    raw_form = (await request.body()).decode("utf-8", errors="replace")
    parsed_form = parse_qs(raw_form, keep_blank_values=True)
    token = (parsed_form.get("token") or [""])[0]
    outcome = (parsed_form.get("outcome") or ["CONFIRMED"])[0]
    _verify_sandbox_access(container, order_id, token)
    if not isinstance(container.provider, SandboxPaymentProvider):
        raise not_found_error("Песочница отключена.")

    target_status = (
        ProviderPaymentStatus.CANCELED
        if outcome.strip().upper() == "CANCELED"
        else ProviderPaymentStatus.CONFIRMED
    )
    container.provider.set_order_transaction_status(order_id, target_status)
    rec = container.booking_repo.get_order_record(order_id)
    if rec is not None:
        await container.payment_service.reconcile_order(rec, force=True)

    return_url = f"{container.settings.public_app_url}/payment/return?" + urlencode({"order": order_id})
    return RedirectResponse(
        url=return_url,
        status_code=303,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@sandbox_router.post("/orders/{order_id}/confirm", response_model=Order)
async def confirm_sandbox_order_api(
    order_id: str,
    request: Request,
    container: AppContainer = Depends(get_container),
) -> Order:
    token = extract_bearer_token(request)
    _verify_sandbox_access(container, order_id, token)
    if not isinstance(container.provider, SandboxPaymentProvider):
        raise not_found_error("Песочница отключена.")

    container.provider.set_order_transaction_status(order_id, ProviderPaymentStatus.CONFIRMED)
    rec = container.booking_repo.get_order_record(order_id)
    assert rec is not None
    updated = await container.payment_service.reconcile_order(rec, force=True)
    return updated.order
