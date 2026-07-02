import os
import sys
import time
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from crewai import Crew, Process
from agents import create_agents
from tasks import create_moderation_tasks, create_engineering_tasks

def execute_agenthub_run(
    user_request: str,
    workspace_path: str = "./workspace",
    active_agents: list = None,
    llm_keys: dict = None,
    llm_provider: str = "gemini"
):
    """
    Run the full AgentHub pipeline.
    
    Args:
        user_request:   The prompt/task from the user.
        workspace_path: Where agents should write files (session folder).
        active_agents:  Optional list of agent role keys to include.
                        Empty / None = use all agents.
        llm_keys:       Dictionary of API keys from the frontend request.
        llm_provider:   The selected LLM provider (gemini, openai, anthropic).
    """
    # ── Initialize Dynamic Agents ──────────────────────────────────────────
    agents = create_agents(llm_keys, llm_provider)

    # ── Moderation gate ────────────────────────────────────────────────────
    mod_task = create_moderation_tasks(user_request, agents)
    gatekeeper_crew = Crew(agents=[agents["moderator"]], tasks=[mod_task], verbose=False)
    mod_result = gatekeeper_crew.kickoff()

    if "REJECTED" in str(mod_result):
        print(f"\n❌ REQUEST DENIED: {mod_result}")
        return

    print("\n✅ Request Approved. Engineering Team is starting...\n")

    # ── Build task pipeline ────────────────────────────────────────────────
    tasks = create_engineering_tasks(user_request, workspace_path, agents, active_agents or [])

    # ── Determine which crew agents are needed ─────────────────────────────
    crew_agents = [
        agents["librarian"], agents["tech_lead"], agents["frontend_engineer"],
        agents["backend_engineer"], agents["senior_dev"], agents["qa_engineer"],
        agents["security_admin"], agents["devops_specialist"]
    ]
    if active_agents:
        crew_agents = [agents[k] for k in active_agents if k in agents]

    agenthub_crew = Crew(
        agents=crew_agents,
        tasks=tasks,
        process=Process.sequential,
        verbose=True,
        max_rpm=8,  # Stay within free-tier limits
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
    print("  Powered by Custom LLM + CrewAI")
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
