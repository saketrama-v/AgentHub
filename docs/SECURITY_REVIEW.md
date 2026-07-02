# Security Review Report — AgentHub Studio

**Date:** July 2, 2026
**Agent Role:** Security Agent

This document outlines the security vulnerabilities discovered during the pre-production audit of the AgentHub Studio codebase.

> [!CAUTION]
> Critical and High severity findings are **Blockers**. The application must not be deployed to a production environment until these are resolved.

---

## 🛑 [CRITICAL] Broken Authentication & Authorization (Backend)

**Location:** `backend/server.py`
**Description:** The FastAPI backend does not implement any authentication middleware or dependency injection. While the frontend uses Clerk (`<SignedIn>`) to restrict UI access, the backend API endpoints (`/api/kickoff`, `/api/sessions`, `/api/sessions/{session_id}/read`, etc.) are entirely unprotected.
**Impact:**
- An attacker can bypass the frontend UI and directly query the backend to list, read, or maliciously delete other users' workspaces and source code files.
- An attacker can hit the `/api/kickoff` endpoint directly and spin up expensive AI workloads on the server.
**Remediation:**
- Implement a Clerk JWT verification middleware in FastAPI.
- Pass the Clerk bearer token from the frontend on every HTTP request.
- Ensure that users can only read, modify, or delete sessions that belong to their specific `user_id`.

---

## 🚨 [HIGH] Lack of Rate Limiting & Resource Exhaustion (DoS)

**Location:** `backend/server.py` (`thread_runner` in `/api/kickoff`)
**Description:** The backend spins up a new unbounded `threading.Thread` for every kickoff request. There are no rate limits on this endpoint.
**Impact:** 
- A malicious actor could send thousands of requests to `/api/kickoff` in seconds. This would spawn thousands of background threads, immediately exhausting the server's CPU and memory, resulting in a complete Denial of Service (DoS).
**Remediation:**
- Implement API Rate Limiting (e.g., using `slowapi` or Redis).
- Replace unbounded `threading.Thread` with a bounded task queue (like Celery) or a background task pool with a strict maximum concurrency limit.

---

## 🚨 [HIGH] Insecure CORS Configuration

**Location:** `backend/server.py` (Lines 31-36)
**Description:** The `CORSMiddleware` is configured with `allow_origins=["*"]`.
**Impact:**
- Any website on the internet can make cross-origin HTTP requests to the backend. Combined with the lack of authentication, this drastically increases the attack surface for Cross-Site Request Forgery (CSRF) and general abuse.
**Remediation:**
- Restrict `allow_origins` to the explicit production frontend URL (e.g., `["https://agenthub-studio.vercel.app"]`).

---

## ⚠️ [MEDIUM] Unpinned Dependencies

**Location:** `backend/requirements.txt`
**Description:** Python dependencies are listed without version pinning (e.g., `fastapi`, `crewai`, `websockets`).
**Impact:**
- Supply chain risk. If a malicious update is pushed to one of these packages, or a breaking major version is released, the production deployment could silently pull the broken/malicious code during the build process.
**Remediation:**
- Use a lockfile generator like `pip-compile` (from `pip-tools`) or `uv` to create a `requirements.txt` with exact versions and checksum hashes.

---

## ⚠️ [MEDIUM] Sandbox Escape / Code Execution Risk

**Location:** `backend/tasks.py` and `backend/agents.py`
**Description:** The AI agents use `FileWriterTool` to write code directly to the host's file system (`./workspaces/{session_id}`).
**Impact:**
- Currently, the backend only reads/writes the files. However, if a feature is later added to *execute* the generated code (e.g., to run the tests the QA agent wrote), it would execute directly on the host server. Malicious agent outputs could achieve Remote Code Execution (RCE).
**Remediation:**
- If code execution is ever implemented, it must run inside heavily isolated, short-lived containers (e.g., Docker with gVisor or WebAssembly runtimes) with disabled network access and dropped capabilities.

---

## ℹ️ [LOW] Information Disclosure via WebSocket Logs

**Location:** `backend/server.py` (`WSOutputRedirector`)
**Description:** The WebSocket streams the raw standard output of the LLM execution directly to the client and saves it in `terminal.log`.
**Impact:**
- If an LLM hallucinates and inadvertently prints the API key (e.g., the `llm_keys` provided in the request), the secret will be streamed to the client and permanently written to the log file.
**Remediation:**
- Implement a regex-based secret scrubber inside `WSOutputRedirector.write()` that masks any string matching known API key formats before broadcasting.
