"""HTTP client for the ReadyFor routes documented in docs/contract.md."""

from typing import Any
from urllib.parse import urljoin

import httpx


class CoreClientNotConfigured(RuntimeError):
    """Raised when the core API base URL has not been configured."""


class ReadyForCoreClient:
    def __init__(self, base_url: str | None, timeout_seconds: float = 5) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
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
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Call a documented route and surface core error messages clearly."""
        if not self._base_url:
            raise CoreClientNotConfigured(
                "READYFOR_CORE_URL is unset; point the agent to the ReadyFor core service."
            )
        if not path.startswith("/"):
            raise ValueError("path must be an absolute API path.")

        url = urljoin(f"{self._base_url}/", path.lstrip("/"))
        async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
            response = await client.request(method, url, json=payload)
            if not response.is_success:
                try:
                    error = response.json().get("error", {}).get("message")
                except (ValueError, AttributeError):
                    error = None
                if error:
                    raise RuntimeError(error)
                response.raise_for_status()
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            raise ValueError("ReadyFor core response must be a JSON object.")
        return data

    async def list_surgeries(self) -> list[dict[str, Any]]:
        result = await self.request_json("GET", "/surgeries")
        surgeries = result.get("surgeries")
        if not isinstance(surgeries, list):
            raise ValueError("Core GET /surgeries response is missing its surgeries array.")
        return surgeries

    async def surgery_brief(self, surgery_id: str) -> str:
        result = await self.request_json("GET", f"/surgeries/{surgery_id}/brief")
        brief = result.get("text")
        if not isinstance(brief, str):
            raise ValueError("Core surgery brief response is missing text.")
        return brief

    async def surgery_detail(self, surgery_id: str) -> dict[str, Any]:
        return await self.request_json("GET", f"/surgeries/{surgery_id}")

    async def create_task(self, surgery_id: str, title: str, owner: str, detail: str) -> dict[str, Any]:
        return await self.request_json(
            "POST",
            "/tasks",
            payload={
                "surgeryId": surgery_id,
                "title": title,
                "owner": owner,
                "detail": detail,
                "actor": "agent",
                "origin": "agent",
            },
        )

    async def verify_requirement(self, requirement_id: str) -> dict[str, Any]:
        return await self.request_json(
            "POST",
            f"/requirements/{requirement_id}/actions",
            payload={"action": "verify", "actor": "coordinator:ASI:One"},
        )
