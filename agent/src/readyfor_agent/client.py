"""Contract-neutral HTTP boundary for the ReadyFor core service.

Route names and payload models belong in this module once docs/contract.md is
available. Keep them out of the uAgent message handler.
"""

from typing import Any
from urllib.parse import urljoin

import httpx


class CoreClientNotConfigured(RuntimeError):
    """Raised when the core API URL or its agreed contract is unavailable."""


class ReadyForCoreClient:
    def __init__(self, base_url: str | None, timeout_seconds: float = 5) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
        self._timeout_seconds = timeout_seconds

    @property
    def is_configured(self) -> bool:
        """Whether a base URL is set; route-level integration may still be pending."""
        return self._base_url is not None

    async def request_json(
        self,
        method: str,
        documented_path: str,
        *,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Call a path explicitly supplied by contract-backed code.

        This generic transport deliberately contains no guessed ReadyFor routes
        or schemas. Callers must use paths and JSON defined by the shared contract.
        """
        if not self._base_url:
            raise CoreClientNotConfigured(
                "READYFOR_CORE_URL is unset; configure the core after its contract is published."
            )
        if not documented_path.startswith("/"):
            raise ValueError("documented_path must be an absolute API path.")

        url = urljoin(f"{self._base_url}/", documented_path.lstrip("/"))
        async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
            response = await client.request(method, url, json=payload)
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            raise ValueError("ReadyFor core response must be a JSON object.")
        return data
