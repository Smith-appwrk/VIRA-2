# IntelliGate Support Bot - Teams Knowledge Base Assistant

A sophisticated Microsoft Teams support bot that provides intelligent Q&A capabilities using RAG (Retrieval Augmented Generation), strict confidence filtering, and automated knowledge base management. The bot integrates with Azure AI Search (VectorDB), SQL Server, and OpenAI to deliver accurate, context-aware responses while preventing hallucinated answers.

## Architecture Overview

The application handles two primary message flows:

1. **KB Review Flow**: Manages knowledge base review and approval process
2. **General Support Flow**: Handles user queries with strict confidence-based responses

### Key Components

- **SQL Server Database**: Stores conversation history, KB summaries, and review status
- **Azure AI Search (VectorDB)**: Semantic search for knowledge retrieval and duplicate detection
- **In-Memory Cache**: Fast access to recent conversation history
- **OpenAI Services**: LLM for intent analysis, relevance scoring, and response generation
- **Daily Summary Scheduler**: Automated KB review summary generation

## Application Flow

### Message Processing Architecture

```mermaid
flowchart TD
    Start([Message Received]) --> CheckGroup{Is KB Review Group?}

    CheckGroup -->|Yes| KBReviewFlow[KB Review Flow]
    CheckGroup -->|No| GeneralFlow[General Support Flow]

    %% KB Review Flow
    KBReviewFlow --> ParseKB[Parse Message:<br/>SummaryID||Action||Changes]
    ParseKB --> CheckAuth{Authorized User?}
    CheckAuth -->|No| AuthError[Send: Not Authorized]
    CheckAuth -->|Yes| GetSummary[Get Summary from SQL DB]
    GetSummary --> ProcessAction{Action Type?}

    ProcessAction -->|Approved| ParseQA1[Parse Q&A Pairs]
    ProcessAction -->|Changes Required| ParseQA2[Parse Modified Q&A Pairs]
    ProcessAction -->|Rejected| UpdateStatus[Update SQL DB Status]

    ParseQA1 --> UpdateVectorDB1[Upsert to VectorDB]
    ParseQA2 --> UpdateVectorDB2[Upsert to VectorDB]
    UpdateVectorDB1 --> UpdateSQL1[Update SQL DB: Approved]
    UpdateVectorDB2 --> UpdateSQL2[Update SQL DB: Approved & Modified]
    UpdateStatus --> SendResponse1[Send Response]
    UpdateSQL1 --> SendResponse2[Send Response]
    UpdateSQL2 --> SendResponse3[Send Response]

    %% General Support Flow
    GeneralFlow --> ShouldRespond{Should Respond?}
    ShouldRespond -->|No| End1([End])
    ShouldRespond -->|Yes| ProcessInput[Process User Input:<br/>- Image Analysis<br/>- Intent Detection<br/>- Spelling Correction]
    ProcessInput --> CheckIntent{Intent = IGNORE?}
    CheckIntent -->|Yes| End2([End])
    CheckIntent -->|No| SaveHistory[Save to Conversation History<br/>SQL DB + Cache]

    SaveHistory --> GetHistory[Get Last 10 Messages<br/>from Cache or SQL DB]
    GetHistory --> VectorSearch[Search VectorDB<br/>Hybrid Search]
    VectorSearch --> RelevanceScore[LLM Relevance Scoring<br/>Confidence Check]

    RelevanceScore --> CheckConfidence{Confidence >= 0.7?}
    CheckConfidence -->|No| NoAnswer[Return: NO_ANSWER<br/>Notify Support Team]
    CheckConfidence -->|Yes| GenerateResponse[Generate Response<br/>with Filtered Knowledge]

    GenerateResponse --> ValidateResponse{Response Valid?}
    ValidateResponse -->|Uncertain| NoAnswer
    ValidateResponse -->|Valid| SendResponse4[Send Response]
    SendResponse4 --> SaveResponse[Save Response to History]

    %% Daily Summary Flow
    DailyScheduler[Daily Summary Scheduler] --> GetConversations[Get Conversations<br/>from SQL DB]
    GetConversations --> FilterUnique[Filter Unique Messages]
    FilterUnique --> ExtractQA[Extract Q&A Pairs<br/>with OpenAI]
    ExtractQA --> CheckDuplicates[Check Duplicates<br/>in VectorDB]
    CheckDuplicates --> LLMValidate[LLM Duplicate Validation]
    LLMValidate --> StoreSummary[Store in SQL DB]
    StoreSummary --> SendSummary[Send to KB Review Group]

    style KBReviewFlow fill:#e1f5ff
    style GeneralFlow fill:#fff4e1
    style VectorSearch fill:#e8f5e9
    style RelevanceScore fill:#fce4ec
    style DailyScheduler fill:#f3e5f5
```

