"""Unified domain & HTTP errors strictly matching contracts/openapi.json."""
from __future__ import annotations


class AppError(Exception):
    """Structured error mapped to {"error": {"code", "message", "retryable"}}."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = (status_code >= 500 or status_code == 429) if retryable is None else retryable

    def to_payload(self) -> dict[str, dict[str, object]]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.retryable,
            }
        }


def unauthorized_error(message: str = "Нет доступа к заказу.") -> AppError:
    return AppError(401, "UNAUTHORIZED", message, retryable=False)


def not_found_error(message: str = "Запрашиваемый объект не найден.") -> AppError:
    return AppError(404, "NOT_FOUND", message, retryable=False)


def seat_unavailable_error(message: str = "Это место уже заняли. Выберите другое.") -> AppError:
    return AppError(409, "SEAT_UNAVAILABLE", message, retryable=False)


def idempotency_conflict_error(
    message: str = "Ключ идемпотентности уже использован с другими параметрами заказа.",
) -> AppError:
    return AppError(409, "IDEMPOTENCY_CONFLICT", message, retryable=False)


def ticket_not_ready_error(message: str = "Оплата ещё не подтверждена. Билет пока не выпущен.") -> AppError:
    return AppError(409, "TICKET_NOT_READY", message, retryable=False)


def session_started_error(message: str = "Матч уже начался. Выберите другой матч.") -> AppError:
    return AppError(409, "SESSION_STARTED", message, retryable=False)


def order_state_conflict_error(message: str = "Операция недоступна в текущем статусе заказа.") -> AppError:
    return AppError(409, "ORDER_STATE_CONFLICT", message, retryable=False)


def validation_error(message: str = "Проверьте корректность введённых данных.") -> AppError:
    return AppError(422, "VALIDATION_ERROR", message, retryable=False)


def rate_limited_error(
    message: str = "Слишком много запросов. Подождите несколько секунд и повторите с тем же ключом.",
) -> AppError:
    return AppError(429, "RATE_LIMITED", message, retryable=True)


def payment_unavailable_error(
    message: str = "Платёжный сервис временно недоступен. Повторите попытку немного позже.",
    *,
    status_code: int = 503,
) -> AppError:
    return AppError(status_code, "PAYMENT_UNAVAILABLE", message, retryable=True)
