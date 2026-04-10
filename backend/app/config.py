from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FRIDA_IDE_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8765
    unsafe_expose: bool = False  # Set True to bind 0.0.0.0 (with red banner)

    data_dir: Path = Path.home() / ".frida-ide"

    # External tool overrides
    adb_bin: str | None = None
    jadx_bin: str | None = None
    apktool_bin: str | None = None
    claude_bin: str | None = None

    # CORS allowlist for the Vite dev server
    cors_origins: list[str] = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]

    @property
    def db_path(self) -> Path:
        return self.data_dir / "workbench.db"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def frida_server_cache_dir(self) -> Path:
        return self.data_dir / "frida-server-cache"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.projects_dir, self.frida_server_cache_dir, self.logs_dir):
            p.mkdir(parents=True, exist_ok=True)


settings = Settings()
