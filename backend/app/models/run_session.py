from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class RunSession(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    device_serial: str = Field(index=True)
    target_identifier: str | None = None  # package name for spawn
    pid: int | None = None
    script_id: int | None = Field(default=None, foreign_key="script.id", index=True)
    mode: str  # "spawn" | "attach"
    status: str = Field(default="starting")  # starting | running | stopped | error
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    error_message: str | None = None
