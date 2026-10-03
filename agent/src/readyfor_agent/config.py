"""Environment-backed configuration for the coordinator agent."""

from dataclasses import dataclass, field
import os

from dotenv import load_dotenv
from readyfor_agent.client import validate_service_token


@dataclass(frozen=True)
class Settings:
    seed: str
    name: str
    port: int
    core_url: str | None
    core_timeout_seconds: float
    service_token: str = field(repr=False)


def load_settings() -> Settings:
    """Load local .env values and validate required runtime configuration."""
    load_dotenv()
    seed = os.getenv("UAGENT_SEED", "").strip()
    if not seed or seed == "replace-with-a-long-random-private-seed":
        raise ValueError(
            "Set UAGENT_SEED to a private, stable seed phrase in agent/.env."
        )

    try:
        port = int(os.getenv("UAGENT_PORT", "8000"))
        timeout = float(os.getenv("READYFOR_CORE_TIMEOUT_SECONDS", "5"))
    except ValueError as exc:
        raise ValueError("UAGENT_PORT and core timeout must be numeric.") from exc
    if not 1 <= port <= 65535:
        raise ValueError("UAGENT_PORT must be between 1 and 65535.")
    if timeout <= 0:
        raise ValueError("READYFOR_CORE_TIMEOUT_SECONDS must be greater than zero.")

    core_url = os.getenv("READYFOR_CORE_URL", "").strip().rstrip("/") or None
    service_token = validate_service_token(os.getenv("AGENT_SERVICE_TOKEN"))
    return Settings(
        seed=seed,
        name=os.getenv("UAGENT_NAME", "readyfor-coordinator").strip(),
        port=port,
        core_url=core_url,
        core_timeout_seconds=timeout,
        service_token=service_token,
    )
