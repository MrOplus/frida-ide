from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class Script(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    source: str
    tags_json: str = Field(default="[]")
    project_id: int | None = Field(default=None, foreign_key="project.id", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
