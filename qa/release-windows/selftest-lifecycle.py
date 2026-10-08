"""Run small-file lifecycle admission checks without installing the application."""
from pathlib import Path
import runpy


if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("verify-installed-tree.py")))["self_test"]()
