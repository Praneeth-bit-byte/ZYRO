# ZYRO — Your Personal AI Assistant

> Building a JARVIS-level personal AI assistant with intelligent conversation, persistent memory, voice interaction, computer control, and autonomous task execution.

## About ZYRO

ZYRO is an ambitious personal AI assistant project inspired by JARVIS from Iron Man. The goal is to develop a unified, intelligent system that can understand natural language, remember personal context, reason through complex tasks, interact with digital systems, and execute authorized actions autonomously.

ZYRO is designed to evolve beyond a conventional chatbot into a personalized AI companion that connects and assists across desktop and Android environments.

**Project Creator:** Praneeth Thota  
**Project Status:** Initial Development  
**Project Name:** ZYRO

## Vision

Our vision is to create a real-world personal AI assistant approaching the breadth of capabilities demonstrated by fictional JARVIS.

ZYRO will combine:

- Conversational intelligence and reasoning
- Voice-first interaction
- Long-term personalized memory
- Computer and application control
- Android integration
- Email, calendar, and task management
- Web research and document analysis
- Multi-step automation
- Proactive personal assistance

The project will be developed incrementally, with a modular architecture that allows each capability to evolve independently.

## Core Features

### 1. AI Intelligence
- Natural language understanding and conversation
- Context-aware responses
- Complex problem-solving and reasoning
- Multi-step task planning
- Tool selection and execution
- Support for multiple AI models

### 2. Voice Assistant
- Wake-word activation
- Speech recognition and natural voice responses
- English, Hindi, and Telugu support
- Hands-free interaction
- Voice activity detection
- Configurable silence timeout and sleep behavior

### 3. Long-Term Memory
- Persistent conversation history
- Personal facts and preferences
- Project and task memory
- Semantic memory retrieval
- Context-aware personalization
- User-controlled memory review and deletion

### 4. Computer Control
- Application launching
- File and folder management
- Browser automation
- Approved system commands
- Desktop interaction
- Screenshot analysis
- Workflow automation

### 5. Android Integration
- Companion application
- Voice and text interaction
- Cross-device synchronization
- Notifications and reminders
- Authorized mobile actions

### 6. Personal Productivity
- Gmail integration
- Email search, summaries, and drafting
- Calendar and event management
- Task and reminder management
- Contacts and communication assistance
- Daily briefings and follow-ups

### 7. Web Intelligence
- Internet search
- Current information retrieval
- Source-backed answers
- Website and document summarization
- Research assistance

### 8. Advanced Intelligence
- Document analysis
- Coding assistance
- Computer vision
- Autonomous workflows
- Proactive assistance
- Execution verification and error recovery

## Technical Direction

ZYRO uses a modular architecture with independently maintainable components.

| Component | Planned Responsibility |
|---|---|
| Frontend | Responsive desktop and mobile interface |
| Backend | API, authentication, orchestration, and tool execution |
| AI engine | Reasoning, conversation, and task planning |
| Memory system | Persistent storage and semantic retrieval |
| Voice engine | Speech recognition, wake-word detection, and speech synthesis |
| Integration layer | Desktop, Android, email, calendar, and external tools |
| Automation engine | Scheduled and multi-step workflows |
| Security layer | Permissions, credential protection, and action verification |

---

## Firebase Authentication & Cloud Firestore Setup (`zyro-a3482`)

ZYRO uses the **Firebase Admin SDK (`firebase-admin`) strictly on the backend** to verify Firebase ID tokens and persist user-scoped data in Cloud Firestore under project **`zyro-a3482`**. Service-account credentials are never exposed to the frontend.

### User-Scoped Firestore Data Hierarchy
All persistent records are isolated under the authenticated user's UID:
- `/users/{uid}` — User profile and cross-platform preferences
- `/users/{uid}/conversations/{conversationId}` — Conversation metadata
- `/users/{uid}/conversations/{conversationId}/messages/{messageId}` — Conversation message history
- `/users/{uid}/memories/{memoryId}` — Long-term personal, project, and preference memories
- `/users/{uid}/tasks/{taskId}` — User tasks and status tracking
- `/users/{uid}/workflows/{workflowId}` — Multi-step automation workflows
- `/users/{uid}/auditLogs/{auditId}` — Permission Gateway execution and security audit trail

### 1. Local Development Setup (`GOOGLE_APPLICATION_CREDENTIALS`)

