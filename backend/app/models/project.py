from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class Project(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    package_name: str | None = None
    version_name: str | None = None
    version_code: int | None = None
    sha256: str | None = None
    path: str  # ~/.frida-ide/projects/<name>/
    status: str = Field(default="queued")  # queued | apktool | jadx | done | error
    error_message: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    meta_json: str = Field(default="{}")  # permissions, signing info, manifest excerpt
