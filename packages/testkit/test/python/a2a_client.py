"""A2A 1.0 client on the reference Python SDK (a2a-sdk 1.3.0), for FEAT-044.4.

Usage: a2a_client.py <base url> <task text>. Resolves the AgentCard of the server at <base url>, sends one
SendMessage, reads the answer and then the task again with GetTask, and prints one JSON line:
{"card": <name>, "state": <state>, "artifact": <text>, "history": <count>, "got": <state>}.
The Agentropy interop test runs it against Agentropy's HTTP binding: an independent client reading Agentropy's
AgentCard and replies.
"""

import asyncio
import inspect
import json
import sys

from a2a.client import create_client
from a2a.types import GetTaskRequest, Message, Part, Role, SendMessageRequest, TaskState


def text_of(parts) -> str:
    return "".join(p.text for p in parts if p.WhichOneof("content") == "text")


async def main(base: str, text: str) -> None:
    client = create_client(base)
    if inspect.isawaitable(client):
        client = await client
    request = SendMessageRequest(
        message=Message(
            message_id="py-1",
            role=Role.ROLE_USER,
            parts=[Part(text=text, media_type="text/plain")],
        )
    )
    task = None
    async for response in client.send_message(request):
        kind = response.WhichOneof("payload")
        if kind == "task":
            task = response.task
    assert task is not None, "no task in the answer"
    got = await client.get_task(GetTaskRequest(id=task.id))
    await client.close()
    print(
        json.dumps(
            {
                "state": TaskState.Name(task.status.state),
                "artifact": text_of(task.artifacts[0].parts) if task.artifacts else "",
                "got": TaskState.Name(got.status.state),
                "id_matches": got.id == task.id,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
