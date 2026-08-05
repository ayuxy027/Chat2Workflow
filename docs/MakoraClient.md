import os
from openai import OpenAI

client = OpenAI(
    base_url="https://inference.makora.com/v1",
    api_key=os.environ["MAKORA_API_KEY"],
)

response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V4-Flash",
    messages=[
        {
            "role": "system",
            "content": "You are a helpful assistant.",
        },
        {
            "role": "user",
            "content": "What's the weather like in Paris right now?",
        },
    ],
    reasoning_effort="max",
    tools=[
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {
                            "type": "string",
                            "description": "City name, e.g. \"Paris\"",
                        },
                    },
                    "required": [
                        "city",
                    ],
                },
            },
        },
    ],
    tool_choice="auto",
    response_format={
        "type": "json_object",
    },
    stream=True,
    stream_options={
        "include_usage": True,
    },
)
for chunk in response:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
