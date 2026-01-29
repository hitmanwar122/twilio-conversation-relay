# System Architecture

This document describes the technical architecture of the Twilio ConversationRelay Voice Bot system.

## Overview

The system is an AI-powered voice bot that handles customer calls, provides automated responses using OpenAI's GPT-4o-mini, and seamlessly escalates to human agents in Salesforce Service Cloud Voice when needed.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CUSTOMER LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                           📞 Customer Phone Call                                 │
│                                    │                                             │
└────────────────────────────────────┼─────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TWILIO LAYER                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────┐    ┌────────────────────┐    ┌─────────────────────────┐  │
│  │  Phone Number    │───▶│ ConversationRelay  │◀──▶│  WebSocket Connection   │  │
│  │  +1(475)262-8472 │    │  (STT + TTS)       │    │  (wss://server/...)     │  │
│  └──────────────────┘    └────────────────────┘    └─────────────────────────┘  │
│                                                              │                   │
│  ┌──────────────────┐    ┌────────────────────┐              │                   │
│  │  Flex            │◀───│   TaskRouter       │◀─────────────┘                   │
│  │  (Agent UI)      │    │   (Routing)        │       (on escalation)           │
│  └──────────────────┘    └────────────────────┘                                  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         Node.js Express Server                           │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐ │    │
│  │  │  HTTP Endpoints │  │ WebSocket Server│  │  In-Memory Conversation  │ │    │
│  │  │  /voice/*       │  │  /conversation/ │  │  Storage (Map)           │ │    │
│  │  │  /api/*         │  │  {callSid}      │  │                          │ │    │
│  │  └─────────────────┘  └─────────────────┘  └──────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                     │                                            │
└─────────────────────────────────────┼────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              AI LAYER                                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                          OpenAI API                                      │    │
│  │                                                                          │    │
│  │  Model: gpt-4o-mini    │  Temperature: 0.7    │  Max Tokens: 150        │    │
│  │                                                                          │    │
│  │  System Prompt: OWL Bank Credit Card Knowledge Base                     │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CRM LAYER (Escalation)                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                     Salesforce Service Cloud                             │    │
│  │                                                                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐ │    │
│  │  │ Service Cloud   │  │ Service Console │  │  LWC: Conversation       │ │    │
│  │  │ Voice (SCV)     │  │ (Agent Desktop) │  │  Transcript Component    │ │    │
│  │  └─────────────────┘  └─────────────────┘  └──────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Twilio ConversationRelay

ConversationRelay is Twilio's service that connects phone calls to WebSocket-based applications.

**Responsibilities:**
- Receives incoming phone calls
- Performs Speech-to-Text (STT) on customer speech
- Sends transcribed text to WebSocket server
- Receives text responses from server
- Performs Text-to-Speech (TTS) to speak responses to customer

**Configuration:**
- Voice: `Google.en-US-Journey-F` (Neural TTS)
- Language: `en-US`
- Welcome Greeting: Configurable initial message

### 2. Node.js WebSocket Server

The core application server handling real-time communication.

**Components:**

| Component | Technology | Purpose |
|-----------|------------|---------|
| HTTP Server | Express.js | REST endpoints for TwiML, handoff, monitoring |
| WebSocket Server | ws library | Real-time bidirectional communication |
| Twilio Client | twilio SDK | TaskRouter operations, task lookup |
| OpenAI Client | openai SDK | GPT-4o-mini completions |

### 3. Conversation Storage

In-memory Map storing active conversations:

```javascript
{
  callSid: "CA...",           // Twilio Call SID
  callerPhone: "+1...",       // Customer phone number
  startTime: "ISO-8601",      // Call start timestamp
  transcript: [               // Conversation history
    { role: 'customer', text: '...', timestamp: '...' },
    { role: 'agent', text: '...', timestamp: '...' }
  ],
  escalationReason: null      // Reason if escalated
}
```

### 4. OpenAI Integration

**Model:** GPT-4o-mini

**System Prompt Contains:**
- OWL Bank credit card product knowledge
- Response formatting guidelines (keep responses concise for voice)
- Escalation triggers (when to hand off to human)
- Boundaries (what topics to handle vs escalate)

### 5. Twilio Flex + TaskRouter

Handles escalation to human agents:

**TaskRouter:** Routes calls to available agents based on:
- Skills-based routing
- Queue management
- Agent availability

**Flex:** Agent workspace where:
- Agents receive escalated calls
- View conversation transcript
- Access customer context

## Data Flow

### Normal Conversation Flow

```
1. Customer calls Twilio phone number
                    │
                    ▼
2. /voice/incoming endpoint receives call
   - Creates conversation object in memory
   - Returns TwiML with ConversationRelay config
                    │
                    ▼
3. ConversationRelay establishes WebSocket to /conversation/{callSid}
                    │
                    ▼
4. Customer speaks → ConversationRelay (STT) → WebSocket message
                    │
                    ▼
5. Server receives 'prompt' message with voicePrompt
   - Adds customer message to transcript
   - Sends to OpenAI with message history
                    │
                    ▼
6. OpenAI returns response
   - Server adds agent response to transcript
   - Sends 'text' message back via WebSocket
                    │
                    ▼
7. ConversationRelay (TTS) → Customer hears response
```

### Escalation Flow

```
1. AI response contains "ESCALATE: [reason]"
                    │
                    ▼
2. Server sends friendly message to customer
   Then sends 'end' message with handoffData
                    │
                    ▼
3. ConversationRelay triggers /voice/handoff action
                    │
                    ▼
4. /voice/handoff creates TaskRouter task with:
   - Conversation transcript
   - Escalation reason
   - Customer phone number
   - Call metadata
                    │
                    ▼
5. TaskRouter queues task → Routes to available Flex agent
                    │
                    ▼
6. Agent accepts call in Flex
   - Customer transferred to agent
   - Transcript visible in Salesforce Service Console
```

## API Reference

### HTTP Endpoints

| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/` | GET | Health check | `{ status: 'ok' }` |
| `/voice/incoming` | POST | Incoming call webhook | TwiML |
| `/voice/handoff` | POST | Escalation handler | TwiML (enqueue) |
| `/monitor` | GET | Active conversations | JSON array |
| `/api/transcript/:id` | GET | Get transcript | JSON transcript |

### WebSocket Protocol

**Connection:** `wss://server/conversation/{callSid}`

**Incoming Messages (from ConversationRelay):**

```javascript
// Connection established
{ "type": "setup", "callSid": "CA...", "streamSid": "MZ..." }

// Customer speech transcribed
{ "type": "prompt", "voicePrompt": "customer speech text" }

// Customer interrupted agent
{ "type": "interrupt" }

// Call ended
{ "type": "end" }
```

**Outgoing Messages (to ConversationRelay):**

```javascript
// Speak text to customer
{ "type": "text", "token": "response text" }

// End call (optional handoff)
{ "type": "end", "handoffData": "..." }
```

## Security Considerations

### Current Implementation

- Environment variables for credentials
- .gitignore excludes sensitive files
- In-memory storage (no persistence)

### Production Requirements

- [ ] HTTPS/WSS for all connections
- [ ] Twilio request signature validation
- [ ] Rate limiting on API endpoints
- [ ] Input sanitization
- [ ] Persistent encrypted storage
- [ ] Audit logging
- [ ] CORS configuration

## Scalability

### Current Limitations

- Single server instance
- In-memory storage (lost on restart)
- No horizontal scaling

### Production Scaling Path

1. **Storage:** Replace in-memory Map with Redis
2. **Scaling:** Deploy multiple server instances
3. **Load Balancing:** Use sticky sessions for WebSocket connections
4. **Monitoring:** Add APM (Application Performance Monitoring)

## Technology Stack Summary

| Layer | Technology | Version |
|-------|------------|---------|
| Runtime | Node.js | 18+ |
| HTTP Framework | Express.js | 4.18.2 |
| WebSocket | ws | 8.14.2 |
| Twilio SDK | twilio | 4.19.0 |
| AI | OpenAI | 4.20.0 |
| Config | dotenv | 16.3.1 |
| Dev | nodemon | 3.0.1 |
