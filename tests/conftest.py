import pytest
from app.config import settings


def pytest_configure(config):
    """Prevent automated pytest runs from sending live carrier SMS messages."""
    settings.MOCK_MODE = True