### Flow Details

#### 1. KB Review Flow

**Input Format**: `SummaryID||Action||Changes`

**Steps**:

1. Parse message format (handles single-line and multi-line Q&A)
2. Validate user authorization
3. Retrieve summary from SQL DB by SummaryID
4. Process action:
   - **Approved**: Parse Q&A pairs → Upsert to VectorDB → Update SQL DB status
   - **Changes Required**: Parse modified Q&A → Upsert to VectorDB immediately → Update SQL DB
   - **Rejected**: Update SQL DB status only
5. Send confirmation response

**Key Features**:

- Immediate VectorDB update for changes (no approval needed)
- Robust Q&A parsing (handles both formats)
- Database-driven summary tracking

#### 2. General Support Flow

**Steps**:

1. **Message Filtering**: Check if bot should respond (mention or configured users)
2. **Input Processing**:
   - Extract and analyze image attachments (OCR/Vision)
   - Detect intent (QUESTION/ERROR/IGNORE)
   - Correct spelling
3. **History Management**:
   - Save message to SQL DB (non-blocking)
   - Cache recent messages in memory
   - Retrieve last 10 messages (cache-first, fallback to SQL DB)
4. **Knowledge Retrieval**:
   - Hybrid search in VectorDB (vector + keyword)
   - Minimum similarity threshold: 0.032
5. **Strict Confidence Filtering**:
   - LLM-based relevance scoring (0-1 scale)
   - Confidence threshold: 0.7 (70%)
   - Filter out low-confidence matches
   - Final response validation
6. **Response Generation**:
   - Generate answer with validated knowledge only
   - Return "NO_ANSWER" if confidence < threshold
   - Notify support team for unanswered queries
7. **Save Response**: Store assistant response to SQL DB

**Key Features**:

- Prevents hallucinated responses
- Multi-stage confidence validation
- Cache-optimized history retrieval
- Image processing support

#### 3. Daily Summary Generation Flow

**Trigger**: Scheduled daily at configured time

**Steps**:

1. Get conversations from SQL DB for the date
2. Filter unique messages (remove duplicates)
3. Extract Q&A pairs using OpenAI (structured JSON)
4. **Duplicate Detection**:
   - Search VectorDB by question (threshold: 0.75)
   - Search VectorDB by Q&A combined
   - LLM validation for strict duplicate detection
5. Store unique Q&A pairs in SQL DB
6. Send summary to KB Review group

**Key Features**:

- Prevents duplicate knowledge entries
- Multi-strategy duplicate detection
- LLM-based validation for accuracy

### Data Storage Architecture

**SQL Server Database**:

- `conversations`: Message history with timestamps
- `kb_summaries`: KB review summaries with status tracking
- Indexed for fast queries by date, conversation ID, status

**Azure AI Search (VectorDB)**:

- `intelligate-kb` index: Knowledge base with embeddings
- Fields: `question`, `answer`, `content`, `embedding`, `status`
- Hybrid search: Vector similarity + keyword matching

