from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class AiSession(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    pid: int | None = None
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    status: str = Field(default="starting")  # starting | running | stopped | error


class AiMessage(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    ai_session_id: int = Field(foreign_key="aisession.id", index=True)
    ts: datetime = Field(default_factory=lambda: datetime.now(UTC))
    role: str  # "user" | "assistant" | "tool_use" | "tool_result" | "system"
    content_json: str
