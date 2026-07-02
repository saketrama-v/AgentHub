import os
from crewai import Task
from agents import file_write_tool, file_read_tool


def create_moderation_tasks(user_request: str, agents: dict) -> Task:
    return Task(
        description=(
            f"Review the user's request: '{user_request}'. "
            "If it is a valid software engineering task, output exactly 'APPROVED'. "
            "If it is spam, impossible, or harmful, output exactly 'REJECTED: [Reason]'."
        ),
        expected_output="Exactly the word 'APPROVED' or 'REJECTED: [Reason]'.",
        agent=agents["moderator"]
    )


def create_engineering_tasks(
    user_request: str,
    workspace_path: str,
    agents: dict,
    active_agents: list = None
) -> list[Task]:
    """
    Build the full task pipeline.
    
    Args:
        user_request:   The user's prompt.
        workspace_path: Session folder where all files must be saved.
        agents:         Dictionary of initialized agent instances.
        active_agents:  Agent keys to include — empty means include all.
    """
    os.makedirs(workspace_path, exist_ok=True)
    wp = workspace_path  # short alias for readability in descriptions
    
    # agents parameter has all available agents.
    enabled = set(active_agents) if active_agents else set(agents.keys())

    all_tasks = []

    # ── Context ──────────────────────────────────────────────────────────
    if "librarian" in enabled and "librarian" in agents:
        all_tasks.append(Task(
            description=(
                f"Analyze the request: '{user_request}'. "
                "Summarize best practices, tech stack choices, and architectural "
                "guidelines relevant to this specific project."
            ),
            expected_output="Concise architectural context and rules for the team.",
            agent=agents["librarian"]
        ))

    # ── Planning ─────────────────────────────────────────────────────────
    if "tech_lead" in enabled and "tech_lead" in agents:
        all_tasks.append(Task(
            description=(
                f"Create a detailed technical roadmap for: '{user_request}'. "
                f"Define every file to be created (with exact paths inside '{wp}/'), "
                "who owns each file, and the class/function signatures. "
                f"Use FileWriterTool to save the roadmap as '{wp}/ROADMAP.md'."
            ),
            expected_output=f"Structured technical plan saved as {wp}/ROADMAP.md.",
            agent=agents["tech_lead"],
            tools=[file_write_tool]
        ))

    # ── Backend ───────────────────────────────────────────────────────────
    if "backend_engineer" in enabled and "backend_engineer" in agents:
        all_tasks.append(Task(
            description=(
                "Write ALL backend/server-side source files based on the Tech Lead's roadmap. "
                f"Use FileWriterTool to save every file directly into '{wp}/'. "
                "Do NOT output code as text — every file must be physically written to disk. "
                "Ensure all files are complete, runnable, PEP8-compliant, and fully documented."
            ),
            expected_output=f"All backend source files written to {wp}/.",
            agent=agents["backend_engineer"],
            tools=[file_write_tool, file_read_tool]
        ))

    # ── Frontend ──────────────────────────────────────────────────────────
    if "frontend_engineer" in enabled and "frontend_engineer" in agents:
        all_tasks.append(Task(
            description=(
                "Write ALL frontend/UI source files based on the Tech Lead's roadmap. "
                f"Use FileReadTool to check existing backend files in '{wp}/' if needed. "
                f"Use FileWriterTool to save every frontend file into '{wp}/'. "
                "Do NOT output code as text — write every file directly to disk."
            ),
            expected_output=f"All frontend source files written to {wp}/.",
            agent=agents["frontend_engineer"],
            tools=[file_write_tool, file_read_tool]
        ))

    # ── Senior Review ─────────────────────────────────────────────────────
    if "senior_dev" in enabled and "senior_dev" in agents:
        all_tasks.append(Task(
            description=(
                f"Read ALL code files from '{wp}/' using FileReadTool. "
                "Refactor and optimize every file for performance, clean code, and SOLID principles. "
                f"Write the improved versions back into '{wp}/' using FileWriterTool. "
                f"Write '{wp}/REVIEW.md' summarising every change made."
            ),
            expected_output=f"Optimized files overwritten in {wp}/. REVIEW.md written.",
            agent=agents["senior_dev"],
            tools=[file_write_tool, file_read_tool],
            human_input=True
        ))

    # ── QA ────────────────────────────────────────────────────────────────
    if "qa_engineer" in enabled and "qa_engineer" in agents:
        all_tasks.append(Task(
            description=(
                f"Read the optimized code from '{wp}/' using FileReadTool. "
                "Write a comprehensive Pytest test suite covering all edge cases. "
                f"Save it as '{wp}/tests/test_suite.py' using FileWriterTool. "
                f"Write '{wp}/QA_REPORT.md' detailing what was tested and any issues."
            ),
            expected_output=f"Test suite at {wp}/tests/test_suite.py. QA_REPORT.md written.",
            agent=agents["qa_engineer"],
            tools=[file_write_tool, file_read_tool],
            human_input=True
        ))

    # ── Security ──────────────────────────────────────────────────────────
    if "security_admin" in enabled and "security_admin" in agents:
        all_tasks.append(Task(
            description=(
                f"Read all code from '{wp}/' using FileReadTool. "
                "Audit for hardcoded secrets, injection vulnerabilities, insecure practices. "
                f"Write '{wp}/SECURITY_REPORT.md' (PASS or list of issues)."
            ),
            expected_output=f"Security report at {wp}/SECURITY_REPORT.md.",
            agent=agents["security_admin"],
            tools=[file_write_tool, file_read_tool]
        ))

    # ── DevOps ────────────────────────────────────────────────────────────
    if "devops_specialist" in enabled and "devops_specialist" in agents:
        all_tasks.append(Task(
            description=(
                f"Read the final code from '{wp}/' using FileReadTool. "
                "Generate: a Dockerfile, docker-compose.yml, and .github/workflows/ci.yml. "
                f"Save all configs into '{wp}/deploy/' using FileWriterTool. "
                f"Write '{wp}/README.md' with setup and run instructions."
            ),
            expected_output=f"Deploy configs and README.md in {wp}/.",
            agent=agents["devops_specialist"],
            tools=[file_write_tool, file_read_tool]
        ))

    return all_tasks
