---
doc_id: TS-ENV-002
title: Python Development Environment Setup
domain: tech-support
version: 3.4
status: active
effective_date: 2026-02-01
access: students-and-staff
campus_scope: all
format: md
---

# Python Development Environment Setup

This guide is for students of the Python and AI Engineering Bootcamp.

## 1. Required versions

| Tool | Version |
|---|---|
| Python | 3.12 |
| Package manager | uv (recommended) or pip with venv |
| Editor | Visual Studio Code with the Python and Jupyter extensions |
| Git | 2.40 or newer |

## 2. Install Python 3.12

1. Download Python 3.12 from the course portal (Tools > Python) or python.org.
2. On Windows, tick "Add python.exe to PATH" in the installer.
3. Open a new terminal and run `python --version`. It must print 3.12.x.

## 3. Create a virtual environment for each project

Never install packages into the global Python. For every project run:

```
python -m venv .venv
source .venv/bin/activate        # macOS and Linux
.venv\Scripts\activate           # Windows
```

With uv the same is `uv venv` followed by `uv pip install -r requirements.txt`.

## 4. Use the campus package mirror

Create `~/.pip/pip.conf` (macOS and Linux) or `%APPDATA%\pip\pip.ini` (Windows):

```
[global]
index-url = https://pypi.starit.example/simple
trusted-host = pypi.starit.example
```

The mirror carries all packages used in the course, including numpy, pandas, scikit-learn, FastAPI and PyTorch (CPU build).

## 5. Jupyter

Install the extension "Jupyter" in VS Code, then run `pip install ipykernel` in your virtual environment. Select the `.venv` interpreter at the top right of a notebook.

## 6. API keys for AI modules

In the AI modules you receive a class API key for language models. Store it in a `.env` file in the project folder and add `.env` to `.gitignore`. Never commit keys to Git. A leaked key is revoked and the student must report the incident to the instructor.

## 7. Verify

Clone `https://git.starit.example/python/env-check.git`, create a virtual environment, install the requirements and run `pytest`. All tests must pass.
