"""An A2A 1.0 peer on the reference Python SDK (a2a-sdk 1.3.0), for FEAT-044.4.

Serves one echo agent over the JSON-RPC binding on 127.0.0.1:<port> (argv[1]): the AgentCard at
/.well-known/agent-card.json and JSON-RPC at /a2a. A SendMessage completes the task with an artifact
"echo: <input text>". The Agentropy interop test starts it, delegates to it through A2ACommunicationProvider and
reads the result, which exercises Agentropy's client against a second, independent implementation.
"""

import sys

import uvicorn
from starlette.applications import Starlette

from a2a.helpers import new_task_from_user_message, new_text_part
from a2a.server.agent_execution import AgentExecutor
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill


class Echo(AgentExecutor):
    async def execute(self, context, event_queue):
        if context.current_task is None:
            await event_queue.enqueue_event(new_task_from_user_message(context.message))
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.start_work()
        await updater.add_artifact(
            [new_text_part("echo: " + context.get_user_input())], name="result"
        )
        await updater.complete()

    async def cancel(self, context, event_queue):
        await TaskUpdater(event_queue, context.task_id, context.context_id).cancel()


def build(port: int) -> Starlette:
    card = AgentCard(
        name="py-echo",
        description="Echoes its input (Agentropy interop peer)",
        version="1.0.0",
        supported_interfaces=[
            AgentInterface(
                url=f"http://127.0.0.1:{port}/a2a",
                protocol_binding="JSONRPC",
                protocol_version="1.0",
            )
        ],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain", "application/json"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id="echo", name="echo", description="Echoes the input", tags=["echo"]
            )
        ],
    )
    handler = DefaultRequestHandler(
        agent_executor=Echo(), task_store=InMemoryTaskStore(), agent_card=card
    )
    return Starlette(
        routes=[
            *create_agent_card_routes(card),
            *create_jsonrpc_routes(handler, rpc_url="/a2a"),
        ]
    )


if __name__ == "__main__":
    port = int(sys.argv[1])
    uvicorn.run(build(port), host="127.0.0.1", port=port, log_level="warning")
