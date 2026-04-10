from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class Snippet(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    source: str
    tags_json: str = Field(default="[]")
    parameters_json: str = Field(default="[]")  # list of {name, default, description}
    builtin: bool = Field(default=False, index=True)
    description: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