**In-Memory Cache**:

- Recent conversation history (last 24 hours)
- Fast retrieval for active conversations
- Falls back to SQL DB for older messages

### Integration Points

- **SQL DB**: Conversation persistence, KB summary management
- **VectorDB**: Semantic knowledge search, duplicate detection
- **Cache**: Performance optimization for recent conversations
- **OpenAI**: Intent analysis, relevance scoring, response generation

## Get Started

> **Prerequisites**
>
> To run the template in your local dev machine, you will need:
>
> - [Node.js](https://nodejs.org/), supported versions: 20, 22
> - [Microsoft 365 Agents Toolkit Visual Studio Code Extension](https://aka.ms/teams-toolkit) version 5.0.0 and higher or [Microsoft 365 Agents Toolkit CLI](https://aka.ms/teamsfx-toolkit-cli)
> - An account with [OpenAI](https://platform.openai.com/).

> For local debugging using Microsoft 365 Agents Toolkit CLI, you need to do some extra steps described in [Set up your Microsoft 365 Agents Toolkit CLI for local debugging](https://aka.ms/teamsfx-cli-debugging).

1. First, select the Microsoft 365 Agents Toolkit icon on the left in the VS Code toolbar.
1. In file _env/.env.playground.user_, fill in your OpenAI key `SECRET_OPENAI_API_KEY=<your-key>`.
1. Press F5 to start debugging which launches your app in Microsoft 365 Agents Playground using a web browser. Select `Debug in Microsoft 365 Agents Playground`.
1. You can send any message to get a response from the agent.

**Congratulations**! You are running an application that can now interact with users in Microsoft 365 Agents Playground:

![RAG Bot](https://github.com/user-attachments/assets/464fe1b0-d8c6-4ecf-a410-8dde7d9ca9b3)

## What's included in the template

| Folder       | Contents                                   |
| ------------ | ------------------------------------------ |
| `.vscode`    | VSCode files for debugging                 |
| `appPackage` | Templates for the application manifest     |
| `env`        | Environment files                          |
| `infra`      | Templates for provisioning Azure resources |
| `src`        | The source code for the application        |

The following files can be customized and demonstrate an example implementation to get you started.

| File                      | Contents                           |
| ------------------------- | ---------------------------------- |
| `src/index.ts`            | Application entry point.           |
| `src/config.ts`           | Defines the environment variables. |
| `src/app/app.ts`          | Main application code.             |
| `src/app/myDataSource.ts` | Defines the data source.           |
| `src/data/*.md`           | Raw text data sources.             |

The following are Microsoft 365 Agents Toolkit specific project files. You can [visit a complete guide on Github](https://github.com/OfficeDev/TeamsFx/wiki/Teams-Toolkit-Visual-Studio-Code-v5-Guide#overview) to understand how Microsoft 365 Agents Toolkit works.

| File                        | Contents                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m365agents.yml`            | This is the main Microsoft 365 Agents Toolkit project file. The project file defines two primary things: Properties and configuration Stage definitions. |
| `m365agents.local.yml`      | This overrides `m365agents.yml` with actions that enable local execution and debugging.                                                                  |
| `m365agents.playground.yml` | This overrides `m365agents.yml` with actions that enable local execution and debugging in Microsoft 365 Agents Playground.                               |

## Extend the template

To extend the Basic AI Chatbot template with more AI capabilities, explore [Teams AI library V2 documentation](https://aka.ms/m365-agents-toolkit/teams-agent-extend-ai).

## Additional information and references

- [Microsoft 365 Agents Toolkit Documentations](https://docs.microsoft.com/microsoftteams/platform/toolkit/teams-toolkit-fundamentals)
- [Microsoft 365 Agents Toolkit CLI](https://aka.ms/teamsfx-toolkit-cli)
- [Microsoft 365 Agents Toolkit Samples](https://github.com/OfficeDev/TeamsFx-Samples)