1. Open the [Firebase Console for project `zyro-a3482`](https://console.firebase.google.com/project/zyro-a3482/settings/serviceaccounts/adminsdk).
2. Navigate to **Project Settings $\rightarrow$ Service accounts $\rightarrow$ Firebase Admin SDK** and click **Generate new private key**.
3. Save the downloaded JSON file into the local, git-ignored `secrets/` directory (never commit this file to version control):
   ```bash
   mkdir -p secrets
   mv ~/Downloads/zyro-a3482-firebase-adminsdk-*.json ./secrets/zyro-a3482-service-account.json
   chmod 600 ./secrets/zyro-a3482-service-account.json
   ```
4. Copy `.env.example` to `.env` and set your environment variables:
   ```bash
   cp .env.example .env
   ```
   In `.env`:
   ```env
   GEMINI_API_KEY=<your-google-ai-api-key>
   FIREBASE_PROJECT_ID=zyro-a3482
   FIREBASE_DATABASE_ID=(default)
   GOOGLE_APPLICATION_CREDENTIALS=./secrets/zyro-a3482-service-account.json
   ```
5. Install dependencies and start the server:
   ```bash
   npm install
   npm run dev
   ```
6. Verify connection status:
   ```bash
   curl -s http://127.0.0.1:3000/api/v1/system/status | jq .persistence
   ```
   When configured, `persistence.configured` returns `true` with `projectId: "zyro-a3482"`.

### 2. Cloud / Production Deployment Setup

When deploying to Cloud Run, Docker, or another secure hosting environment where local credential files are not used, configure environment secrets via your platform's Secret Manager:

- **Option A — Inline JSON Secret (`FIREBASE_SERVICE_ACCOUNT_JSON`):**
  Mount the full service-account JSON content into `FIREBASE_SERVICE_ACCOUNT_JSON` and set `FIREBASE_PROJECT_ID=zyro-a3482`.
- **Option B — Discrete Environment Variables:**
  Set `FIREBASE_PROJECT_ID=zyro-a3482`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` in your hosting secret store.

### 3. Verifying Authenticated Requests Against Protected Endpoints

Obtain a Firebase ID token `<FIREBASE_ID_TOKEN>` for a signed-in user in project `zyro-a3482` and pass it in the `Authorization: Bearer <FIREBASE_ID_TOKEN>` header:

```bash
# Create a user-scoped memory
curl -X POST http://127.0.0.1:3000/api/v1/memories \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"category":"Project Context","content":"Primary Firebase project is zyro-a3482","tags":["firebase","architecture"]}'

# List user-scoped memories
curl -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  http://127.0.0.1:3000/api/v1/memories

# Create a user-scoped task
curl -X POST http://127.0.0.1:3000/api/v1/tasks \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Review Firestore security rules","priority":"High","category":"Security"}'
```

---

## Development Roadmap

1. **Foundation:** Establish project structure, branding, UI, backend, and authentication.
2. **AI Core:** Implement conversational AI, context handling, and tool calling.
3. **Voice:** Add speech recognition, synthesis, wake-word detection, and multilingual support.
4. **Memory:** Implement persistent memory and contextual retrieval.
5. **Device Integration:** Add desktop automation and Android connectivity.
6. **Productivity:** Integrate email, calendar, tasks, reminders, and notifications.
7. **Advanced Intelligence:** Add research, document analysis, coding assistance, and vision.
8. **Automation:** Implement scheduled, event-driven, and multi-step workflows.
9. **Testing and Deployment:** Improve security, reliability, performance, and deployment readiness.

## Future Expansion

The following capabilities are planned for future stages and are not part of the initial development scope:

- Smart home automation
- Robotics and IoT integration
- Advanced sensor systems
- Specialized hardware interfaces
- Iron Man-inspired suit integration

## Development Principles

- Build from scratch with a clean and maintainable architecture.
- Use modular components and clear interfaces.
- Prioritize security and user privacy.
- Require appropriate authorization for sensitive actions.
- Verify tool execution before reporting success.
- Avoid hardcoded credentials and secrets.
- Test features independently before integration.
- Keep the project extensible for future capabilities.

## Instructions for AI Development Tools

When working on ZYRO in Google AI Studio or other AI development environments:

- Treat this README as the primary project vision and requirements reference.
- Preserve the ZYRO name and branding throughout the application.
- Build toward the complete personal AI assistant vision, not merely a chatbot or smart home controller.
- Implement features incrementally without breaking existing functionality.
- Use clean, modular, production-oriented code.
- Do not claim a feature is implemented unless it is functional and tested.
- Keep credentials in environment variables or secure configuration.
- Document setup, dependencies, and required environment variables.
- Do not create ZIP archives or push to GitHub unless explicitly requested.

## Project Goal

ZYRO aims to become a reliable, personalized, voice-first AI assistant capable of understanding, remembering, reasoning, and acting across digital environments.

**One unified intelligence. Multiple capabilities. A personal AI built to evolve.**
