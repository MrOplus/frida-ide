from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from .config import settings

# WAL mode for concurrent reads while a writer is active
_engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    settings.ensure_dirs()
    # Models import via app.models to register tables before create_all
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(_engine)
    # Enable WAL after creation
    with _engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL")
        conn.exec_driver_sql("PRAGMA synchronous=NORMAL")


def get_session() -> Iterator[Session]:
    with Session(_engine) as session:
        yield session


def engine():
    return _engine
