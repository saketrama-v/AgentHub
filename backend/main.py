import os
import sys
import time
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from crewai import Crew, Process
from agents import (
    tech_lead, security_admin, librarian, moderator, qa_engineer,
    frontend_engineer, backend_engineer, senior_dev, devops_specialist,
    manager_agent
)
from tasks import create_moderation_tasks, create_engineering_tasks

# Agent registry so we can filter by name
ALL_AGENTS = {
    "moderator": moderator,
    "librarian": librarian,
    "tech_lead": tech_lead,
    "backend_engineer": backend_engineer,
    "frontend_engineer": frontend_engineer,
    "senior_dev": senior_dev,
    "qa_engineer": qa_engineer,
    "security_admin": security_admin,
    "devops_specialist": devops_specialist,
    "manager_agent": manager_agent,
}


def execute_agenthub_run(
    user_request: str,
    workspace_path: str = "./workspace",
    active_agents: list = None
):
    """
    Run the full AgentHub pipeline.
    
    Args:
        user_request:   The prompt/task from the user.
        workspace_path: Where agents should write files (session folder).
        active_agents:  Optional list of agent role keys to include.
                        Empty / None = use all agents.
    """
    # ── Moderation gate ────────────────────────────────────────────────────
    mod_task = create_moderation_tasks(user_request)
    gatekeeper_crew = Crew(agents=[moderator], tasks=[mod_task], verbose=False)
    mod_result = gatekeeper_crew.kickoff()

    if "REJECTED" in str(mod_result):
        print(f"\n❌ REQUEST DENIED: {mod_result}")
        return

    print("\n✅ Request Approved. Engineering Team is starting...\n")

    # ── Build task pipeline ────────────────────────────────────────────────
    tasks = create_engineering_tasks(user_request, workspace_path, active_agents or [])

    # ── Determine which crew agents are needed ─────────────────────────────
    # Always include manager; filter the rest if caller specified a subset
    crew_agents = [
        librarian, tech_lead, frontend_engineer, backend_engineer,
        senior_dev, qa_engineer, security_admin, devops_specialist
    ]
    if active_agents:
        key_map = {
            "librarian": librarian, "tech_lead": tech_lead,
            "backend_engineer": backend_engineer, "frontend_engineer": frontend_engineer,
            "senior_dev": senior_dev, "qa_engineer": qa_engineer,
            "security_admin": security_admin, "devops_specialist": devops_specialist,
        }
        crew_agents = [v for k, v in key_map.items() if k in active_agents]

    agenthub_crew = Crew(
        agents=crew_agents,
        tasks=tasks,
        process=Process.hierarchical,
        manager_agent=manager_agent,
        verbose=True,
        max_rpm=8,  # Stay within 15 RPM free-tier limit
    )

    print("\n⏳ Agents are working on your request...\n")
    result = agenthub_crew.kickoff()

    sys.stdout.flush()
    sys.stderr.flush()
    time.sleep(2)
    return result


if __name__ == "__main__":
    print("=" * 50)
    print("  🚀 AgentHub Core Engine v0.4 (Web Ready)")
    print("  Powered by Google Gemini + CrewAI")
    print("  Type 'exit' to quit")
    print("=" * 50)

    while True:
        try:
            print()
            user_input = input("🧑‍💻 Enter your request: ")
            if user_input.strip().lower() in ["exit", "quit", "q"]:
                print("\n👋 AgentHub shutting down.")
                break
            if not user_input.strip():
                print("⚠️  Empty request.")
                continue
            execute_agenthub_run(user_input)
            print("\n" + "═" * 50)
            print("  ✅ Task Complete.")
            print("═" * 50)
        except KeyboardInterrupt:
            print("\n\n👋 AgentHub interrupted.")
            break
