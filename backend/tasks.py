import os
from crewai import Task
from agents import (
    tech_lead, security_admin, librarian, moderator,
    qa_engineer, frontend_engineer, backend_engineer,
    senior_dev, devops_specialist,
    file_write_tool, file_read_tool
)

# Agent key → role string mapping for filtering
AGENT_ROLE_MAP = {
    "librarian": librarian,
    "tech_lead": tech_lead,
    "backend_engineer": backend_engineer,
    "frontend_engineer": frontend_engineer,
    "senior_dev": senior_dev,
    "qa_engineer": qa_engineer,
    "security_admin": security_admin,
    "devops_specialist": devops_specialist,
}


def create_moderation_tasks(user_request: str) -> Task:
    return Task(
        description=(
            f"Review the user's request: '{user_request}'. "
            "If it is a valid software engineering task, output exactly 'APPROVED'. "
            "If it is spam, impossible, or harmful, output exactly 'REJECTED: [Reason]'."
        ),
        expected_output="Exactly the word 'APPROVED' or 'REJECTED: [Reason]'.",
        agent=moderator
    )


def create_engineering_tasks(
    user_request: str,
    workspace_path: str,
    active_agents: list = None
) -> list[Task]:
    """
    Build the full task pipeline.
    
    Args:
        user_request:   The user's prompt.
        workspace_path: Session folder where all files must be saved.
        active_agents:  Agent keys to include — empty means include all.
    """
    os.makedirs(workspace_path, exist_ok=True)
    wp = workspace_path  # short alias for readability in descriptions
    enabled = set(active_agents) if active_agents else set(AGENT_ROLE_MAP.keys())

    all_tasks = []

    # ── Context ──────────────────────────────────────────────────────────
    if "librarian" in enabled:
        all_tasks.append(Task(
            description=(
                f"Analyze the request: '{user_request}'. "
                "Summarize best practices, tech stack choices, and architectural "
                "guidelines relevant to this specific project."
            ),
            expected_output="Concise architectural context and rules for the team.",
            agent=librarian
        ))

    # ── Planning ─────────────────────────────────────────────────────────
    if "tech_lead" in enabled:
        all_tasks.append(Task(
            description=(
                f"Create a detailed technical roadmap for: '{user_request}'. "
                f"Define every file to be created (with exact paths inside '{wp}/'), "
                "who owns each file, and the class/function signatures. "
                f"Use FileWriterTool to save the roadmap as '{wp}/ROADMAP.md'."
            ),
            expected_output=f"Structured technical plan saved as {wp}/ROADMAP.md.",
            agent=tech_lead,
            tools=[file_write_tool]
        ))

    # ── Backend ───────────────────────────────────────────────────────────
    if "backend_engineer" in enabled:
        all_tasks.append(Task(
            description=(
                "Write ALL backend/server-side source files based on the Tech Lead's roadmap. "
                f"Use FileWriterTool to save every file directly into '{wp}/'. "
                "Do NOT output code as text — every file must be physically written to disk. "
                "Ensure all files are complete, runnable, PEP8-compliant, and fully documented."
            ),
            expected_output=f"All backend source files written to {wp}/.",
            agent=backend_engineer,
            tools=[file_write_tool, file_read_tool]
        ))

    # ── Frontend ──────────────────────────────────────────────────────────
    if "frontend_engineer" in enabled:
        all_tasks.append(Task(
            description=(
                "Write ALL frontend/UI source files based on the Tech Lead's roadmap. "
                f"Use FileReadTool to check existing backend files in '{wp}/' if needed. "
                f"Use FileWriterTool to save every frontend file into '{wp}/'. "
                "Do NOT output code as text — write every file directly to disk."
            ),
            expected_output=f"All frontend source files written to {wp}/.",
            agent=frontend_engineer,
            tools=[file_write_tool, file_read_tool]
        ))

    # ── Senior Review ─────────────────────────────────────────────────────
    if "senior_dev" in enabled:
        all_tasks.append(Task(
            description=(
                f"Read ALL code files from '{wp}/' using FileReadTool. "
                "Refactor and optimize every file for performance, clean code, and SOLID principles. "
                f"Write the improved versions back into '{wp}/' using FileWriterTool. "
                f"Write '{wp}/REVIEW.md' summarising every change made."
            ),
            expected_output=f"Optimized files overwritten in {wp}/. REVIEW.md written.",
            agent=senior_dev,
            tools=[file_write_tool, file_read_tool],
            human_input=True
        ))

    # ── QA ────────────────────────────────────────────────────────────────
    if "qa_engineer" in enabled:
        all_tasks.append(Task(
            description=(
                f"Read the optimized code from '{wp}/' using FileReadTool. "
                "Write a comprehensive Pytest test suite covering all edge cases. "
                f"Save it as '{wp}/tests/test_suite.py' using FileWriterTool. "
                f"Write '{wp}/QA_REPORT.md' detailing what was tested and any issues."
            ),
            expected_output=f"Test suite at {wp}/tests/test_suite.py. QA_REPORT.md written.",
            agent=qa_engineer,
            tools=[file_write_tool, file_read_tool],
            human_input=True
        ))

    # ── Security ──────────────────────────────────────────────────────────
    if "security_admin" in enabled:
        all_tasks.append(Task(
            description=(
                f"Read all code from '{wp}/' using FileReadTool. "
                "Audit for hardcoded secrets, injection vulnerabilities, insecure practices. "
                f"Write '{wp}/SECURITY_REPORT.md' (PASS or list of issues)."
            ),
            expected_output=f"Security report at {wp}/SECURITY_REPORT.md.",
            agent=security_admin,
            tools=[file_write_tool, file_read_tool]
        ))

    # ── DevOps ────────────────────────────────────────────────────────────
    if "devops_specialist" in enabled:
        all_tasks.append(Task(
            description=(
                f"Read the final code from '{wp}/' using FileReadTool. "
                "Generate: a Dockerfile, docker-compose.yml, and .github/workflows/ci.yml. "
                f"Save all configs into '{wp}/deploy/' using FileWriterTool. "
                f"Write '{wp}/README.md' with setup and run instructions."
            ),
            expected_output=f"Deploy configs and README.md in {wp}/.",
            agent=devops_specialist,
            tools=[file_write_tool, file_read_tool]
        ))

    return all_tasks
