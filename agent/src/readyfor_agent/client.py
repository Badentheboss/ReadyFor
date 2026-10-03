"""HTTP client for the ReadyFor routes documented in docs/contract.md."""

from typing import Any
from urllib.parse import urljoin

import httpx


class CoreClientNotConfigured(RuntimeError):
    """Raised when the core API base URL has not been configured."""


class ReadyForCoreError(RuntimeError):
    """A core rejection, including the status needed to explain denied access."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        label = "Access denied" if status_code == 403 else "Core request failed"
        super().__init__(f"{label} ({status_code}): {message}")


def validate_service_token(token: str | None) -> str:
    if (
        not isinstance(token, str)
        or len(token) < 32
        or any(ord(c) < 33 or ord(c) > 126 for c in token)
    ):
        raise ValueError(
            "AGENT_SERVICE_TOKEN must contain at least 32 non-whitespace ASCII characters."
        )
    return token


class ReadyForCoreClient:
    def __init__(
        self, base_url: str | None, service_token: str | None, timeout_seconds: float = 5
    ) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
        self._service_token = validate_service_token(service_token)
        self._timeout_seconds = timeout_seconds

    @property
    def is_configured(self) -> bool:
        """Whether the core service base URL is configured."""
        return self._base_url is not None

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        sender: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Call a documented route and surface core error messages clearly."""
        if (
            not isinstance(sender, str)
            or not sender
            or any(ord(c) < 33 or ord(c) > 126 for c in sender)
        ):
            raise ValueError("An ASI:One sender address is required for every core request.")
        if not self._base_url:
            raise CoreClientNotConfigured(
                "READYFOR_CORE_URL is unset; point the agent to the ReadyFor core service."
            )
        if not path.startswith("/"):
            raise ValueError("path must be an absolute API path.")

        url = urljoin(f"{self._base_url}/", path.lstrip("/"))
        async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
            # Sender is request-local: overlapping chats must never share identity state.
            response = await client.request(
                method,
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self._service_token}",
                    "X-ReadyFor-Sender": sender,
                },
            )
            if not response.is_success:
                try:
                    error = response.json().get("error", {}).get("message")
                except (ValueError, AttributeError):
                    error = None
                raise ReadyForCoreError(
                    response.status_code, str(error or response.reason_phrase)
                )
            data = response.json()
        if not isinstance(data, dict):
            raise ValueError("ReadyFor core response must be a JSON object.")
        return data

    async def list_surgeries(self, *, sender: str) -> list[dict[str, Any]]:
        result = await self.request_json("GET", "/surgeries", sender=sender)
        surgeries = result.get("surgeries")
        if not isinstance(surgeries, list):
            raise ValueError("Core GET /surgeries response is missing its surgeries array.")
        return surgeries

    async def surgery_brief(self, surgery_id: str, *, sender: str) -> str:
        result = await self.request_json(
            "GET", f"/surgeries/{surgery_id}/brief", sender=sender
        )
        brief = result.get("text")
        if not isinstance(brief, str):
            raise ValueError("Core surgery brief response is missing text.")
        return brief

    async def surgery_detail(self, surgery_id: str, *, sender: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/surgeries/{surgery_id}", sender=sender)

    async def create_task(
        self, surgery_id: str, title: str, owner: str, detail: str, *, sender: str
    ) -> dict[str, Any]:
        return await self.request_json(
            "POST",
            "/tasks",
            sender=sender,
            payload={
                "surgeryId": surgery_id,
                "title": title,
                "owner": owner,
                "detail": detail,
                "origin": "agent",
            },
        )

    async def verify_requirement(self, requirement_id: str, *, sender: str) -> dict[str, Any]:
        return await self.request_json(
            "POST",
            f"/requirements/{requirement_id}/actions",
            sender=sender,
            payload={"action": "verify"},
        )
