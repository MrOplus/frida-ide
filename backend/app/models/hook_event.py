from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class HookEvent(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    run_session_id: int = Field(foreign_key="runsession.id", index=True)
    ts: datetime = Field(default_factory=lambda: datetime.now(UTC), index=True)
    kind: str  # "send" | "error" | "log" | "stdout" | "stderr"
    payload_json: str  # serialized message payload
