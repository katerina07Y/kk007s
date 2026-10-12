# ASSEMBLE — Live Agent Prototype

This package upgrades the offline interaction demo to use a real OpenAI model through the Responses API. It includes structured project analysis, live Agent chat, function calling to search the local candidate sample directory, and model-ranked resource suggestions.

## What is live

- **Project analysis:** the model creates an editable task map, a provisional capability-gap hypothesis, capability observations, three possible resource strategies, and follow-up questions.
- **Personal profile context:** the profile page combines capability evidence, a personal summary, a resume, and past project experience. Live analysis uses these details as self-reported evidence. PDF/Office resumes are uploaded for analysis; text resumes are read locally and sent as text.
- **Agent chat:** the model receives the current project context and recent conversation history.
- **Agent tool calling:** the model can call `search_candidate_profiles` to search the local fictional candidate directory in response to relevant chat requests.
- **People recommendations:** the model ranks relevant profiles from that same sample directory and explains fit/unknowns. These profiles are fictional and are not connected to a real people-search service.
- **Brief uploads:** TXT/Markdown files are read locally and their text is sent as part of analysis. PDF/Word/PowerPoint files (up to 8 MB) are uploaded to the OpenAI API for that analysis; the server requests file deletion afterward on a best-effort basis.

## Requirements

- Node.js 22 LTS recommended (built-in `fetch`, `FormData`, and `Blob` are used). No npm install is needed.
- An OpenAI API key with API billing and access to the selected model. ChatGPT Plus and OpenAI API billing are separate.

Official API references:
- Quickstart and API key handling: https://developers.openai.com/api/docs/quickstart
- Responses API file inputs: https://developers.openai.com/api/docs/guides/file-inputs
- Function calling: https://developers.openai.com/api/docs/guides/function-calling
- Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses

## Windows setup

1. Unzip this folder to a normal folder (for example, Desktop\ASSEMBLE_Live_Agent).
2. Double-click `start.bat` once. It creates `.env.example` → `.env` and opens the new file in Notepad.
3. In `.env`, replace `replace_with_your_api_key` with your own API key. Keep the key private; do not paste it into `index.html` and do not share the `.env` file.
4. Save `.env`, close Notepad, and run `start.bat` again.
5. Open http://127.0.0.1:4173 in Chrome or Edge. The Agent badge should show `LIVE · gpt-6-astra` when the key is configured.
6. To stop the server, return to the terminal and press `Ctrl+C`.

If your API project does not have access to `gpt-6-astra`, change `OPENAI_MODEL` in `.env` to a model available to your API project, then restart the server.

## macOS / Linux setup

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY, then run:
node server.js
```

Open http://127.0.0.1:4173.

## Public deployment (Render)

This repository includes a Render Blueprint in `render.yaml` and a `package.json` start command. Push the project to a GitHub repository (it can remain private), then create a Blueprint in Render and connect that repository. The Blueprint creates a public web service and uses `/api/status` as its health check. A Chinese step-by-step guide is available in `部署说明.md`.

Before deploying, add a valid `OPENAI_API_KEY` in the Render service's Environment settings. Never put the key in `render.yaml`, source files, or a public repository. Keep `OPENAI_MODEL` set to a model your API account can use. Render serves web services on a public `onrender.com` subdomain and terminates HTTPS at its load balancer.

The included Blueprint uses Render's free web-service plan. Free services can spin down when idle, and free instance hours are limited; the first request after idle may take longer. OpenAI API usage is billed separately to the API account. Review Render's [free service limits](https://render.com/docs/free) and [environment variable guidance](https://render.com/docs/configure-environment-variables).

## Safety and privacy notes

- The API key is read by the local server and is never returned to the browser.
- The server binds to `127.0.0.1` for local use and `0.0.0.0` in production so Render can route traffic to it. Do not expose the Node server directly to the public internet outside a trusted hosting platform or reverse proxy.
- Your project text, profile details, resume, and any attached document you analyze are sent to the OpenAI API when live analysis is enabled. Do not use confidential, proprietary, or sensitive information unless you have reviewed the applicable terms and data-handling requirements.
- For PDF/Office files, the server asks the API to delete its uploaded file after the response; cleanup is best-effort. This is not a guarantee about all API logs or retention policies.
- The demo's 12 candidate profiles are fictional. Model ranking improves the matching rationale, but does not make these real people or verify their availability, interest, qualifications, or contact details.
- The Agent never sends messages, contacts candidates, or executes external actions. Action plans remain under the user's control.
- This prototype has no authentication, user accounts, persistent profile storage, telemetry, or production operations monitoring. Profile data stays in the visitor's browser session; the deployed site and API endpoints are publicly reachable.
- Public service requests have per-IP rate limits and a per-instance concurrency cap. These reduce accidental and basic abusive usage but are not a replacement for account-level API spending limits or stronger identity controls at larger scale.

## Troubleshooting

- **`API KEY NEEDED`:** ensure `.env` exists and contains `OPENAI_API_KEY=sk-...`, with no placeholder text. Stop and restart the server after editing it.
- **`INVALID_API_KEY`:** generate/check the API key in the API dashboard.
- **`MODEL_ACCESS`:** change `OPENAI_MODEL` to a model your API account can access.
- **`RATE_OR_QUOTA`:** check API billing, credits, and project limits.
- **Browser says server not running:** do not open `index.html` directly. Start `start.bat`, then open `http://127.0.0.1:4173`.

## Architecture

`Browser UI → Local Node server → OpenAI Responses API`

- `POST /api/analyze`: Structured Outputs (JSON Schema) for predictable task and gap objects. Profile details, capability evidence, resume, and past projects are included as analysis context.
- `POST /api/chat`: Responses API + a server-executed function tool (`search_candidate_profiles`).
- `POST /api/recommend`: Structured model ranking over the fictional sample profiles.
- `GET /api/status`: tells the UI whether the key is configured, without exposing it.
